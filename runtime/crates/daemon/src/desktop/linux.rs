//! Linux StatusNotifierItem/DBusMenu server. Uses the already approved D-Bus
//! family directly instead of introducing KSNI's policy-rejected license.

use super::{
    ReviewRequest, Snapshot,
    menu::{Action, Menu},
};
use dbus::{
    arg::{PropMap, RefArg, Variant},
    blocking::Connection,
    channel::{MatchingReceiver, Sender},
    message::MatchRule,
};
use dbus_crossroads::{Crossroads, IfaceToken, MethodErr};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

const ITEM: &str = "/StatusNotifierItem";
const MENU: &str = "/MenuBar";
const MENU_IFACE: &str = "com.canonical.dbusmenu";
type Layout = (i32, PropMap, Vec<Variant<Box<dyn RefArg>>>);
type MenuEvent = (i32, String, Variant<Box<dyn RefArg>>, u32);

struct State {
    menu: Arc<Mutex<Menu>>,
    snapshot: watch::Receiver<Snapshot>,
    reviews: mpsc::Sender<ReviewRequest>,
    busy: Arc<AtomicBool>,
    quit: Arc<AtomicBool>,
}

fn properties(label: &str, enabled: bool) -> PropMap {
    let mut props = PropMap::new();
    props.insert("label".to_owned(), Variant(Box::new(label.to_owned())));
    props.insert("enabled".to_owned(), Variant(Box::new(enabled)));
    props.insert("visible".to_owned(), Variant(Box::new(true)));
    props
}

fn filter(mut properties: PropMap, requested: &[String]) -> PropMap {
    if !requested.is_empty() {
        properties.retain(|name, _| requested.iter().take(16).any(|item| item == name));
    }
    properties
}

fn layout(menu: &Menu, parent: i32, depth: i32, requested: &[String]) -> Result<Layout, MethodErr> {
    if parent == 0 {
        let children = if depth == 0 {
            Vec::new()
        } else {
            menu.rows()
                .iter()
                .map(|row| {
                    Variant(Box::new((
                        row.id,
                        filter(properties(&row.label, row.enabled), requested),
                        Vec::<Variant<Box<dyn RefArg>>>::new(),
                    )) as Box<dyn RefArg>)
                })
                .collect()
        };
        let mut props = properties("mdbase", false);
        props.insert(
            "children-display".to_owned(),
            Variant(Box::new("submenu".to_owned())),
        );
        return Ok((0, filter(props, requested), children));
    }
    let row = menu
        .rows()
        .iter()
        .find(|row| row.id == parent)
        .ok_or_else(|| MethodErr::invalid_arg(&parent))?;
    Ok((
        parent,
        filter(properties(&row.label, row.enabled), requested),
        Vec::new(),
    ))
}

fn event(state: &State, id: i32, kind: &str) {
    if kind != "clicked" {
        return;
    }
    let snapshot = state.snapshot.borrow();
    let action = state.menu.lock().unwrap().action(id, &snapshot.model);
    match action {
        Some(Action::Quit) => {
            state.quit.store(true, Ordering::Release);
        }
        Some(Action::Review(request)) => {
            if state
                .busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
                && state.reviews.try_send(request).is_err()
            {
                state.busy.store(false, Ordering::Release);
            }
        }
        None => {}
    }
}

fn menu_interface(cr: &mut Crossroads) -> IfaceToken<State> {
    cr.register(MENU_IFACE, |b| {
        b.property::<u32, _>("Version").get(|_, _| Ok(3));
        b.property::<String, _>("TextDirection")
            .get(|_, _| Ok("ltr".to_owned()));
        b.property::<String, _>("Status")
            .get(|_, _| Ok("normal".to_owned()));
        b.property::<Vec<String>, _>("IconThemePath")
            .get(|_, _| Ok(Vec::new()));
        b.signal::<(u32, i32), _>("LayoutUpdated", ("revision", "parent"));
        b.method(
            "GetLayout",
            ("parentId", "recursionDepth", "propertyNames"),
            ("revision", "layout"),
            |_, state: &mut State, (parent, depth, names): (i32, i32, Vec<String>)| {
                let menu = state.menu.lock().unwrap();
                Ok((menu.revision(), layout(&menu, parent, depth, &names)?))
            },
        );
        b.method(
            "GetGroupProperties",
            ("ids", "propertyNames"),
            ("properties",),
            |_, state: &mut State, (ids, names): (Vec<i32>, Vec<String>)| {
                let menu = state.menu.lock().unwrap();
                let result: Vec<(i32, PropMap)> = menu
                    .rows()
                    .iter()
                    .filter(|row| ids.is_empty() || ids.iter().take(64).any(|id| *id == row.id))
                    .map(|row| (row.id, filter(properties(&row.label, row.enabled), &names)))
                    .collect();
                Ok((result,))
            },
        );
        b.method(
            "GetProperty",
            ("id", "name"),
            ("property",),
            |_, state: &mut State, (id, name): (i32, String)| {
                let menu = state.menu.lock().unwrap();
                let (_, mut props, _) = layout(&menu, id, 0, &[])?;
                Ok((props
                    .remove(&name)
                    .ok_or_else(|| MethodErr::invalid_arg(&name))?,))
            },
        );
        b.method(
            "Event",
            ("id", "eventId", "data", "timestamp"),
            (),
            |_, state: &mut State, (id, kind, _, _): MenuEvent| {
                event(state, id, &kind);
                Ok(())
            },
        );
        b.method(
            "EventGroup",
            ("events",),
            ("idErrors",),
            |_, state: &mut State, (events,): (Vec<MenuEvent>,)| {
                let mut errors = Vec::new();
                for (id, kind, _, _) in events.into_iter().take(64) {
                    let known = state
                        .menu
                        .lock()
                        .unwrap()
                        .rows()
                        .iter()
                        .any(|row| row.id == id);
                    if known {
                        event(state, id, &kind);
                    } else {
                        errors.push(id);
                    }
                }
                Ok((errors,))
            },
        );
        b.method(
            "AboutToShowGroup",
            ("ids",),
            ("updatesNeeded", "idErrors"),
            |_, state: &mut State, (ids,): (Vec<i32>,)| {
                let menu = state.menu.lock().unwrap();
                let errors: Vec<i32> = ids
                    .into_iter()
                    .take(64)
                    .filter(|id| *id != 0 && !menu.rows().iter().any(|row| row.id == *id))
                    .collect();
                Ok((Vec::<i32>::new(), errors))
            },
        );
        b.method(
            "AboutToShow",
            ("id",),
            ("needsUpdate",),
            |_, _: &mut State, (_id,): (i32,)| Ok((false,)),
        );
    })
}

fn item_interface(cr: &mut Crossroads) -> IfaceToken<()> {
    cr.register("org.kde.StatusNotifierItem", |b| {
        for (name, value) in [
            ("Category", "ApplicationStatus"),
            ("Id", "mdbase"),
            ("Title", "mdbase"),
            ("Status", "Active"),
            ("IconName", "folder-sync"),
            ("AttentionIconName", "dialog-warning"),
        ] {
            b.property::<String, _>(name)
                .get(move |_, _| Ok(value.to_owned()));
        }
        b.property::<u32, _>("WindowId").get(|_, _| Ok(0));
        b.property::<Vec<(i32, i32, Vec<u8>)>, _>("IconPixmap")
            .get(|_, _| Ok(vec![(16, 16, [255u8, 32, 92, 180].repeat(256))]));
        b.property::<bool, _>("ItemIsMenu").get(|_, _| Ok(true));
        b.property::<dbus::Path<'static>, _>("Menu")
            .get(|_, _| Ok(dbus::Path::new(MENU).unwrap()));
        b.method(
            "Activate",
            ("x", "y"),
            (),
            |_, _: &mut (), (_, _): (i32, i32)| Ok(()),
        );
        b.method(
            "ContextMenu",
            ("x", "y"),
            (),
            |_, _: &mut (), (_, _): (i32, i32)| Ok(()),
        );
    })
}

pub(super) fn run(
    snapshot: watch::Receiver<Snapshot>,
    reviews: mpsc::Sender<ReviewRequest>,
    stop: watch::Receiver<bool>,
    busy: Arc<AtomicBool>,
    isolated: bool,
    feedback: watch::Receiver<Option<&'static str>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run_on(
        Connection::new_session()?,
        snapshot,
        reviews,
        stop,
        busy,
        isolated,
        feedback,
    )
}

// Private connection seam for an isolated test bus; production always uses the
// session connection above. No profile, credential or approval policy override.
fn run_on(
    connection: Connection,
    mut snapshot: watch::Receiver<Snapshot>,
    reviews: mpsc::Sender<ReviewRequest>,
    stop: watch::Receiver<bool>,
    busy: Arc<AtomicBool>,
    isolated: bool,
    mut feedback: watch::Receiver<Option<&'static str>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut cr = Crossroads::new();
    // Consume the current watch value before registration. A preloaded snapshot
    // is already current, so has_changed() alone would never render it.
    let mut initial = Menu::new(isolated);
    initial.update(&snapshot.borrow_and_update().model);
    initial.feedback(*feedback.borrow_and_update());
    let menu = Arc::new(Mutex::new(initial));
    let quit = Arc::new(AtomicBool::new(false));
    let item = item_interface(&mut cr);
    let menu_iface = menu_interface(&mut cr);
    cr.insert(ITEM, &[item], ());
    cr.insert(
        MENU,
        &[menu_iface],
        State {
            menu: menu.clone(),
            snapshot: snapshot.clone(),
            reviews,
            busy,
            quit: quit.clone(),
        },
    );
    connection.start_receive(
        MatchRule::new_method_call(),
        Box::new(move |message, connection| {
            let _ = cr.handle_message(message, connection);
            true
        }),
    );
    // Fixed service/path only; absence of a tray host is an explicit startup error.
    connection
        .with_proxy(
            "org.kde.StatusNotifierWatcher",
            "/StatusNotifierWatcher",
            Duration::from_secs(5),
        )
        .method_call::<(), _, _, _>(
            "org.kde.StatusNotifierWatcher",
            "RegisterStatusNotifierItem",
            (connection.unique_name().to_string(),),
        )?;
    while !quit.load(Ordering::Acquire) && !*stop.borrow() && stop.has_changed().is_ok() {
        if snapshot.has_changed().unwrap_or(false) || feedback.has_changed().unwrap_or(false) {
            let state = snapshot.borrow_and_update();
            let message = *feedback.borrow_and_update();
            let mut menu = menu.lock().unwrap();
            let changed = menu.update(&state.model);
            if menu.feedback(message) || changed {
                let message = dbus::Message::new_signal(MENU, MENU_IFACE, "LayoutUpdated")
                    .unwrap()
                    .append2(menu.revision(), 0i32);
                let _ = connection.send(message);
            }
        }
        connection.process(Duration::from_millis(100))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "linux/wire_tests.rs"]
mod wire_tests;

#[cfg(test)]
#[path = "linux/bus_tests.rs"]
mod bus_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_depth_never_creates_recursive_or_unbounded_layouts() {
        let menu = Menu::new(true);
        assert!(layout(&menu, 0, 0, &[]).unwrap().2.is_empty());
        for depth in [-1, 1, i32::MAX] {
            assert_eq!(layout(&menu, 0, depth, &[]).unwrap().2.len(), 2);
        }
        assert!(layout(&menu, -1, 0, &[]).is_err());
        assert!(layout(&menu, i32::MAX, 0, &[]).is_err());
        let props = layout(&menu, 0, 0, &["label".to_owned()]).unwrap().1;
        assert_eq!(props.len(), 1);
    }
}
