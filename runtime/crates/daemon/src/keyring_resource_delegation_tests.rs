//! The keyring wrapper preserves original resource authority, observations and
//! retained async owners; it never fabricates completion or retries an attempt.
//! The MemStore only supplies unrelated required Store methods. The nine seams
//! under test have distinct synchronous/async probes; async never calls sync.
//! All IDs, paths, observations and error literals below are synthetic.

use std::cell::{Cell, RefCell};
use std::fmt::Debug;
use std::future::Future;
use std::ops::Range;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use mdbn_replica::mem::MemStore;
use mdbn_replica::store::*;
use mdbn_wire::client::Hold;
use mdbn_wire::common::{B16, B32, Hash, Uuid};
use mdbn_wire::intent::FileInclusion;

use crate::keyring_store::KeychainKeyring;
use crate::secrets::{MemoryStore, SecretStore};

const RESOURCE_BODY: &str = "original bounded inner resource";
const IO: &str = "synthetic resource I/O refusal";
const CORRUPT: &str = "synthetic resource integrity refusal";
const LIMIT: usize = 73;
const COLLECTION: B16 = B16([0x13; 16]);
const MUTATION: B16 = B16([0x29; 16]);

#[derive(Clone, Copy, Debug)]
enum Answer {
    Present,
    Missing,
    Io,
    Corrupt,
    Full,
}
impl Answer {
    fn result<T>(self, present: T, missing: T) -> StoreResult<T> {
        match self {
            Self::Present => Ok(present),
            Self::Missing => Ok(missing),
            Self::Io => Err(StoreError::Io(IO.into())),
            Self::Corrupt => Err(StoreError::Corrupt(CORRUPT.into())),
            Self::Full => Err(StoreError::Full),
        }
    }
}
const ANSWERS: [Answer; 5] = [
    Answer::Present,
    Answer::Missing,
    Answer::Io,
    Answer::Corrupt,
    Answer::Full,
];

#[derive(Clone, Debug, PartialEq)]
enum Call {
    Defer {
        address: usize,
        tokens: Vec<ObservationId>,
    },
    Refused {
        address: usize,
        tokens: Vec<ObservationId>,
        mutation: Uuid,
    },
    Text {
        asynchronous: bool,
        address: usize,
        observation: Observation,
        limit: usize,
    },
    Current {
        asynchronous: bool,
        address: usize,
        observation: Observation,
    },
    Complete {
        asynchronous: bool,
        address: usize,
        observations: Vec<Observation>,
    },
    Observe {
        asynchronous: bool,
        address: Option<usize>,
        paths: Option<Vec<String>>,
    },
}
#[derive(Clone, Default)]
struct Trace {
    calls: Rc<RefCell<Vec<Call>>>,
    polls: Rc<Cell<usize>>,
    drops: Rc<Cell<usize>>,
}
impl Trace {
    fn push(&self, call: Call) {
        self.calls.borrow_mut().push(call);
    }
    fn assert_one(&self, expected: &Call) {
        assert_eq!(
            self.calls.borrow().as_slice(),
            std::slice::from_ref(expected)
        );
    }
    fn clear(&self) {
        self.calls.borrow_mut().clear();
        self.polls.set(0);
        self.drops.set(0);
    }
}

/// A retained inner operation: the first poll must be Pending, the second Ready.
/// One construction records one attempt. Polling cannot call a Store sync seam.
struct PendingOnce<T> {
    result: Option<StoreResult<T>>,
    started: bool,
    trace: Trace,
}
impl<T: Unpin> Future for PendingOnce<T> {
    type Output = StoreResult<T>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.trace.polls.set(self.trace.polls.get() + 1);
        if !self.started {
            self.started = true;
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        Poll::Ready(
            self.result
                .take()
                .expect("same inner operation completes once"),
        )
    }
}
impl<T> Drop for PendingOnce<T> {
    fn drop(&mut self) {
        self.trace.drops.set(self.trace.drops.get() + 1);
    }
}

#[derive(Clone, Copy)]
enum CountRead {
    Pending,
    Holds,
    Conflicts,
}

struct ResourceProbe {
    mem: MemStore,
    answer: Answer,
    trace: Trace,
    count_failure: Option<CountRead>,
    pending_count: u64,
}
impl ResourceProbe {
    fn pending<'a, T: Unpin + 'a>(&'a self, result: StoreResult<T>) -> StoreFuture<'a, T> {
        Box::pin(PendingOnce {
            result: Some(result),
            started: false,
            trace: self.trace.clone(),
        })
    }
}

// Only unrelated required read methods use MemStore. These cannot accidentally
// provide resource-observation behavior or make the nine probe paths green.
macro_rules! forward_mem_reads {
    ($(fn $name:ident($($arg:ident: $ty:ty),*) -> $out:ty;)*) => {
        $(fn $name(&self, $($arg: $ty),*) -> $out {
            self.mem.$name($($arg),*)
        })*
    };
}
impl Store for ResourceProbe {
    // Retains no own history (the trait's `own_retained` default).
    fn own_retained_stats(&self) -> StoreResult<TailStats> {
        Ok(TailStats::default())
    }
    forward_mem_reads! {
        fn head() -> StoreResult<Head>;
        fn record(id: &Uuid) -> StoreResult<Option<RecordRow>>;
        fn record_at(path_key: &str) -> StoreResult<Option<Uuid>>;
        fn records(page: Page) -> StoreResult<Vec<RecordRow>>;
        fn records_in_buckets(range: Range<u32>, page: Page) -> StoreResult<Vec<RecordRow>>;
        fn record_count() -> StoreResult<u64>;
        fn file(id: &Uuid) -> StoreResult<Option<FileRow>>;
        fn file_at(path_key: &str) -> StoreResult<Option<Uuid>>;
        fn files(page: Page) -> StoreResult<Vec<FileRow>>;
        fn files_in_buckets(range: Range<u32>, page: Page) -> StoreResult<Vec<FileRow>>;
        fn resource(path: &str) -> StoreResult<Option<String>>;
        fn resources() -> StoreResult<Vec<(String, String)>>;
        fn settings() -> StoreResult<Option<FileInclusion>>;
        fn tombstone(id: &Uuid) -> StoreResult<Option<TombstoneRow>>;
        fn tombstones_at(path_key: &str) -> StoreResult<Vec<TombstoneRow>>;
        fn tombstones(page: Page) -> StoreResult<Vec<TombstoneRow>>;
        fn alias(path_key: &str) -> StoreResult<Option<Uuid>>;
        fn aliases() -> StoreResult<Vec<AliasRow>>;
        fn conflicts(of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>>;
        fn receipt(mutation: &Uuid) -> StoreResult<Option<ReceiptRow>>;
        fn receipts(after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>>;
        fn referrers(target_keys: &[String]) -> StoreResult<Vec<Uuid>>;
        fn unique_holders(field: &str, value_key: &str) -> StoreResult<Vec<Uuid>>;
        fn candidates(q: &Candidate, page: Page) -> StoreResult<Vec<RecordRow>>;
        fn pending(after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>>;
        fn pending_get(mutation: &Uuid) -> StoreResult<Option<PendingRow>>;
        fn local_receipt(mutation: &Uuid) -> StoreResult<Option<LocalReceipt>>;
        fn hold(id: &Uuid) -> StoreResult<Option<Hold>>;
        fn meta(key: &str) -> StoreResult<Option<Vec<u8>>>;
        fn transfer(id: &Uuid) -> StoreResult<Option<TransferRow>>;
        fn transfer_chunk(id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>>;
        fn blob_size(digest: &Hash) -> StoreResult<Option<u64>>;
        fn blob_read(digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>>;
    }
    fn pending_count(&self) -> StoreResult<u64> {
        if matches!(self.count_failure, Some(CountRead::Pending)) {
            return Err(StoreError::Io(IO.into()));
        }
        Ok(self.pending_count)
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        if matches!(self.count_failure, Some(CountRead::Holds)) {
            return Err(StoreError::Corrupt(CORRUPT.into()));
        }
        self.mem.holds()
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        if matches!(self.count_failure, Some(CountRead::Conflicts)) {
            return Err(StoreError::Full);
        }
        self.mem.conflict_count()
    }
    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.mem.commit(tx)
    }
    fn defer_disk_observations(&mut self, tokens: &[ObservationId]) -> StoreResult<()> {
        self.trace.push(Call::Defer {
            address: tokens.as_ptr() as usize,
            tokens: tokens.to_vec(),
        });
        self.answer.result((), ())
    }
    fn resource_observation_refused(
        &mut self,
        tokens: &[ObservationId],
        mutation: Uuid,
    ) -> StoreResult<()> {
        self.trace.push(Call::Refused {
            address: tokens.as_ptr() as usize,
            tokens: tokens.to_vec(),
            mutation,
        });
        self.answer.result((), ())
    }
    fn resource_observation_text(
        &mut self,
        observation: &Observation,
        limit: usize,
    ) -> StoreResult<Option<String>> {
        self.trace.push(text_call(false, observation, limit));
        self.answer.result(Some(RESOURCE_BODY.into()), None)
    }
    fn resource_observation_text_async<'a>(
        &'a mut self,
        observation: &'a Observation,
        limit: usize,
    ) -> StoreFuture<'a, Option<String>> {
        self.trace.push(text_call(true, observation, limit));
        self.pending(self.answer.result(Some(RESOURCE_BODY.into()), None))
    }
    fn resource_observation_current(&mut self, observation: &Observation) -> StoreResult<bool> {
        self.trace.push(current_call(false, observation));
        self.answer.result(true, false)
    }
    fn resource_observation_current_async<'a>(
        &'a mut self,
        observation: &'a Observation,
    ) -> StoreFuture<'a, bool> {
        self.trace.push(current_call(true, observation));
        self.pending(self.answer.result(true, false))
    }
    fn resource_observation_batch_complete(
        &self,
        observations: &[Observation],
    ) -> StoreResult<bool> {
        self.trace.push(complete_call(false, observations));
        self.answer.result(true, false)
    }
    fn resource_observation_batch_complete_async<'a>(
        &'a self,
        observations: &'a [Observation],
    ) -> StoreFuture<'a, bool> {
        self.trace.push(complete_call(true, observations));
        self.pending(self.answer.result(true, false))
    }
    // Existing synchronous observe is instrumented to catch async->sync fallback.
    fn observe(&mut self, paths: Option<&[String]>) -> StoreResult<Vec<Observation>> {
        self.trace.push(observe_call(false, paths));
        self.answer.result(observations().to_vec(), Vec::new())
    }
    fn observe_async<'a>(
        &'a mut self,
        paths: Option<&'a [String]>,
    ) -> StoreFuture<'a, Vec<Observation>> {
        self.trace.push(observe_call(true, paths));
        self.pending(self.answer.result(observations().to_vec(), Vec::new()))
    }
}

fn text_call(asynchronous: bool, observation: &Observation, limit: usize) -> Call {
    Call::Text {
        asynchronous,
        address: observation as *const Observation as usize,
        observation: observation.clone(),
        limit,
    }
}
fn current_call(asynchronous: bool, observation: &Observation) -> Call {
    Call::Current {
        asynchronous,
        address: observation as *const Observation as usize,
        observation: observation.clone(),
    }
}
fn complete_call(asynchronous: bool, observations: &[Observation]) -> Call {
    Call::Complete {
        asynchronous,
        address: observations.as_ptr() as usize,
        observations: observations.to_vec(),
    }
}
fn observe_call(asynchronous: bool, paths: Option<&[String]>) -> Call {
    Call::Observe {
        asynchronous,
        address: paths.map(|p| p.as_ptr() as usize),
        paths: paths.map(<[String]>::to_vec),
    }
}
fn observations() -> [Observation; 2] {
    [
        Observation {
            token: ObservationId(401),
            path: "schema-original.yaml".into(),
            base: Some(B32([0x07; 32])),
            now: Some(Observed::Text(
                "caller text is NOT bounded source authority".into(),
            )),
            moved_from: Some("old-schema.yaml".into()),
            provenance: Provenance::Normal,
        },
        Observation {
            token: ObservationId(777),
            path: "mdbase.yaml".into(),
            base: Some(B32([0x19; 32])),
            now: None,
            moved_from: None,
            provenance: Provenance::Suspect,
        },
    ]
}
fn wrapped(answer: Answer, credentialed: bool) -> (KeychainKeyring<ResourceProbe>, Trace) {
    let trace = Trace::default();
    let inner = ResourceProbe {
        mem: MemStore::new(),
        answer,
        trace: trace.clone(),
        count_failure: None,
        pending_count: 0,
    };
    let secrets: Option<Arc<dyn SecretStore>> = if credentialed {
        Some(Arc::new(MemoryStore::default()))
    } else {
        None
    };
    (
        KeychainKeyring::new(inner, secrets, &COLLECTION).unwrap(),
        trace,
    )
}
fn assert_answer<T: Debug + PartialEq>(
    result: StoreResult<T>,
    answer: Answer,
    present: T,
    missing: T,
) {
    match answer {
        Answer::Present => assert_eq!(result.unwrap(), present),
        Answer::Missing => assert_eq!(result.unwrap(), missing),
        Answer::Io => assert!(matches!(result, Err(StoreError::Io(s)) if s == IO)),
        Answer::Corrupt => assert!(matches!(result, Err(StoreError::Corrupt(s)) if s == CORRUPT)),
        Answer::Full => assert!(matches!(result, Err(StoreError::Full))),
    }
}
fn finish_same<T>(
    mut future: StoreFuture<'_, T>,
    trace: &Trace,
    expected: &Call,
) -> StoreResult<T> {
    let mut cx = Context::from_waker(Waker::noop());
    trace.assert_one(expected);
    assert!(matches!(future.as_mut().poll(&mut cx), Poll::Pending));
    trace.assert_one(expected);
    assert_eq!(trace.polls.get(), 1);
    assert_eq!(trace.drops.get(), 0, "inner Pending future must stay alive");
    let Poll::Ready(result) = future.as_mut().poll(&mut cx) else {
        panic!("the same inner future must resume to Ready");
    };
    trace.assert_one(expected);
    assert_eq!(trace.polls.get(), 2);
    assert_eq!(trace.drops.get(), 0);
    drop(future);
    assert_eq!(trace.drops.get(), 1, "one original future / one attempt");
    result
}

#[test]
fn capture_counts_refuses_unreadable_or_owned_pending_instead_of_masking_zero() {
    // Guard unit proof only, NOT an original native pending/unknown fixture.
    for credentialed in [false, true] {
        let (mut store, _) = wrapped(Answer::Present, credentialed);
        assert_eq!(crate::runtime::capture_counts(&store), Some((0, 0)));
        for failure in [CountRead::Pending, CountRead::Holds, CountRead::Conflicts] {
            store.inner_mut().count_failure = Some(failure);
            assert!(crate::runtime::capture_counts(&store).is_none());
        }
        store.inner_mut().count_failure = None;
        store.inner_mut().pending_count = 1;
        assert!(crate::runtime::capture_counts(&store).is_none());
        assert_eq!(
            store.pending_count().unwrap(),
            1,
            "original ownership was not consumed"
        );
    }
}

#[test]
fn resource_sync_delegates_exact_original_observations_limits_and_fences() {
    for credentialed in [false, true] {
        for answer in ANSWERS {
            let (mut store, trace) = wrapped(answer, credentialed);
            let obs = observations();
            assert_answer(
                store.resource_observation_text(&obs[0], LIMIT),
                answer,
                Some(RESOURCE_BODY.into()),
                None,
            );
            trace.assert_one(&text_call(false, &obs[0], LIMIT));
            trace.clear();
            assert_answer(
                store.resource_observation_current(&obs[1]),
                answer,
                true,
                false,
            );
            trace.assert_one(&current_call(false, &obs[1]));
            trace.clear();
            assert_answer(
                store.resource_observation_batch_complete(&obs),
                answer,
                true,
                false,
            );
            trace.assert_one(&complete_call(false, &obs));
        }
    }
}

#[test]
fn resource_defer_and_refused_keep_original_token_slice_mutation_and_errors() {
    for credentialed in [false, true] {
        for answer in ANSWERS {
            let (mut store, trace) = wrapped(answer, credentialed);
            let tokens = [ObservationId(777), ObservationId(401)];
            assert_answer(store.defer_disk_observations(&tokens), answer, (), ());
            trace.assert_one(&Call::Defer {
                address: tokens.as_ptr() as usize,
                tokens: tokens.to_vec(),
            });
            trace.clear();
            assert_answer(
                store.resource_observation_refused(&tokens, MUTATION),
                answer,
                (),
                (),
            );
            trace.assert_one(&Call::Refused {
                address: tokens.as_ptr() as usize,
                tokens: tokens.to_vec(),
                mutation: MUTATION,
            });
        }
    }
}

#[test]
fn resource_async_keeps_same_pending_inner_future_without_sync_or_retry() {
    for credentialed in [false, true] {
        for answer in ANSWERS {
            let (mut store, trace) = wrapped(answer, credentialed);
            let obs = observations();
            let result = finish_same(
                store.resource_observation_text_async(&obs[0], LIMIT),
                &trace,
                &text_call(true, &obs[0], LIMIT),
            );
            assert_answer(result, answer, Some(RESOURCE_BODY.into()), None);
            trace.clear();
            let result = finish_same(
                store.resource_observation_current_async(&obs[1]),
                &trace,
                &current_call(true, &obs[1]),
            );
            assert_answer(result, answer, true, false);
            trace.clear();
            let result = finish_same(
                store.resource_observation_batch_complete_async(&obs),
                &trace,
                &complete_call(true, &obs),
            );
            assert_answer(result, answer, true, false);
        }
    }
}

#[test]
fn observe_async_keeps_original_paths_none_pending_and_result_without_sync_fallback() {
    for credentialed in [false, true] {
        for answer in ANSWERS {
            for all_paths in [false, true] {
                let (mut store, trace) = wrapped(answer, credentialed);
                let paths = ["mdbase.yaml".into(), "schema-original.yaml".into()];
                let selection = if all_paths {
                    None
                } else {
                    Some(paths.as_slice())
                };
                let result = finish_same(
                    store.observe_async(selection),
                    &trace,
                    &observe_call(true, selection),
                );
                assert_answer(result, answer, observations().to_vec(), Vec::new());
            }
        }
    }
}

#[test]
fn empty_resource_batches_and_token_slices_are_forwarded_not_accepted_locally() {
    // An empty caller slice is NOT evidence that the original resource set is
    // complete. The inner false/error must still reach the caller.
    for answer in [Answer::Missing, Answer::Io] {
        let (mut store, trace) = wrapped(answer, true);
        let obs: [Observation; 0] = [];
        assert_answer(
            store.resource_observation_batch_complete(&obs),
            answer,
            true,
            false,
        );
        trace.assert_one(&complete_call(false, &obs));
        trace.clear();
        let result = finish_same(
            store.resource_observation_batch_complete_async(&obs),
            &trace,
            &complete_call(true, &obs),
        );
        assert_answer(result, answer, true, false);
        trace.clear();
        let tokens: [ObservationId; 0] = [];
        assert_answer(store.defer_disk_observations(&tokens), answer, (), ());
        trace.assert_one(&Call::Defer {
            address: tokens.as_ptr() as usize,
            tokens: Vec::new(),
        });
        trace.clear();
        assert_answer(
            store.resource_observation_refused(&tokens, MUTATION),
            answer,
            (),
            (),
        );
        trace.assert_one(&Call::Refused {
            address: tokens.as_ptr() as usize,
            tokens: Vec::new(),
            mutation: MUTATION,
        });
    }
}
