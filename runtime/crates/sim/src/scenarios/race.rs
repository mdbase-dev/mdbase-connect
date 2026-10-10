//! `race-<os>-<strategy>-<mode>[-overload]`: a publisher against editors on the
//! same files, exercising save-loss races in the simulator.
//!
//! One publisher process loops over the files: read the current bytes, append a
//! publisher line, `publish_if_unchanged` with the chosen [`Strategy`], and
//! settle parked inodes after the retention. One [`StressEditor`] per file saves
//! continuously in the chosen [`SaveMode`] (or a mix). The machine hook stalls
//! the publisher between syscalls and runs editor syscalls in between; editors
//! stall between their own syscalls. The oracle: no editor's successful save is
//! ever lost (checked before every save and at the end).
//!
//! `-overload` lengthens and multiplies stalls on both sides, modelling an
//! overloaded host with multi-second publish calls.

use std::any::Any;

use crate::editors::{EditorTiming, SaveMode, StressEditor};
use crate::obsidian::ObsidianEditor;
use crate::oracle::Kind;
use crate::platform::{FsError, MacOs, Os, Proc};
use crate::publish::{Env, Outcome, Strategy};
use crate::world::{Actor, Ev, HookCfg, World};

/// Scenario parameters.
#[derive(Debug, Clone)]
pub struct Race {
    /// OS model.
    pub os: Os,
    /// Publisher protocol.
    pub strategy: Strategy,
    /// Editor modes, one per file (cycled).
    pub modes: Vec<SaveMode>,
    /// Files.
    pub files: usize,
    /// Simulated duration, ms.
    pub duration_ms: u64,
    /// Stash retention, ms.
    pub settle_ms: u64,
    /// Overloaded host.
    pub overload: bool,
    /// Obsidian editors instead of stress editors.
    pub obsidian: bool,
    /// Publish to open notes through the editor fence.
    pub fence: bool,
}

impl Race {
    /// Parse `race-<os>-<strategy>-<mode>[-overload]`.
    pub fn parse(name: &str) -> Option<Race> {
        let rest = name.strip_prefix("race-")?;
        let (rest, overload) = match rest.strip_suffix("-overload") {
            Some(r) => (r, true),
            None => (rest, false),
        };
        let (rest, fence) = match rest.strip_suffix("-fence") {
            Some(r) => (r, true),
            None => (rest, false),
        };
        let mut it = rest.splitn(3, '-');
        let os = match it.next()? {
            "linux" => Os::Linux,
            "macos" => Os::MacOs(MacOs::apfs()),
            "fat32" => Os::MacOs(MacOs {
                p_swap_window: 0,
                fat32: true,
                p_hidden_holder: 0,
            }),
            // macOS where proc_listpidspath cannot see the holder (sandboxed
            // or other-user editors): the open-handle check is blind.
            "macoshidden" => Os::MacOs(MacOs {
                p_hidden_holder: 1_000_000,
                ..MacOs::apfs()
            }),
            "windows" => Os::Windows,
            _ => return None,
        };
        let strategy = Strategy::parse(it.next()?)?;
        let mode = it.next()?;
        let obsidian = mode == "obsidian";
        if fence && !obsidian {
            return None;
        }
        let modes = if mode == "mixed" {
            SaveMode::ALL.to_vec()
        } else if obsidian {
            vec![SaveMode::LibuvTrunc]
        } else {
            vec![SaveMode::parse(mode)?]
        };
        let exchange = matches!(
            strategy,
            Strategy::X | Strategy::P | Strategy::PS | Strategy::PSE | Strategy::PSL
        );
        // F_SETLEASE is Linux-only.
        if strategy == Strategy::PSL && os != Os::Linux {
            return None;
        }
        if (os == Os::Windows && exchange) || (os != Os::Windows && strategy == Strategy::D) {
            return None;
        }
        Some(Race {
            os,
            strategy,
            files: if modes.len() > 1 { modes.len() } else { 3 },
            modes,
            duration_ms: 6_000,
            settle_ms: 2_000,
            overload,
            obsidian,
            fence,
        })
    }
}

/// The publisher.
pub struct Publisher {
    machine: usize,
    me: u32,
    proc: Option<Proc>,
    env: Env,
    strategy: Strategy,
    files: Vec<String>,
    next_file: usize,
    tokens: u64,
    attempts: u64,
    stopped: bool,
    /// Obsidian scenarios: the editor (local process index) per file, and
    /// whether to publish through the fence.
    obsidian: Vec<usize>,
    fence: bool,
}

const TICK: u64 = 1;

impl Publisher {
    fn attempt(&mut self, w: &mut World) -> Result<(), FsError> {
        let Some(p) = self.proc.clone() else {
            return Ok(());
        };
        let path = self.files[self.next_file].clone();
        self.next_file = (self.next_file + 1) % self.files.len();
        let cur = match p.read(&path) {
            Ok(b) => b,
            Err(FsError::NotFound | FsError::SharingViolation) => {
                w.shared.count("race.read_fail", 1);
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        self.tokens += 1;
        let file = (self.next_file + self.files.len() - 1) % self.files.len();
        let line = if self.obsidian.is_empty() {
            format!("p{}\n", self.tokens)
        } else {
            // Obsidian scenarios track publisher lines as acknowledged writes.
            let tok = w.shared.tokens.borrow_mut().fresh("publisher");
            format!("p{} {tok}\n", self.tokens)
        };
        let mut new = cur.clone();
        new.extend_from_slice(line.as_bytes());
        self.attempts += 1;
        if self.fence && !self.obsidian.is_empty() {
            let mut applied = false;
            w.with_local(self.machine, self.obsidian[file], |e, cx| {
                if let Some(e) = e.as_any_mut().downcast_mut::<ObsidianEditor>() {
                    applied = e.fence_apply(cx, line.as_bytes());
                }
            });
            if applied {
                w.shared.count("race.fenced", 1);
                return Ok(());
            }
        }
        let o = self.env.publish(&p, self.strategy, &path, &cur, &new);
        if !self.obsidian.is_empty() && !matches!(o, Outcome::Published) {
            for t in crate::oracle::tokens_in(line.as_bytes()) {
                w.shared.tokens.borrow_mut().unwrite(&t);
            }
        }
        w.shared.detail(
            "publisher",
            &format!(
                "publish {path} p{} base_len={} -> {o:?}",
                self.tokens,
                cur.len()
            ),
        );
        w.shared.count(&format!("race.{}", o.key()), 1);
        if let Outcome::Error(e) = o {
            return Err(e);
        }
        if self.attempts.is_multiple_of(16) {
            self.env.settle(&p, false)?;
        }
        Ok(())
    }
}

impl Actor for Publisher {
    fn name(&self) -> &str {
        "publisher"
    }
    fn machine(&self) -> Option<usize> {
        Some(self.machine)
    }
    fn handle(&mut self, w: &mut World, ev: Ev) {
        match ev {
            Ev::Start => {
                let p = Proc::new(&w.machines[self.machine], "publisher", true);
                if self.env.init(&p).is_err() {
                    return;
                }
                self.proc = Some(p);
                w.timer(self.me, 1, TICK);
            }
            Ev::Timer(TICK) if !self.stopped => {
                if let Err(e) = self.attempt(w) {
                    w.shared
                        .violate(Kind::Bug, format!("publisher syscall failed: {e}"));
                    self.stopped = true;
                    return;
                }
                // Obsidian scenarios: a publish per note every
                // ~250 ms; stress editors: a tight loop.
                let d = if self.obsidian.is_empty() {
                    w.rng.between(1, 3)
                } else {
                    w.rng.between(50, 150)
                };
                w.timer(self.me, d, TICK);
            }
            _ => {}
        }
    }
    fn quiesce(&mut self, _w: &mut World) {
        self.stopped = true;
        if let Some(p) = &self.proc {
            let _ = self.env.settle(p, true);
        }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Run.
pub fn run(w: &mut World, r: &Race) -> String {
    // Overload model: high load with publish calls up to 4.9 s.
    let (p_stall, stall_max, ed_timing) = if r.overload {
        (
            30_000,
            5_000,
            EditorTiming {
                p_stall: 30_000,
                stall_max_ms: 5_000,
                ..EditorTiming::default()
            },
        )
    } else {
        (10_000, 200, EditorTiming::default())
    };
    let m = w.add_machine(
        "m0",
        r.os,
        HookCfg {
            p_interleave: 80_000,
            p_stall,
            stall_max_ms: stall_max,
            p_crash: 0,
        },
    );
    let mut files = Vec::new();
    {
        let p = Proc::new(&w.machines[m], "setup", false);
        for i in 0..r.files {
            let path = format!("notes/f{i}.md");
            p.mkdir_all("notes").expect("setup");
            p.create_new(&path, format!("# e{i} g0\n").as_bytes(), true)
                .expect("setup");
            files.push(path);
        }
        w.machines[m].borrow_mut().disk.settle();
    }
    let mut eds = Vec::new();
    let mut obs = Vec::new();
    for (i, path) in files.iter().enumerate() {
        if r.obsidian {
            obs.push(w.add_local(
                m,
                Box::new(ObsidianEditor::new(&format!("obsidian{i}"), path)),
            ));
            continue;
        }
        let mode = r.modes[i % r.modes.len()];
        let mut e = StressEditor::new(&format!("ed{i}"), i, path, mode, ed_timing);
        // Continue the seeded header so the first save extends it.
        e.last_good = None;
        eds.push(w.add_local(m, Box::new(e)));
    }
    let me = w.actor_count() as u32;
    w.spawn(Box::new(Publisher {
        machine: m,
        me,
        proc: None,
        env: Env {
            settle_ms: r.settle_ms,
            lease_check: r.strategy == Strategy::PSL,
            ..Env::default()
        },
        strategy: r.strategy,
        files,
        next_file: 0,
        tokens: 0,
        attempts: 0,
        stopped: false,
        obsidian: obs.clone(),
        fence: r.fence,
    }));
    w.run_chaos(r.duration_ms);
    if !w.quiesce(50, 2, 20_000) {
        w.shared.violate(Kind::NoQuiesce, "did not settle".into());
    }
    // Final oracle: every editor's last good save is somewhere.
    let p = Proc::new(&w.machines[m], "oracle", false);
    let mut saves = 0;
    for i in eds {
        let Some(e) = w.local::<StressEditor>(m, i) else {
            continue;
        };
        saves += e.saves_ok;
        let (name, mode, want, ok, failed, destroyed) = (
            e.name.clone(),
            e.mode,
            e.last_good.clone(),
            e.saves_ok,
            e.saves_failed,
            e.self_destroyed,
        );
        let state = e.path_state(&p);
        drop(e);
        w.shared.count("race.saves_ok", ok);
        w.shared.count("race.saves_failed", failed);
        w.shared.count("race.self_destroyed", destroyed);
        if let Some(want) = want
            && StressEditor::find(&p, &want).is_none()
        {
            w.shared.violate(
                Kind::LostEdit,
                format!(
                    "{name} ({}) final: last good save ({} bytes) is nowhere; path {state}",
                    mode.name(),
                    want.len()
                ),
            );
        }
    }
    if r.obsidian {
        // Every typed keystroke and every acknowledged publish is somewhere.
        let present: std::collections::BTreeSet<String> = {
            let mm = w.machines[m].borrow();
            mm.disk
                .names
                .values()
                .flat_map(|i| crate::oracle::tokens_in(&mm.disk.inodes[i].data))
                .collect()
        };
        let lost = w.shared.tokens.borrow().lost(&present);
        for t in lost {
            let who = w.shared.tokens.borrow().written[&t].clone();
            let what = if who == "publisher" {
                "acknowledged publish reverted by an Obsidian save"
            } else {
                "typed text lost"
            };
            w.shared
                .violate(Kind::LostEdit, format!("{t} ({who}): {what}"));
        }
        for i in &obs {
            if let Some(e) = w.local::<ObsidianEditor>(m, *i) {
                let (s, ig, re, fe) = (e.saves, e.ignored, e.reloads, e.fenced);
                drop(e);
                w.shared.count("obsidian.saves", s);
                w.shared.count("obsidian.ignored_while_saving", ig);
                w.shared.count("obsidian.reloads", re);
                w.shared.count("obsidian.fenced", fe);
            }
        }
    }
    if let Some(pb) = w.actor::<Publisher>(me) {
        let c = pb.env.counters.clone();
        for (k, v) in c {
            w.shared.count(&format!("race.{k}"), v);
        }
    }
    format!("saves={saves}")
}

#[cfg(test)]
mod tests {
    use crate::scenario::{Opts, run_seed};

    fn losses(name: &str, seeds: u64) -> u64 {
        (1..=seeds)
            .filter(|s| !run_seed(name, *s, &Opts::default()).unwrap().clean())
            .count() as u64
    }

    #[test]
    fn linux_residual_reproduces() {
        // Save-loss race: empty base + editor stall > retention.
        assert!(losses("race-linux-X-libuv_trunc-overload", 1000) > 0);
        // Amendment 3 alone leaves the open-now-write-later class.
        assert!(losses("race-linux-PSE-mixed-overload", 400) > 0);
    }

    #[test]
    fn lease_checked_settle_closes_the_residual() {
        assert_eq!(losses("race-linux-PSL-mixed-overload", 300), 0);
    }

    #[test]
    fn obsidian_reverts_publishes_without_the_fence() {
        assert!(losses("race-linux-R-obsidian", 100) > 0);
        assert_eq!(losses("race-linux-R-obsidian-fence", 50), 0);
    }

    #[test]
    fn naive_rename_loses_saves() {
        assert!(losses("race-linux-N-libuv_trunc", 20) > 0);
    }

    #[test]
    fn protocol_d_is_clean_on_windows() {
        assert_eq!(losses("race-windows-D-mixed", 20), 0);
    }

    #[test]
    fn fat32_swap_lies() {
        assert!(losses("race-fat32-PS-libuv_trunc", 30) > 0);
    }
}
