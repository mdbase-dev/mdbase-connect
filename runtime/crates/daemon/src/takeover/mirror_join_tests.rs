//! Joining a captured mirror's collection: folder choice, refusals and backoff,
//! crashes before, during and after the join, and a later removal.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::takeover::adapter::CRASH_AT;
use crate::takeover::mirror_import::tests::hosted_mirror::{self, HOSTED};

struct Setup {
    _dir: crate::testutil::TestDir,
    root: PathBuf,
    legacy: PathBuf,
}

fn setup(tag: &str) -> Setup {
    let dir = crate::testutil::TestDir::new(tag);
    let root = dir.path().to_path_buf();
    let old = root.join("connect");
    let entry = hosted_mirror::build(&old, &root.join("Hosted notes"));
    let legacy = root.join("state/legacy");
    mirror_import::capture(&legacy, &old, &entry, "2026-10-18T00:00:00Z").unwrap();
    Setup {
        _dir: dir,
        root,
        legacy,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Crash {
    /// Connect enrols the device, then the process dies before registration.
    AfterEnrol,
    /// Registration completes, then the answer is lost.
    AfterRegister,
}

#[derive(Default)]
struct Fake {
    registered: Option<PathBuf>,
    /// Refuse the next joins with these reasons, in order.
    refuse: Vec<&'static str>,
    crash: Option<Crash>,
    joins: Vec<(PathBuf, String)>,
    enrolments: usize,
}

impl Joiner for Fake {
    async fn registered(&mut self, _: &str) -> Option<PathBuf> {
        self.registered.clone()
    }
    async fn join(&mut self, collection: &str, folder: &Path, name: &str) -> Result<(), Refused> {
        assert_eq!(collection, HOSTED);
        if !self.refuse.is_empty() {
            return Err(Refused(self.refuse.remove(0).into()));
        }
        if self.registered.is_some() {
            return Err(Refused("already_registered".into()));
        }
        assert!(
            fs::read_dir(folder).unwrap().next().is_none(),
            "joins only into an empty folder"
        );
        self.enrolments += 1;
        match self.crash.take() {
            Some(Crash::AfterEnrol) => panic!("injected crash after enrolment"),
            Some(Crash::AfterRegister) => {
                self.registered = Some(folder.to_path_buf());
                panic!("injected crash after registration")
            }
            None => {}
        }
        self.joins.push((folder.to_path_buf(), name.to_owned()));
        self.registered = Some(folder.to_path_buf());
        Ok(())
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(f)
}

fn run(s: &Setup, f: &mut Fake, now: u64) -> Step {
    block_on(step(&s.legacy, HOSTED, f, now)).unwrap()
}

fn crashes(s: &Setup, f: &mut Fake, now: u64) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(s, f, now)));
    assert!(r.is_err(), "expected a crash");
}

#[test]
fn joins_next_to_the_old_folder_and_never_touches_it() {
    let s = setup("mj-join");
    let old = s.root.join("Hosted notes");
    let before: Vec<_> = fs::read_dir(&old)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();
    let mut f = Fake::default();
    let want = s.root.join("Hosted notes (synced)");
    assert_eq!(run(&s, &mut f, 1), Step::Registered(want.clone()));
    assert_eq!(f.joins, [(want.clone(), "Hosted notes".to_string())]);
    let st = JoinState::load(&s.legacy, HOSTED).unwrap();
    assert_eq!(st.phase, Phase::Joined);
    assert_eq!(st.folder.as_deref(), Some(want.as_path()));
    let after: Vec<_> = fs::read_dir(&old)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();
    assert_eq!(before, after);
    // Registered: nothing more to do.
    assert_eq!(run(&s, &mut f, 2), Step::Registered(want));
    assert_eq!(f.enrolments, 1);
}

#[test]
fn the_folder_is_the_old_path_when_gone_or_the_next_free_name() {
    let s = setup("mj-folder");
    let c = Capture::load(&s.legacy, HOSTED).unwrap().unwrap();
    fs::create_dir_all(s.root.join("Hosted notes (synced)")).unwrap();
    fs::write(s.root.join("Hosted notes (synced)/x.md"), "x").unwrap();
    fs::write(s.root.join("Hosted notes (synced 2)"), "a file").unwrap();
    assert_eq!(
        choose_folder(&c).unwrap(),
        s.root.join("Hosted notes (synced 3)")
    );
    fs::remove_dir_all(s.root.join("Hosted notes")).unwrap();
    assert_eq!(choose_folder(&c).unwrap(), s.root.join("Hosted notes"));
    fs::create_dir_all(s.root.join("Hosted notes")).unwrap();
    assert_eq!(choose_folder(&c).unwrap(), s.root.join("Hosted notes"));
}

#[test]
fn a_refused_join_waits_with_its_reason_and_backs_off() {
    let s = setup("mj-refused");
    let mut f = Fake {
        refuse: vec!["sync_refused", "not_signed_in"],
        ..Fake::default()
    };
    let first = run(&s, &mut f, 1_000);
    assert_eq!(
        first,
        Step::Waiting {
            reason: "sync_refused".into(),
            next_attempt_ms: 1_000 + FIRST_BACKOFF_MS
        }
    );
    // Not due yet: no attempt.
    assert_eq!(run(&s, &mut f, 2_000), first);
    assert_eq!(f.refuse.len(), 1);
    let second = run(&s, &mut f, 1_000 + FIRST_BACKOFF_MS);
    assert_eq!(
        second,
        Step::Waiting {
            reason: "not_signed_in".into(),
            next_attempt_ms: 1_000 + 3 * FIRST_BACKOFF_MS
        }
    );
    let st = status(&s.legacy, HOSTED).unwrap();
    assert_eq!(st["state"], "waiting");
    assert_eq!(st["reason"], "not_signed_in");
    assert_eq!(st["attempts"], 2);
    // The capture is untouched while waiting.
    assert_eq!(
        Capture::load(&s.legacy, HOSTED)
            .unwrap()
            .unwrap()
            .edits
            .len(),
        6
    );
    // Then it joins, into the same folder it chose first.
    let want = s.root.join("Hosted notes (synced)");
    assert_eq!(run(&s, &mut f, 10_000_000), Step::Registered(want));
    assert_eq!(
        status(&s.legacy, HOSTED).unwrap()["reason"],
        serde_json::Value::Null
    );
}

#[test]
fn backoff_is_capped() {
    let mut st = JoinState::new();
    for _ in 0..40 {
        st.failed("x", 0);
    }
    assert_eq!(st.next_attempt_ms(), MAX_BACKOFF_MS);
}

#[test]
fn a_crash_after_choosing_the_folder_reuses_it() {
    let s = setup("mj-crash-folder");
    let mut f = Fake::default();
    CRASH_AT.with(|c| c.set(Some("mirror_join_folder")));
    crashes(&s, &mut f, 1);
    CRASH_AT.with(|c| c.set(None));
    let chosen = JoinState::load(&s.legacy, HOSTED).unwrap().folder.unwrap();
    assert_eq!(chosen, s.root.join("Hosted notes (synced)"));
    assert!(!chosen.exists(), "saved before it was created");
    assert_eq!(f.enrolments, 0);
    assert_eq!(run(&s, &mut f, 2), Step::Registered(chosen));
    assert_eq!(f.enrolments, 1);
}

#[test]
fn a_crash_mid_join_retries_the_same_join_once() {
    for crash in [Crash::AfterEnrol, Crash::AfterRegister] {
        let s = setup("mj-crash-join");
        let mut f = Fake {
            crash: Some(crash),
            ..Fake::default()
        };
        crashes(&s, &mut f, 1);
        let want = s.root.join("Hosted notes (synced)");
        // Still pending on disk, with the chosen folder.
        let st = JoinState::load(&s.legacy, HOSTED).unwrap();
        assert_eq!(st.phase, Phase::Pending);
        assert_eq!(st.folder.as_deref(), Some(want.as_path()));
        assert_eq!(
            run(&s, &mut f, 2),
            Step::Registered(want.clone()),
            "{crash:?}"
        );
        assert_eq!(
            JoinState::load(&s.legacy, HOSTED).unwrap().phase,
            Phase::Joined
        );
        // After a lost registration answer, it is recognised, not joined again.
        let want_enrolments = if crash == Crash::AfterRegister { 1 } else { 2 };
        assert_eq!(f.enrolments, want_enrolments, "{crash:?}");
    }
}

#[test]
fn a_crash_after_registration_before_saving_is_recognised() {
    let s = setup("mj-crash-saved");
    let mut f = Fake::default();
    CRASH_AT.with(|c| c.set(Some("mirror_join_registered")));
    crashes(&s, &mut f, 1);
    CRASH_AT.with(|c| c.set(None));
    assert_eq!(
        JoinState::load(&s.legacy, HOSTED).unwrap().phase,
        Phase::Pending
    );
    let want = s.root.join("Hosted notes (synced)");
    assert_eq!(run(&s, &mut f, 2), Step::Registered(want));
    assert_eq!(f.enrolments, 1);
}

#[test]
fn a_folder_that_fills_up_is_replaced() {
    let s = setup("mj-filled");
    let mut f = Fake {
        refuse: vec!["folder_not_empty"],
        ..Fake::default()
    };
    let first = run(&s, &mut f, 1);
    assert!(matches!(first, Step::Waiting { ref reason, .. } if reason == "folder_not_empty"));
    fs::write(s.root.join("Hosted notes (synced)/mine.md"), "mine").unwrap();
    let want = s.root.join("Hosted notes (synced 2)");
    assert_eq!(run(&s, &mut f, 1_000_000), Step::Registered(want));
    assert_eq!(
        fs::read_to_string(s.root.join("Hosted notes (synced)/mine.md")).unwrap(),
        "mine"
    );
}

#[test]
fn a_collection_already_here_is_adopted_and_a_removed_one_left_alone() {
    let s = setup("mj-existing");
    let elsewhere = s.root.join("joined by hand");
    let mut f = Fake {
        registered: Some(elsewhere.clone()),
        ..Fake::default()
    };
    assert_eq!(run(&s, &mut f, 1), Step::Registered(elsewhere));
    assert_eq!(f.enrolments, 0);
    // The user removes it: never joined again.
    f.registered = None;
    assert_eq!(run(&s, &mut f, 2), Step::Removed);
    assert_eq!(run(&s, &mut f, 10_000_000), Step::Removed);
    assert_eq!(f.enrolments, 0);
    assert_eq!(status(&s.legacy, HOSTED).unwrap()["state"], "joined");
}

#[test]
fn the_cutover_check_is_recorded_once() {
    let s = setup("mj-cutover");
    let next = cut_over_pending(&s.legacy, HOSTED, "not_cut_over", 1_000).unwrap();
    assert_eq!(next, 1_000 + FIRST_BACKOFF_MS);
    assert_eq!(status(&s.legacy, HOSTED).unwrap()["reason"], "not_cut_over");
    confirm_cut_over(&s.legacy, HOSTED).unwrap();
    let st = JoinState::load(&s.legacy, HOSTED).unwrap();
    assert!(st.cut_over);
    assert_eq!(st.last_error, None);
}
