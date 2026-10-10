//! The engine's live verified hosted admission, encoded for the host's trusted
//! synchronous bridge (the Worker's `LiveAdmissionSource.observe()`). Read-only:
//! every call observes again; nothing here is a permit or can be fed back.
//!
//! `[0, reason]` on Deny, else `[1, {0: collection, 1: device, 2: sign_pk,
//! 3: kem_pk, 4: noise_pk, 5: wake (u64), 6: generation, 7: epoch,
//! 8: [applied seq, chain], 9: [authenticated seq, chain], 10: root_id, 11: root_pk,
//! 12: control_chain, 13: key_delivery_device, 14: key_delivery_seq}]`.

use mdbn_replica::HostedAdmission;
use mdbn_wire::cbor::{self, Cbor};

fn b(x: &[u8]) -> Cbor {
    Cbor::Bytes(x.to_vec())
}

/// Encode one observation.
pub fn encode(a: &HostedAdmission) -> Vec<u8> {
    let c = match a {
        HostedAdmission::Deny(reason) => {
            Cbor::Array(vec![Cbor::Uint(0), Cbor::Text(format!("{reason:?}"))])
        }
        HostedAdmission::Verified(v) => {
            let id = v.identity();
            let (applied, auth) = (v.applied_head(), v.authenticated_head());
            Cbor::Array(vec![
                Cbor::Uint(1),
                Cbor::Map(vec![
                    (Cbor::Uint(0), b(&v.collection().0)),
                    (Cbor::Uint(1), b(&v.device().0)),
                    (Cbor::Uint(2), b(&id.sign_pk.0)),
                    (Cbor::Uint(3), b(&id.kem_pk.0)),
                    (Cbor::Uint(4), b(&v.noise_pk().0)),
                    (Cbor::Uint(5), Cbor::Uint(v.wake_instance())),
                    (Cbor::Uint(6), Cbor::Uint(v.generation())),
                    (Cbor::Uint(7), Cbor::Uint(v.epoch())),
                    (
                        Cbor::Uint(8),
                        Cbor::Array(vec![Cbor::Uint(applied.seq), b(&applied.chain.0)]),
                    ),
                    (
                        Cbor::Uint(9),
                        Cbor::Array(vec![Cbor::Uint(auth.seq), b(&auth.chain.0)]),
                    ),
                    (Cbor::Uint(10), b(&v.root_id().0)),
                    (Cbor::Uint(11), b(&v.root_pk().0)),
                    (Cbor::Uint(12), b(&v.control_chain().0)),
                    (Cbor::Uint(13), b(&v.key_delivery_device().0)),
                    (Cbor::Uint(14), Cbor::Uint(v.key_delivery_seq())),
                ]),
            ])
        }
    };
    cbor::encode(&c).unwrap_or_default()
}
