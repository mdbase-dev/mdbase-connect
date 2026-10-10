//! Portable scheduling of retained-inode checks; never permission to unlink.
//! Every selected inode still passes `stash::settle`'s holder and revision checks.

/// Maximum default same-launch retention before a checked reclaim (seven days).
pub const MAX_RETENTION_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

/// When a retained inode may be checked for release.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReleasePolicy {
    /// Existing timed policy for lease/lock-checked hosts and the vault.
    #[default]
    AfterRetention,
    /// Keep this launch's inodes unless age or byte pressure requires a check.
    /// The cap is a scheduling threshold, not permission to unlink busy files
    /// or delete changed bytes/evidence, and not a hard disk-space guarantee.
    NextLaunch {
        /// Aggregate retained-inode threshold, including unknown sizes.
        cap_bytes: u64,
        /// Age threshold; never shortens the ordinary minimum retention.
        max_age_ms: u64,
    },
}

pub(crate) struct Parked {
    pub since: u64,
    pub session: u64,
    /// Unknown size is charged maximally, never as zero.
    pub size: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Due {
    pub index: usize,
    /// A same-launch age/cap exception, rather than ordinary next-launch release.
    pub reclaimed: bool,
}

pub(crate) fn due(
    policy: ReleasePolicy,
    retention_ms: u64,
    now: u64,
    session: u64,
    parked: &[Parked],
) -> Vec<Due> {
    let mut order: Vec<usize> = (0..parked.len()).collect();
    // Stable tie-breaking follows the caller's deterministic private-path order.
    order.sort_by_key(|&i| parked[i].since);
    let mut remaining: u128 = parked
        .iter()
        .map(|p| u128::from(p.size.unwrap_or(u64::MAX)))
        .sum();
    let mut selected = Vec::new();
    for index in order {
        let p = &parked[index];
        if now < p.since.saturating_add(retention_ms) {
            continue;
        }
        let reclaimed = match policy {
            ReleasePolicy::AfterRetention => false,
            ReleasePolicy::NextLaunch {
                cap_bytes,
                max_age_ms,
            } => {
                if p.session < session {
                    false
                } else if p.session == session
                    && (now >= p.since.saturating_add(max_age_ms.max(retention_ms))
                        || remaining > u128::from(cap_bytes))
                {
                    true
                } else {
                    continue;
                }
            }
        };
        selected.push(Due { index, reclaimed });
        remaining -= u128::from(p.size.unwrap_or(u64::MAX));
    }
    selected
}

pub(crate) fn deadline(
    policy: ReleasePolicy,
    retention_ms: u64,
    session: u64,
    parked: &Parked,
) -> Option<u64> {
    match policy {
        ReleasePolicy::AfterRetention => Some(parked.since.saturating_add(retention_ms)),
        ReleasePolicy::NextLaunch { max_age_ms, .. } if parked.session == session => {
            Some(parked.since.saturating_add(max_age_ms.max(retention_ms)))
        }
        ReleasePolicy::NextLaunch { .. } if parked.session < session => {
            Some(parked.since.saturating_add(retention_ms))
        }
        ReleasePolicy::NextLaunch { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy(cap_bytes: u64) -> ReleasePolicy {
        ReleasePolicy::NextLaunch {
            cap_bytes,
            max_age_ms: 10_000,
        }
    }
    fn parked(since: u64, session: u64, size: Option<u64>) -> Parked {
        Parked {
            since,
            session,
            size,
        }
    }
    #[test]
    fn retention_next_launch_age_and_oldest_cap_selection() {
        let rows = [parked(2_000, 2, Some(8)), parked(1_000, 2, Some(8))];
        assert!(due(policy(16), 2_000, 9_999, 2, &rows).is_empty());
        assert_eq!(
            due(policy(8), 2_000, 3_000, 2, &rows),
            vec![Due {
                index: 1,
                reclaimed: true
            }]
        );
        assert!(due(policy(0), 2_000, 2_999, 2, &rows).is_empty());
        assert_eq!(
            due(policy(16), 2_000, 11_000, 2, &rows),
            vec![Due {
                index: 1,
                reclaimed: true
            }]
        );
        assert_eq!(
            due(policy(16), 2_000, 4_000, 3, &rows),
            vec![
                Due {
                    index: 1,
                    reclaimed: false
                },
                Due {
                    index: 0,
                    reclaimed: false
                }
            ]
        );
    }
    #[test]
    fn retention_unknown_sizes_overflow_and_future_sessions_are_not_absence() {
        let rows = [parked(0, 1, Some(u64::MAX)), parked(0, 1, Some(u64::MAX))];
        assert_eq!(due(policy(u64::MAX), 2_000, 2_000, 1, &rows).len(), 1);
        assert_eq!(
            due(policy(10), 2_000, 2_000, 1, &[parked(0, 1, None)]).len(),
            1
        );
        assert!(due(policy(0), 2_000, 20_000, 1, &[parked(0, 2, Some(1))]).is_empty());
        assert!(due(policy(0), 2_000, 20_000, 1, &[parked(u64::MAX, 1, Some(1))]).is_empty());
    }
    #[test]
    fn retention_deadlines_keep_age_and_minimum_without_hot_timer_for_this_launch() {
        let row = parked(1_000, 1, Some(1));
        assert_eq!(deadline(policy(10), 2_000, 1, &row), Some(11_000));
        assert_eq!(deadline(policy(10), 2_000, 2, &row), Some(3_000));
        assert_eq!(
            deadline(ReleasePolicy::AfterRetention, 2_000, 1, &row),
            Some(3_000)
        );
        assert_eq!(deadline(policy(10), 2_000, 0, &row), None);
    }
}
