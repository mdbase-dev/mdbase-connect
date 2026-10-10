//! Real, private D-Bus transport/loop tests. Never use DBUS_SESSION_BUS_ADDRESS,
//! the person's bus, a desktop tray host or their daemon/profile/credentials.
use super::*;
use crate::access::AccessEntry;
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{atomic::AtomicU64, mpsc as std_mpsc},
    thread::{self, JoinHandle},
    time::Instant,
};

struct Bus {
    child: Child,
    root: PathBuf,
    address: String,
}
impl Bus {
    fn new() -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let repo =
            std::fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let root = repo.join("target/t").join(format!(
            "b{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        crate::fsutil::ensure_private_dir(&root).unwrap();
        let mut child = Command::new("/usr/bin/dbus-daemon")
            .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
            .arg(format!(
                "--address=unix:path={}",
                root.join("bus").display()
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut bus = Self {
            child,
            root,
            address: String::new(),
        };
        let (sender, receiver) = std_mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut address = String::new();
            let result = BufReader::new(stdout).read_line(&mut address);
            let _ = sender.send((result, address));
        });
        let (read, address) = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("private bus startup deadline");
        assert!(read.unwrap() > 0);
        bus.address = address.trim().to_owned();
        assert!(bus.address.starts_with("unix:path="));
        bus
    }
    fn connect(&self) -> Connection {
        Connection::new_address(&self.address).unwrap()
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Watcher {
    stop: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
    registered: std_mpsc::Receiver<String>,
}
impl Watcher {
    fn new(bus: &Bus) -> Self {
        let connection = bus.connect();
        connection
            .request_name("org.kde.StatusNotifierWatcher", false, true, true)
            .unwrap();
        let (sender, registered) = std_mpsc::sync_channel(1);
        let mut cr = Crossroads::new();
        let interface = cr.register("org.kde.StatusNotifierWatcher", |builder| {
            builder.method(
                "RegisterStatusNotifierItem",
                ("service",),
                (),
                move |_, _: &mut (), (service,): (String,)| {
                    sender.try_send(service).unwrap();
                    Ok(())
                },
            );
        });
        cr.insert("/StatusNotifierWatcher", &[interface], ());
        connection.start_receive(
            MatchRule::new_method_call(),
            Box::new(move |message, connection| {
                cr.handle_message(message, connection).unwrap();
                true
            }),
        );
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let task = thread::spawn(move || {
            while !flag.load(Ordering::Acquire) {
                connection.process(Duration::from_millis(50)).unwrap();
            }
        });
        Self {
            stop,
            task: Some(task),
            registered,
        }
    }
}
impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

type LoopResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;
struct Loop {
    stop: Option<watch::Sender<bool>>,
    snapshots: watch::Sender<Snapshot>,
    _feedback: watch::Sender<Option<&'static str>>,
    requests: mpsc::Receiver<ReviewRequest>,
    busy: Arc<AtomicBool>,
    finished: std_mpsc::Receiver<LoopResult>,
    task: Option<JoinHandle<()>>,
}
impl Loop {
    fn new(bus: &Bus) -> Self {
        Self::seeded(bus, Snapshot::default())
    }
    fn seeded(bus: &Bus, initial: Snapshot) -> Self {
        let connection = bus.connect();
        let (snapshots, receiver) = watch::channel(initial);
        let (reviews, requests) = mpsc::channel(1);
        let (stop, stopped) = watch::channel(false);
        let (feedback, messages) = watch::channel(None);
        let busy = Arc::new(AtomicBool::new(false));
        let flag = busy.clone();
        let (sender, finished) = std_mpsc::sync_channel(1);
        let task = thread::spawn(move || {
            let result = run_on(connection, receiver, reviews, stopped, flag, true, messages);
            let _ = sender.send(result);
        });
        Self {
            stop: Some(stop),
            snapshots,
            _feedback: feedback,
            requests,
            busy,
            finished,
            task: Some(task),
        }
    }
    fn finish(&mut self) -> LoopResult {
        let result = self
            .finished
            .recv_timeout(Duration::from_secs(6))
            .expect("private tray loop exit deadline");
        self.task.take().unwrap().join().unwrap();
        result
    }
}
impl Drop for Loop {
    fn drop(&mut self) {
        if let Some(stop) = &self.stop {
            stop.send_replace(true);
        }
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

fn snapshot(grant: &str) -> Snapshot {
    let row: AccessEntry = serde_json::from_value(serde_json::json!({
        "grant": grant, "collection": "private-collection-not-displayed", "app_id": "fixture",
        "app_name": "Fixture", "client_pk": "00", "capabilities": [],
        "state": "pending_approval", "first_seen_ms": 0, "acknowledged": false
    }))
    .unwrap();
    let mut snapshot = Snapshot::default();
    snapshot.model.replace(&[row]);
    snapshot
}

fn ids(connection: &Connection, service: &str) -> Vec<i32> {
    let (_, layout): (u32, Layout) = connection
        .with_proxy(service, MENU, Duration::from_secs(2))
        .method_call(MENU_IFACE, "GetLayout", (0i32, -1i32, Vec::<String>::new()))
        .unwrap();
    assert!(layout.2.len() <= super::super::MAX_PREVIEWS + 4);
    layout
        .2
        .into_iter()
        .map(|row| {
            i32::try_from(row.0.as_iter().unwrap().next().unwrap().as_i64().unwrap()).unwrap()
        })
        .collect()
}
fn wait_ids(
    connection: &Connection,
    service: &str,
    predicate: impl Fn(&[i32]) -> bool,
) -> Vec<i32> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let ids = ids(connection, service);
        if predicate(&ids) {
            return ids;
        }
        assert!(Instant::now() < deadline, "private menu refresh deadline");
        thread::sleep(Duration::from_millis(20));
    }
}
fn click(connection: &Connection, service: &str, id: i32) {
    let _: () = connection
        .with_proxy(service, MENU, Duration::from_secs(2))
        .method_call(
            MENU_IFACE,
            "Event",
            (
                id,
                "clicked".to_owned(),
                Variant("ignored-untrusted-data".to_owned()),
                0u32,
            ),
        )
        .unwrap();
}

#[test]
fn private_bus_registers_and_live_menu_rechecks_and_quits() {
    let mut bus = Bus::new();
    let watcher = Watcher::new(&bus);
    let mut ui = Loop::new(&bus);
    let service = watcher
        .registered
        .recv_timeout(Duration::from_secs(6))
        .unwrap();
    assert!(service.starts_with(':'));
    let client = bus.connect();
    let (properties,): (PropMap,) = client
        .with_proxy(service.as_str(), ITEM, Duration::from_secs(2))
        .method_call(
            "org.freedesktop.DBus.Properties",
            "GetAll",
            ("org.kde.StatusNotifierItem",),
        )
        .unwrap();
    assert_eq!(properties["Id"].0.as_str(), Some("mdbase"));
    assert_eq!(properties["Menu"].0.as_str(), Some(MENU));
    assert!(!format!("{properties:?}").contains("private-collection"));
    ui.snapshots.send_replace(snapshot("first"));
    let shown = wait_ids(&client, &service, |ids| ids.iter().any(|id| *id >= 100));
    let first = *shown.iter().find(|id| **id >= 100).unwrap();
    for _ in 0..3 {
        click(&client, &service, first);
    }
    let request = ui.requests.try_recv().unwrap();
    assert_eq!(request.method(), crate::control::Method::ACCESS_APPROVE);
    assert_eq!(request.params(), serde_json::json!({"grant": "first"}));
    assert!(ui.requests.try_recv().is_err());
    assert!(ui.busy.load(Ordering::Acquire));
    ui.busy.store(false, Ordering::Release);
    ui.snapshots.send_replace(Snapshot::default());
    click(&client, &service, first);
    assert!(ui.requests.try_recv().is_err());
    wait_ids(&client, &service, |ids| ids.len() == 2);
    ui.snapshots.send_replace(snapshot("second"));
    let shown = wait_ids(&client, &service, |ids| ids.iter().any(|id| *id >= 100));
    let second = *shown.iter().find(|id| **id >= 100).unwrap();
    assert_ne!(first, second);
    click(&client, &service, first);
    assert!(ui.requests.try_recv().is_err());
    click(&client, &service, second);
    assert_eq!(
        ui.requests.try_recv().unwrap().params(),
        serde_json::json!({"grant": "second"})
    );
    click(&client, &service, super::super::menu::QUIT);
    ui.finish().unwrap();
    // The UI closed its own connection, not the private bus/service infrastructure.
    assert!(bus.child.try_wait().unwrap().is_none());
}

#[test]
fn preloaded_snapshot_is_visible_at_registration_without_a_later_tick() {
    let bus = Bus::new();
    let watcher = Watcher::new(&bus);
    let mut ui = Loop::seeded(&bus, snapshot("preloaded"));
    let service = watcher
        .registered
        .recv_timeout(Duration::from_secs(6))
        .unwrap();
    let client = bus.connect();
    let shown = ids(&client, &service);
    assert_eq!(shown.len(), 3);
    let id = *shown
        .iter()
        .find(|id| **id >= 100)
        .expect("preloaded review row");
    click(&client, &service, id);
    assert_eq!(
        ui.requests.try_recv().unwrap().params(),
        serde_json::json!({"grant": "preloaded"})
    );
    click(&client, &service, super::super::menu::QUIT);
    ui.finish().unwrap();
}

#[test]
fn missing_private_tray_host_fails_without_a_review_request() {
    let mut bus = Bus::new();
    let mut ui = Loop::new(&bus);
    ui.snapshots.send_replace(snapshot("pending"));
    assert!(ui.finish().is_err());
    assert!(ui.requests.try_recv().is_err());
    assert!(!ui.busy.load(Ordering::Acquire));
    assert!(bus.child.try_wait().unwrap().is_none());
}

#[test]
fn losing_stop_owner_exits_the_private_loop() {
    let mut bus = Bus::new();
    let watcher = Watcher::new(&bus);
    let mut ui = Loop::new(&bus);
    let _ = watcher
        .registered
        .recv_timeout(Duration::from_secs(6))
        .unwrap();
    drop(ui.stop.take());
    ui.finish().unwrap();
    assert!(bus.child.try_wait().unwrap().is_none());
}
