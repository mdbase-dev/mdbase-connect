//! Pure mirror-join classification, not permission to ingest or publish.
//!
//! The host must first verify the collection's migration record and install at C,
//! map legacy IDs (not paths), and retain the old mirror state/unknown outcomes.
//! A classification is only a proposal. Effects still require a durable base proof,
//! current full descriptor/source generation/holder checks and guarded no-clobber
//! operations. This module never writes known-on-disk state or resends a mutation.

/// Whole plaintext SHA-256, not an encrypted blob or chain hash.
pub type PlainHash = [u8; 32];

/// The trusted mirror's last accepted content at cursor N.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MirrorBase {
    /// Whole bytes last accepted for this preserved legacy ID.
    pub hash: PlainHash,
    /// Mirror's checkpointed legacy sequence.
    pub cursor: u64,
}

/// Absence in a certified complete mirror base is not the same as unavailable
/// provenance. The caller must not use `Absent` for a missing/untrusted state file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Base {
    /// Certified content at the checkpoint.
    Present(MirrorBase),
    /// Certified absence in the complete checkpoint (including namespace checks).
    Absent {
        /// Sequence of the complete trusted checkpoint.
        cursor: u64,
    },
    /// Reader could not establish a trusted checkpoint for this candidate.
    Unavailable,
}

/// Three-way comparison inputs for one ID, captured by the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Revisions {
    /// Explicitly distinguishes certified presence/absence from unavailable state.
    pub base: Base,
    /// Drained legacy head covered by the verified migration record.
    pub s_final: u64,
    /// Whole plaintext revision in the verified new state at C (None = absent).
    pub server: Option<PlainHash>,
    /// Actual current disk bytes (None = absent), never a fabricated server hash.
    pub local: Option<PlainHash>,
    /// An in-flight legacy outcome not yet accounted for at the verified head.
    /// It must not be replayed as a new mutation merely because bytes differ.
    pub unresolved_outcome: bool,
    /// Only read-write mirrors can turn local absence into an external delete.
    pub read_write: bool,
}

/// A proposal only; every branch still needs host current-source/no-clobber checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Certify this ACTUAL disk hash, after re-verifying the current bytes. No
    /// download or publication is required. It is never used when disk != server.
    Matching {
        /// Actual disk hash, equal to the verified server hash.
        actual: PlainHash,
    },
    /// Nothing exists on either side. Preserve all original evidence anyway.
    Absent,
    /// Download/materialize the verified server content. Guard replacement by the
    /// actual observed disk hash (None means a create must be no-replace).
    Materialize {
        /// Actual hash guarding replacement; absent means no-replace creation.
        expected_disk: Option<PlainHash>,
        /// Verified server plaintext hash to materialize.
        server: PlainHash,
    },
    /// Ordinary external edit using a DISTINCT durable migration base proof.
    /// Disk-known state, if certified, is `actual`, NEVER `base`.
    ExternalEdit {
        /// Verified unchanged server base, carried separately from disk-known state.
        base: PlainHash,
        /// Current user's bytes, never certified under the server hash.
        actual: PlainHash,
    },
    /// A fresh candidate absent in BOTH verified namespaces, with actual local
    /// bytes. Still needs durable absence/path-collision/current-source checks.
    ExternalCreate {
        /// Actual bytes of the fresh candidate.
        actual: PlainHash,
    },
    /// Move the unchanged disk bytes aside as retained evidence of server deletion.
    RetainDeleted {
        /// Actual unchanged hash guarding the move-aside operation.
        expected_disk: PlainHash,
    },
    /// Local deletion against an unchanged server: submit only with durable proof
    /// and the current matching full server descriptor.
    ExternalDelete {
        /// Verified unchanged server base of the local deletion.
        base: PlainHash,
    },
    /// Both sides changed, or edit/delete raced. Keep disk bytes and the complete
    /// server descriptor/content (including full binary descriptor) in a hold.
    Conflict,
    /// Missing base never authorizes an edit, create or delete automatically.
    UnknownBase,
    /// A mirror cursor newer than the migration record cannot certify provenance.
    FutureBase,
    /// Preserve the ambiguous legacy outcome; do not resend it or infer success.
    UnknownOutcome,
}

/// Compare only revisions; this is NOT a storage or authorization API.
pub fn classify(r: Revisions) -> Decision {
    if r.unresolved_outcome {
        return Decision::UnknownOutcome;
    }
    let cursor = match r.base {
        Base::Present(b) => Some(b.cursor),
        Base::Absent { cursor } => Some(cursor),
        Base::Unavailable => None,
    };
    if cursor.is_some_and(|n| n > r.s_final) {
        return Decision::FutureBase;
    }
    if let (Some(local), Some(server)) = (r.local, r.server)
        && local == server
    {
        return Decision::Matching { actual: local };
    }
    if r.local.is_none() && r.server.is_none() {
        return Decision::Absent;
    }
    let base = match r.base {
        Base::Present(b) => b,
        Base::Absent { .. } => {
            return match (r.local, r.server) {
                (Some(actual), None) => Decision::ExternalCreate { actual },
                (None, Some(server)) => Decision::Materialize {
                    expected_disk: None,
                    server,
                },
                _ => Decision::Conflict,
            };
        }
        Base::Unavailable => return Decision::UnknownBase,
    };
    match (r.local, r.server) {
        (Some(local), Some(server)) if local == base.hash => Decision::Materialize {
            expected_disk: Some(local),
            server,
        },
        (Some(local), Some(server)) if server == base.hash => Decision::ExternalEdit {
            base: server,
            actual: local,
        },
        (Some(local), None) if local == base.hash => Decision::RetainDeleted {
            expected_disk: local,
        },
        (None, Some(server)) if !r.read_write => Decision::Materialize {
            expected_disk: None,
            server,
        },
        (None, Some(server)) if server == base.hash => Decision::ExternalDelete { base: server },
        _ => Decision::Conflict,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(local: Option<u8>, server: Option<u8>) -> Revisions {
        Revisions {
            base: Base::Present(MirrorBase {
                hash: [1; 32],
                cursor: 4,
            }),
            s_final: 7,
            server: server.map(|n| [n; 32]),
            local: local.map(|n| [n; 32]),
            unresolved_outcome: false,
            read_write: true,
        }
    }
    #[test]
    fn queued_edit_never_certifies_disk_at_the_server_revision() {
        let r = input(Some(2), Some(1));
        assert_eq!(
            classify(r),
            Decision::ExternalEdit {
                base: [1; 32],
                actual: [2; 32]
            }
        );
        assert!(!matches!(classify(r), Decision::Matching { .. }));
    }
    #[test]
    fn matching_bytes_need_no_download_but_are_actual_bytes() {
        for base in [
            Base::Unavailable,
            Base::Absent { cursor: 4 },
            Base::Present(MirrorBase {
                hash: [1; 32],
                cursor: 4,
            }),
        ] {
            let r = Revisions {
                base,
                ..input(Some(2), Some(2))
            };
            assert_eq!(classify(r), Decision::Matching { actual: [2; 32] });
        }
    }
    #[test]
    fn comparison_matrix_is_conservative_for_edits_and_deletes() {
        for (local, server, expected) in [
            (
                Some(1),
                Some(2),
                Decision::Materialize {
                    expected_disk: Some([1; 32]),
                    server: [2; 32],
                },
            ),
            (Some(2), Some(3), Decision::Conflict),
            (
                Some(1),
                None,
                Decision::RetainDeleted {
                    expected_disk: [1; 32],
                },
            ),
            (Some(2), None, Decision::Conflict),
            (None, Some(1), Decision::ExternalDelete { base: [1; 32] }),
            (None, Some(2), Decision::Conflict),
            (None, None, Decision::Absent),
        ] {
            assert_eq!(classify(input(local, server)), expected);
        }
        assert_eq!(
            classify(Revisions {
                read_write: false,
                ..input(None, Some(2))
            }),
            Decision::Materialize {
                expected_disk: None,
                server: [2; 32]
            }
        );
    }
    #[test]
    fn missing_or_future_base_never_authorizes_an_external_change() {
        for (local, server) in [(Some(2), Some(1)), (Some(2), None), (None, Some(1))] {
            assert_eq!(
                classify(Revisions {
                    base: Base::Unavailable,
                    ..input(local, server)
                }),
                Decision::UnknownBase
            );
        }
        for (local, server) in [(Some(1), Some(1)), (Some(2), Some(1)), (None, None)] {
            assert_eq!(
                classify(Revisions {
                    base: Base::Present(MirrorBase {
                        hash: [1; 32],
                        cursor: 8
                    }),
                    ..input(local, server)
                }),
                Decision::FutureBase
            );
        }
    }
    #[test]
    fn trusted_absence_is_not_unavailable_provenance() {
        let r = Revisions {
            base: Base::Absent { cursor: 4 },
            ..input(Some(2), None)
        };
        assert_eq!(classify(r), Decision::ExternalCreate { actual: [2; 32] });
        assert_eq!(
            classify(Revisions {
                base: Base::Unavailable,
                ..r
            }),
            Decision::UnknownBase
        );
        assert_eq!(
            classify(Revisions {
                base: Base::Absent { cursor: 8 },
                ..r
            }),
            Decision::FutureBase
        );
        assert_eq!(
            classify(Revisions {
                server: Some([1; 32]),
                ..r
            }),
            Decision::Conflict
        );
        assert_eq!(
            classify(Revisions {
                local: None,
                server: Some([1; 32]),
                ..r
            }),
            Decision::Materialize {
                expected_disk: None,
                server: [1; 32]
            }
        );
    }
    #[test]
    fn unknown_outcomes_are_retained_even_when_bytes_match() {
        for (local, server) in [(Some(1), Some(1)), (Some(2), Some(1)), (None, None)] {
            assert_eq!(
                classify(Revisions {
                    unresolved_outcome: true,
                    ..input(local, server)
                }),
                Decision::UnknownOutcome
            );
        }
    }
    #[test]
    fn all_small_hash_combinations_obey_the_known_bytes_invariant() {
        for local in [None, Some(1), Some(2), Some(3)] {
            for server in [None, Some(1), Some(2), Some(3)] {
                let r = input(local, server);
                if let Decision::Matching { actual } = classify(r) {
                    assert_eq!(Some(actual), r.local);
                    assert_eq!(Some(actual), r.server);
                }
            }
        }
    }
}
