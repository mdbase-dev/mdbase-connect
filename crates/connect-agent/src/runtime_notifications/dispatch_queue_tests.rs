use super::*;

#[tokio::test]
async fn dispatch_is_bounded_and_coalesces_each_collections_readiness() {
    let root = tempfile::tempdir().unwrap();
    let runtime_dir = root.path().join("runtime");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    let service = RuntimeNotificationService {
        runtime_dir,
        local_registry: CollectionRegistry::open(root.path().join("registry")).unwrap(),
        cloud: None,
        runtimes: HashMap::new(),
        dispatch: DispatchQueue::default(),
    };
    let mut queue = DispatchQueue::default();
    let runtimes: Vec<_> = (0..8)
        .map(|_| {
            let id = Uuid::new_v4();
            (id, Arc::new(service.build_runtime(id, None).unwrap()))
        })
        .collect();
    for (id, runtime) in &runtimes {
        queue.schedule(*id, runtime.clone());
    }
    assert_eq!(queue.active.len(), DISPATCH_CONCURRENCY);
    assert_eq!(queue.pending.len(), 4);
    for _ in 0..100 {
        queue.schedule(runtimes[0].0, runtimes[0].1.clone());
    }
    assert_eq!(
        queue
            .pending
            .iter()
            .filter(|(id, _)| *id == runtimes[0].0)
            .count(),
        1
    );
    while queue.has_tasks() {
        queue.completed().await;
        assert!(queue.active.len() <= DISPATCH_CONCURRENCY);
    }
    assert!(queue.pending.is_empty());
    assert!(queue.active.is_empty());
}

#[tokio::test]
async fn panicked_dispatch_releases_its_collection_slot() {
    let mut queue = DispatchQueue::default();
    let task = queue
        .tasks
        .spawn(async { panic!("injected dispatch panic") });
    queue.active.insert(task.id(), Uuid::new_v4());
    queue.completed().await;
    assert!(queue.active.is_empty());
}
