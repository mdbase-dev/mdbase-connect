//! Persisted origin hints remain DATA, including plausible but foreign hints.
use super::*;

#[test]
fn missing_damaged_foreign_or_false_hints_need_actual_semantic_replay() {
    let (svc, _, pins, peer) = fixture();
    let hint_key = "replica.original_history_hints.v1";
    for mode in 0..5 {
        let mut cold = open(&svc);
        cold.pump(false);
        let original = cold.e.observe_native_target().unwrap();
        let mut store = cold.e.replica().store().inner().clone();
        let encoded = store.meta(hint_key).unwrap().unwrap();
        let mut value = cbor::decode(&encoded).unwrap();
        let Cbor::Array(fields) = &mut value else {
            panic!("hint codec shape")
        };
        let changed = match mode {
            0 => None,
            1 => Some(vec![0xff]),
            2 => {
                fields[1] = B16([0x71; 16]).to_cbor();
                Some(cbor::encode(&value).unwrap())
            }
            3 => {
                fields[2] = Cbor::Array(vec![Cbor::Uint(1), B32([0x72; 32]).to_cbor()]);
                Some(cbor::encode(&value).unwrap())
            }
            4 => Some(vec![0; 16 * 1024 + 1]),
            _ => unreachable!(),
        };
        store
            .commit(Tx {
                meta: vec![(hint_key.into(), changed)],
                ..Default::default()
            })
            .unwrap();
        let clock = Rc::new(Cell::new(1_700_000_000_000));
        let host = Host {
            clock: Box::new(TestClock(clock.clone())),
            entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(3)),
            zones: Box::new(UtcOnly),
        };
        let mut e = Engine::open(config(&svc), store, host, HostedProfile::default()).unwrap();
        assert!(
            e.replica().observed_original_genesis().is_none(),
            "mode{mode}"
        );
        assert!(
            e.replica().observed_original_grant(&APP_GRANT).is_none(),
            "mode{mode}"
        );
        assert!(e.observe_native_target().is_err(), "mode{mode}");
        assert!(e.recheck_native_target(&original).is_err(), "mode{mode}");
        assert!(e.bind_log(COL));
        let mut warm = AppHosted {
            e,
            log: svc.client(HOSTED_DEV),
            clock,
        };
        warm.pump(false);
        let independently_replayed = warm
            .e
            .observe_native_target()
            .expect("genuine native replay, not hint repair as proof");
        assert_eq!(
            independently_replayed.originals(),
            original.originals(),
            "mode{mode}"
        );
        assert!(
            warm.e
                .original_app_query(&peer, &declarations(&pins))
                .is_ok(),
            "mode{mode}"
        );
        assert_eq!(
            warm.e.replica().store().meta(hint_key).unwrap(),
            Some(encoded),
            "only genuine native originals recreate hints"
        );
    }
}
