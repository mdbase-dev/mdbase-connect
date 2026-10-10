//! macOS main-thread / Windows message-pump tray adapter. No window, navigation,
//! generic RPC or native-consent answer is exposed. All click ingress is bounded.

use super::{
    menu::{Action, Menu},
    native_limits::{Budget, CLICK_CAPACITY, click_id},
    runtime::{CompanionError, Views},
};
use std::{
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder,
    menu::{Menu as NativeMenu, MenuEvent, MenuItem},
};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::WindowId,
};

struct App {
    views: Views,
    menu: Menu,
    clicks: mpsc::Receiver<i32>,
    tray: Option<TrayIcon>,
    budget: Budget,
    failed: bool,
}

impl App {
    fn native_menu(&mut self) -> Result<NativeMenu, CompanionError> {
        if !self.budget.take(self.menu.rows().len()) {
            return Err(CompanionError::TrayUnavailable);
        }
        let menu = NativeMenu::new();
        for row in self.menu.rows() {
            let item =
                MenuItem::with_id(format!("mdbase-{}", row.id), &row.label, row.enabled, None);
            menu.append(&item)
                .map_err(|_| CompanionError::TrayUnavailable)?;
        }
        Ok(menu)
    }

    fn refresh(&mut self) -> Result<(), CompanionError> {
        let before = self.menu.revision();
        self.menu
            .update(&self.views.snapshot.borrow_and_update().model);
        self.menu.feedback(*self.views.feedback.borrow_and_update());
        if self.menu.revision() != before {
            let menu = self.native_menu()?;
            if let Some(tray) = &self.tray {
                tray.set_menu(Some(Box::new(menu)));
            }
        }
        Ok(())
    }

    fn fail(&mut self, event_loop: &ActiveEventLoop) {
        self.failed = true;
        event_loop.exit();
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.tray.is_some() {
            return;
        }
        let result = (|| {
            let menu = self.native_menu()?;
            let icon = Icon::from_rgba(super::icon::rgba(), 16, 16)
                .map_err(|_| CompanionError::TrayUnavailable)?;
            let builder = TrayIconBuilder::new()
                .with_id("mdbase-companion")
                .with_tooltip("mdbase — app access review")
                .with_menu(Box::new(menu));
            #[cfg(target_os = "macos")]
            let builder = builder.with_icon_templated(icon);
            #[cfg(target_os = "windows")]
            let builder = builder.with_icon(icon);
            builder.build().map_err(|_| CompanionError::TrayUnavailable)
        })();
        match result {
            Ok(tray) => self.tray = Some(tray),
            Err(_) => self.fail(event_loop),
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if *self.views.stop.borrow() || self.views.stop.has_changed().is_err() {
            event_loop.exit();
            return;
        }
        if self.refresh().is_err() {
            self.fail(event_loop);
            return;
        }
        // A finite per-turn drain avoids both unbounded ingress and starvation.
        for _ in 0..CLICK_CAPACITY {
            let Ok(id) = self.clicks.try_recv() else {
                break;
            };
            let latest = self.views.snapshot.borrow();
            match self.menu.action(id, &latest.model) {
                Some(Action::Quit) => {
                    event_loop.exit();
                    return;
                }
                Some(Action::Review(request)) => {
                    if self
                        .views
                        .busy
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                        && self.views.reviews.try_send(request).is_err()
                    {
                        self.views.busy.store(false, Ordering::Release);
                    }
                }
                None => {}
            }
        }
        // Snapshot/feedback channels are last-value watches; no per-snapshot
        // EventLoopProxy queue. This also observes Ctrl-C without native callbacks.
        event_loop.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_millis(100),
        ));
    }

    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
}

/// Call exactly once on the process's main thread, before an async CLI loop.
pub(super) fn run(views: Views, isolated: bool) -> Result<(), CompanionError> {
    let mut builder = EventLoop::builder();
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        builder
            .with_activation_policy(ActivationPolicy::Accessory)
            .with_default_menu(false)
            .with_activate_ignoring_other_apps(false);
    }
    let event_loop = builder
        .build()
        .map_err(|_| CompanionError::TrayUnavailable)?;
    let (sender, clicks) = mpsc::sync_channel(CLICK_CAPACITY);
    // muda's handler is process-global and one-shot, just like this event loop.
    // Do not use its default unbounded receiver or forward unbounded user events.
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        if let Some(id) = click_id(event.id.as_ref()) {
            let _ = sender.try_send(id);
        }
    }));
    let mut app = App {
        views,
        menu: Menu::new(isolated),
        clicks,
        tray: None,
        budget: Budget::default(),
        failed: false,
    };
    event_loop
        .run_app(&mut app)
        .map_err(|_| CompanionError::TrayUnavailable)?;
    if app.failed {
        Err(CompanionError::TrayUnavailable)
    } else {
        Ok(())
    }
}
