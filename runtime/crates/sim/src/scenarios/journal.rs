//! `journal`: the framework's self-test.
//!
//! One writer on a Linux machine creates record files with the textbook durable
//! protocol (temp + fsync, no-replace rename, fsync of the directory) and only then
//! acknowledges each one. Chaos crashes the writer at syscall boundaries, stalls
//! it, and cuts power. The oracle: every acknowledged file exists with its bytes.
//!
//! The `journal-unsafe` variant skips the directory fsync. Its acknowledged files
//! must be lost under power loss in some seeds; a test asserts that, which shows
//! the disk model and the lost-ack oracle can catch a real durability bug.

use std::any::Any;

use crate::oracle::{Ack, Kind, tokens_in};
use crate::platform::{FsError, Os, Proc};
use crate::world::{Actor, Chaos, Ev, HookCfg, World};

const TICK: u64 = 1;

/// The writer actor.
pub struct Writer {
    name: String,
    machine: usize,
    proc: Option<Proc>,
    /// Sync the directory before acknowledging.
    safe: bool,
    next: u64,
    epoch: u64,
}

impl Writer {
    fn open(&mut self, w: &mut World) {
        self.epoch += 1;
        let p = Proc::new(
            &w.machines[self.machine],
            &format!("{}#{}", self.name, self.epoch),
            true,
        );
        // Recovery: temps are ours and never acknowledged; drop them. The next
        // record number continues after the highest record on disk.
        if let Ok(tmps) = p.list(".tmp") {
            for (n, _) in tmps {
                let _ = p.unlink(&format!(".tmp/{n}"));
            }
        }
        let mut max = 0;
        if let Ok(recs) = p.list("recs") {
            for (n, _) in recs {
                if let Some(k) = n
                    .strip_prefix('r')
                    .and_then(|x| x.strip_suffix(".md"))
                    .and_then(|x| x.parse::<u64>().ok())
                {
                    max = max.max(k);
                }
            }
        }
        if p.crashed.get() {
            return;
        }
        self.next = max + 1;
        self.proc = Some(p);
    }

    fn write_one(&mut self, w: &mut World) -> Result<(), FsError> {
        let Some(p) = self.proc.clone() else {
            return Ok(());
        };
        let n = self.next;
        let tok = w.shared.tokens.borrow_mut().fresh(&self.name);
        let body = format!("record {n}\n- {tok}\n");
        let tmp = format!(".tmp/t{n}");
        let path = format!("recs/r{n}.md");
        p.mkdir_all(".tmp")?;
        p.mkdir_all("recs")?;
        p.create_new(&tmp, body.as_bytes(), true)?;
        match p.rename(&tmp, &path, false) {
            Ok(()) => {}
            Err(FsError::Exists) => {
                // A record survived that recovery didn't count (cannot happen with
                // a monotonically recovered counter, but stay safe): skip ahead.
                let _ = p.unlink(&tmp);
                self.next += 1;
                w.shared.tokens.borrow_mut().unwrite(&tok);
                return Ok(());
            }
            Err(e) => return Err(e),
        }
        if self.safe {
            p.fsync_dir("recs")?;
        }
        self.next += 1;
        w.log(&self.name, &format!("ack r{n} {tok}"));
        w.shared.acks.borrow_mut().ack(Ack {
            mutation: format!("r{n}"),
            seq: n,
            tokens: vec![tok],
            client: self.name.clone(),
            at: w.time.elapsed(),
        });
        Ok(())
    }
}

impl Actor for Writer {
    fn name(&self) -> &str {
        &self.name
    }
    fn machine(&self) -> Option<usize> {
        Some(self.machine)
    }
    fn handle(&mut self, w: &mut World, ev: Ev) {
        let me = w.actors_of::<Writer>().first().copied().unwrap_or(0);
        match ev {
            Ev::Start | Ev::Restart => {
                self.open(w);
                if self.proc.is_none() {
                    // Crashed during recovery.
                    w.crashed_in_call(me);
                    return;
                }
                w.timer(me, 5, TICK);
            }
            Ev::Timer(TICK) => {
                if self.proc.is_none() {
                    return;
                }
                if w.shared.chaos.get() {
                    let r = self.write_one(w);
                    if r == Err(FsError::Crashed) {
                        self.proc = None;
                        w.log(&self.name, "crashed in a syscall");
                        w.crashed_in_call(me);
                        return;
                    }
                }
                let d = w.rng.between(5, 60);
                w.timer(me, d, TICK);
            }
            Ev::Crash | Ev::PowerLoss => {
                if let Some(p) = self.proc.take() {
                    p.crash();
                }
            }
            _ => {}
        }
    }
    fn settled(&self, _w: &World) -> bool {
        self.proc.is_some()
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Run the scenario.
pub fn run(w: &mut World, safe: bool) -> String {
    let m = w.add_machine(
        "m0",
        Os::Linux,
        HookCfg {
            p_interleave: 0,
            p_stall: 20_000,
            stall_max_ms: 1_000,
            p_crash: 5_000,
        },
    );
    w.chaos = Chaos {
        crash_every_ms: 1_500,
        p_power: 600_000,
        p_torn: 300_000,
        p_new: 300_000,
        restart_ms: (50, 500),
        partition_every_ms: 0,
        partition_ms: (0, 0),
    };
    let id = w.spawn(Box::new(Writer {
        name: "writer".into(),
        machine: m,
        proc: None,
        safe,
        next: 1,
        epoch: 0,
    }));
    w.crashable.push(id);
    w.run_chaos(20_000);
    if !w.quiesce(100, 3, 10_000) {
        w.shared
            .violate(Kind::NoQuiesce, "writer did not restart".into());
    }
    // Oracle: every acknowledged record is on disk with its token.
    let mach = w.machines[m].clone();
    let mm = mach.borrow();
    let acks = w.shared.acks.borrow().clone();
    for v in acks.check(|seq| {
        let path = format!("recs/r{seq}.md");
        match mm.disk.read(&path) {
            Some(b) => {
                let toks = tokens_in(b);
                acks.acks
                    .values()
                    .filter(|a| a.seq == seq && a.tokens.iter().all(|t| toks.contains(t)))
                    .map(|a| a.mutation.clone())
                    .collect()
            }
            None => Vec::new(),
        }
    }) {
        w.shared.violate(v.kind, v.detail);
    }
    w.shared.count("journal.acked", acks.acks.len() as u64);
    format!("files={}", mm.disk.names.len())
}

#[cfg(test)]
mod tests {
    use crate::scenario::{Opts, run_seed};

    #[test]
    fn safe_protocol_never_loses_an_ack() {
        for seed in 1..=60 {
            let r = run_seed("journal", seed, &Opts::default()).unwrap();
            assert!(r.clean(), "seed {seed}: {:?}", r.violations);
            assert!(r.counters["journal.acked"] > 50, "{:?}", r.counters);
        }
    }

    #[test]
    fn missing_dir_fsync_is_caught() {
        let lost = (1..=60)
            .filter(|s| {
                !run_seed("journal-unsafe", *s, &Opts::default())
                    .unwrap()
                    .clean()
            })
            .count();
        assert!(
            lost > 0,
            "the oracle never caught the missing directory fsync"
        );
    }
}
