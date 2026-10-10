//! Actual D-Bus message marshalling/handler tests without the person's bus or UI.
use super::*;
use crate::access::AccessEntry;

#[derive(Default)]
struct Replies(Mutex<Vec<dbus::Message>>);
impl Sender for Replies {
    fn send(&self, message: dbus::Message) -> Result<u32, ()> {
        self.0.lock().unwrap().push(message);
        Ok(1)
    }
}

fn snapshot() -> Snapshot {
    let row: AccessEntry = serde_json::from_value(serde_json::json!({
        "grant": "pending", "collection": "private", "app_id": "fixture",
        "app_name": "Fixture", "client_pk": "00", "capabilities": [],
        "state": "pending_approval", "first_seen_ms": 0, "acknowledged": false
    }))
    .unwrap();
    let mut state = Snapshot::default();
    state.model.replace(&[row]);
    state
}

fn setup() -> (
    Crossroads,
    watch::Sender<Snapshot>,
    mpsc::Receiver<ReviewRequest>,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
) {
    let initial = snapshot();
    let (sender, receiver) = watch::channel(initial.clone());
    let (reviews, requests) = mpsc::channel(1);
    let menu = Arc::new(Mutex::new(Menu::new(true)));
    menu.lock().unwrap().update(&initial.model);
    let busy = Arc::new(AtomicBool::new(false));
    let quit = Arc::new(AtomicBool::new(false));
    let mut cr = Crossroads::new();
    let menu_iface = menu_interface(&mut cr);
    let item = item_interface(&mut cr);
    cr.insert(
        MENU,
        &[menu_iface],
        State {
            menu,
            snapshot: receiver,
            reviews,
            busy: busy.clone(),
            quit: quit.clone(),
        },
    );
    cr.insert(ITEM, &[item], ());
    (cr, sender, requests, busy, quit)
}

fn call(
    cr: &mut Crossroads,
    path: &str,
    iface: &str,
    method: &str,
    append: impl FnOnce(dbus::Message) -> dbus::Message,
) -> dbus::Message {
    let mut message =
        append(dbus::Message::new_method_call("dev.mdbase.Test", path, iface, method).unwrap());
    message.set_serial(1);
    let replies = Replies::default();
    cr.handle_message(message, &replies).unwrap();
    let mut messages = replies.0.lock().unwrap();
    assert_eq!(messages.len(), 1);
    messages.pop().unwrap()
}

#[test]
fn flat_menu_layout_has_the_protocol_signature_and_bounded_actions() {
    let (mut cr, _sender, _requests, _busy, _quit) = setup();
    let reply = call(&mut cr, MENU, MENU_IFACE, "GetLayout", |message| {
        message.append3(0i32, i32::MAX, Vec::<String>::new())
    });
    assert_eq!(reply.msg_type(), dbus::MessageType::MethodReturn);
    let (revision, layout): (u32, Layout) = reply.read2().unwrap();
    assert!(revision > 0);
    assert_eq!(layout.0, 0);
    assert_eq!(layout.2.len(), 3);
    assert_eq!(layout.1["children-display"].0.as_str(), Some("submenu"));
    for child in layout.2 {
        assert_eq!(child.0.signature().to_string(), "(ia{sv}av)");
    }
    let unknown = call(&mut cr, MENU, MENU_IFACE, "GetLayout", |message| {
        message.append3(i32::MIN, -1i32, Vec::<String>::new())
    });
    assert_eq!(unknown.msg_type(), dbus::MessageType::Error);
}

#[test]
fn clicks_are_bounded_requests_not_confirmation_answers() {
    let (mut cr, sender, mut requests, busy, quit) = setup();
    for _ in 0..3 {
        let reply = call(&mut cr, MENU, MENU_IFACE, "Event", |message| {
            message
                .append3(
                    100i32,
                    "clicked".to_owned(),
                    Variant("arbitrary-untrusted-data".to_owned()),
                )
                .append1(0u32)
        });
        assert_eq!(reply.msg_type(), dbus::MessageType::MethodReturn);
    }
    let request = requests.try_recv().unwrap();
    assert_eq!(request.method(), crate::control::Method::ACCESS_APPROVE);
    assert_eq!(request.params(), serde_json::json!({"grant": "pending"}));
    assert!(requests.try_recv().is_err());
    assert!(busy.load(Ordering::Acquire));
    assert!(!quit.load(Ordering::Acquire));
    busy.store(false, Ordering::Release);
    let mut offline = snapshot();
    offline.model.disconnect();
    sender.send_replace(offline);
    call(&mut cr, MENU, MENU_IFACE, "Event", |message| {
        message
            .append3(100i32, "clicked".to_owned(), Variant(0i32))
            .append1(0u32)
    });
    assert!(requests.try_recv().is_err());
    assert!(!busy.load(Ordering::Acquire));
    call(&mut cr, MENU, MENU_IFACE, "Event", |message| {
        message
            .append3(
                super::super::menu::QUIT,
                "clicked".to_owned(),
                Variant(0i32),
            )
            .append1(0u32)
    });
    assert!(quit.load(Ordering::Acquire));
}

#[test]
fn event_groups_are_bounded_and_report_unknown_ids() {
    let (mut cr, _sender, mut requests, _busy, _quit) = setup();
    let reply = call(&mut cr, MENU, MENU_IFACE, "EventGroup", |message| {
        message.append1(vec![
            (100i32, "clicked".to_owned(), Variant(0i32), 0u32),
            (999i32, "clicked".to_owned(), Variant(0i32), 0u32),
        ])
    });
    assert_eq!(reply.read1::<Vec<i32>>().unwrap(), vec![999]);
    assert!(requests.try_recv().is_ok());
    let reply = call(&mut cr, MENU, MENU_IFACE, "AboutToShowGroup", |message| {
        message.append1(vec![0i32, 100i32, -1i32])
    });
    assert_eq!(
        reply.read2::<Vec<i32>, Vec<i32>>().unwrap(),
        (vec![], vec![-1])
    );
}

#[test]
fn item_properties_expose_only_static_identity_and_an_owned_menu() {
    let (mut cr, _sender, _requests, _busy, _quit) = setup();
    let reply = call(
        &mut cr,
        ITEM,
        "org.freedesktop.DBus.Properties",
        "GetAll",
        |message| message.append1("org.kde.StatusNotifierItem".to_owned()),
    );
    let properties = reply.read1::<PropMap>().unwrap();
    assert_eq!(properties["Id"].0.as_str(), Some("mdbase"));
    assert_eq!(properties["Menu"].0.as_str(), Some(MENU));
    assert_eq!(properties["WindowId"].0.as_u64(), Some(0));
    assert!(!format!("{properties:?}").contains("private"));
}
