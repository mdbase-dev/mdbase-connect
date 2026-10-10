//! Account-level cutover: staged
//! cohorts we control, no opt-in, pausable. A batch flip migrates an account's
//! hosted collections server-side, then switches its backend; old agents then see
//! "update required". **Pausing stops new flips and never disturbs an account
//! mid-cutover**: once any of its collections is fenced, the rest proceed.

use super::Step;

/// Where one of the account's hosted collections is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollectionStatus {
    /// No driver has run.
    NotStarted,
    /// A driver is running at this step.
    InProgress(Step),
}

/// What the rollout knows about one account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    /// In a released cohort.
    pub in_cohort: bool,
    /// The global pause flag.
    pub paused: bool,
    /// The account backend already flipped.
    pub flipped: bool,
    /// Every hosted collection of the account.
    pub collections: Vec<CollectionStatus>,
    /// At most this many collection drivers run at once for one account.
    pub concurrency: usize,
}

/// The rollout's next move for an account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountAction {
    /// Nothing to do now (not released, paused before starting, or drivers busy).
    Wait,
    /// Start the driver of this collection (index into `collections`).
    Start(usize),
    /// Every hosted collection is routed: switch the account backend (idempotent).
    Flip,
    /// Done.
    Done,
    /// A collection stopped (rolled back or failed): the account stays legacy for
    /// an operator. Never flips.
    Blocked,
}

fn mid_cutover(view: &AccountView) -> bool {
    view.collections.iter().any(|c| match c {
        CollectionStatus::InProgress(s) => *s >= Step::Fenced && !s.is_terminal(),
        CollectionStatus::NotStarted => false,
    }) || view
        .collections
        .contains(&CollectionStatus::InProgress(Step::Routed))
}

/// One collection's recorded cutover, as the control plane stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CutoverRecord {
    /// The collection ID (canonical lowercase UUID).
    pub collection: String,
    /// Barrier F.
    pub barrier_f: u64,
    /// The live digest at F.
    pub final_digest: mdbn_wire::common::B32,
}

/// The account flip's evidence digest, exactly as the control plane recomputes it
/// (Connect #652 `flipEvidenceDigest`): lowercase hex SHA-256 over the sorted lines
/// `collection:barrier_f:final_digest_hex\n`.
pub fn flip_evidence(records: &[CutoverRecord]) -> String {
    let mut lines: Vec<String> = records
        .iter()
        .map(|r| {
            format!(
                "{}:{}:{}\n",
                r.collection.to_ascii_lowercase(),
                r.barrier_f,
                r.final_digest.to_hex()
            )
        })
        .collect();
    lines.sort();
    mdbn_wire::hash::sha256(lines.concat().as_bytes()).to_hex()
}

/// Whether a collection of this account may fence its legacy collection now (the
/// driver's pause gate, [`super::Action::MayFence`]): not paused, or the account
/// is already mid-cutover.
pub fn may_fence(view: &AccountView) -> bool {
    view.in_cohort && (!view.paused || mid_cutover(view))
}

/// The next rollout move for `view`.
pub fn next_account_action(view: &AccountView) -> AccountAction {
    if view.flipped {
        return AccountAction::Done;
    }
    if view.collections.iter().any(|c| {
        matches!(
            c,
            CollectionStatus::InProgress(Step::RolledBack | Step::Failed | Step::Gone)
        )
    }) {
        return AccountAction::Blocked;
    }
    if view
        .collections
        .iter()
        .all(|c| *c == CollectionStatus::InProgress(Step::Routed))
    {
        return if view.in_cohort {
            AccountAction::Flip
        } else {
            AccountAction::Wait
        };
    }
    if !view.in_cohort || (view.paused && !mid_cutover(view)) {
        return AccountAction::Wait;
    }
    let running = view
        .collections
        .iter()
        .filter(|c| matches!(c, CollectionStatus::InProgress(s) if !s.is_terminal()))
        .count();
    if running >= view.concurrency.max(1) {
        return AccountAction::Wait;
    }
    view.collections
        .iter()
        .position(|c| *c == CollectionStatus::NotStarted)
        .map_or(AccountAction::Wait, AccountAction::Start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use CollectionStatus::*;

    fn view(paused: bool, collections: Vec<CollectionStatus>) -> AccountView {
        AccountView {
            in_cohort: true,
            paused,
            flipped: false,
            collections,
            concurrency: 1,
        }
    }

    #[test]
    fn cohort_pause_and_flip() {
        let mut v = view(false, vec![NotStarted, NotStarted]);
        v.in_cohort = false;
        assert_eq!(next_account_action(&v), AccountAction::Wait);
        assert!(!may_fence(&v));
        assert_eq!(
            next_account_action(&view(false, vec![NotStarted, NotStarted])),
            AccountAction::Start(0)
        );
        // Paused before anything fenced: nothing starts, nothing fences.
        let v = view(true, vec![InProgress(Step::Shadowed), NotStarted]);
        assert_eq!(next_account_action(&v), AccountAction::Wait);
        assert!(!may_fence(&v));
        // Paused mid-cutover: the account keeps going, fence included.
        let v = view(
            true,
            vec![
                InProgress(Step::Routed),
                NotStarted,
                InProgress(Step::Shadowed),
            ],
        );
        assert!(may_fence(&v));
        assert_eq!(
            next_account_action(&v),
            AccountAction::Wait,
            "concurrency 1"
        );
        let v = view(true, vec![InProgress(Step::Routed), NotStarted]);
        assert_eq!(next_account_action(&v), AccountAction::Start(1));
        // Flip only when every hosted collection is routed (an empty account too).
        assert_eq!(
            next_account_action(&view(true, vec![InProgress(Step::Routed)])),
            AccountAction::Flip
        );
        assert_eq!(
            next_account_action(&view(false, vec![])),
            AccountAction::Flip
        );
        let mut done = view(false, vec![]);
        done.flipped = true;
        assert_eq!(next_account_action(&done), AccountAction::Done);
        // A stopped collection blocks the flip.
        assert_eq!(
            next_account_action(&view(
                false,
                vec![InProgress(Step::Routed), InProgress(Step::RolledBack)]
            )),
            AccountAction::Blocked
        );
    }

    #[test]
    fn flip_evidence_matches_the_control_plane_encoding() {
        use mdbn_wire::common::B32;
        // Same lines and order rule as Connect #652's flipEvidenceDigest.
        let r = |c: &str, f: u64, d: u8| CutoverRecord {
            collection: c.into(),
            barrier_f: f,
            final_digest: B32([d; 32]),
        };
        let a = r("0192F0C1-7E1A-7B3C-8D4E-000000000002", 7, 1);
        let b = r("0192f0c1-7e1a-7b3c-8d4e-000000000001", 9, 2);
        let want = {
            let mut lines = [
                format!(
                    "0192f0c1-7e1a-7b3c-8d4e-000000000002:7:{}\n",
                    "01".repeat(32)
                ),
                format!(
                    "0192f0c1-7e1a-7b3c-8d4e-000000000001:9:{}\n",
                    "02".repeat(32)
                ),
            ];
            lines.sort();
            mdbn_wire::hash::sha256(lines.concat().as_bytes()).to_hex()
        };
        assert_eq!(flip_evidence(&[a.clone(), b.clone()]), want);
        assert_eq!(flip_evidence(&[b, a]), want, "order-independent");
        // An account with no hosted collections: SHA-256 of the empty string.
        assert_eq!(
            flip_evidence(&[]),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
