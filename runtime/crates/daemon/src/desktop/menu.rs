//! Platform-neutral, bounded tray menu. Action IDs are never re-used while the
//! process lives, so a delayed click cannot become a request for a different app.

use super::{CompanionModel, HoldChoice, ReviewRequest};
use crate::access::AccessState;

pub(crate) const QUIT: i32 = 1;
const FIRST_DYNAMIC: i32 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Row {
    pub id: i32,
    pub label: String,
    pub enabled: bool,
    grant: Option<String>,
    hold: Option<(String, String, HoldChoice)>,
}

pub(crate) enum Action {
    Review(ReviewRequest),
    Quit,
}

pub(crate) struct Menu {
    model: CompanionModel,
    rows: Vec<Row>,
    next_id: i32,
    revision: u32,
    isolated: bool,
    feedback: Option<&'static str>,
}

impl Menu {
    pub fn new(isolated: bool) -> Self {
        let mut menu = Self {
            model: CompanionModel::default(),
            rows: Vec::new(),
            next_id: FIRST_DYNAMIC,
            revision: 0,
            isolated,
            feedback: None,
        };
        menu.render();
        menu
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }
    pub fn revision(&self) -> u32 {
        self.revision
    }

    /// Refresh only when presentation changes, not on every subscription tick.
    pub fn update(&mut self, model: &CompanionModel) -> bool {
        if self.model.connected() == model.connected()
            && self.model.rows() == model.rows()
            && self.model.omitted() == model.omitted()
            && self.model.holds() == model.holds()
            && self.model.holds_omitted() == model.holds_omitted()
        {
            return false;
        }
        self.model = model.clone();
        self.render();
        true
    }

    pub fn feedback(&mut self, message: Option<&'static str>) -> bool {
        if self.feedback == message {
            return false;
        }
        self.feedback = message;
        self.render();
        true
    }

    fn render(&mut self) {
        self.rows.clear();
        let profile = if self.isolated {
            "isolated profile"
        } else {
            "installed profile"
        };
        let status = if self.model.connected() {
            "connected"
        } else {
            "daemon offline"
        };
        self.rows.push(Row {
            id: 2,
            label: format!("mdbase — {profile} — {status}"),
            enabled: false,
            grant: None,
            hold: None,
        });
        if let Some(message) = self.feedback {
            self.rows.push(Row {
                id: 5,
                label: message.to_owned(),
                enabled: false,
                grant: None,
                hold: None,
            });
        }
        for entry in self.model.rows() {
            // Exhaustion disables access actions rather than recycling a token.
            let Some(next) = self.next_id.checked_add(1) else {
                self.rows.push(Row {
                    id: 4,
                    label: "Review menu exhausted — restart companion".to_owned(),
                    enabled: false,
                    grant: None,
                    hold: None,
                });
                break;
            };
            let pending = entry.state == AccessState::PendingApproval;
            let prefix = match entry.state {
                AccessState::PendingApproval => "Request review",
                AccessState::Active => "Active app",
                AccessState::Denied => "Denied app",
                AccessState::RevokedLocally => "Revoked app",
            };
            self.rows.push(Row {
                id: self.next_id,
                label: format!("{prefix}: {}", entry.label),
                enabled: self.model.connected() && pending,
                grant: pending.then(|| entry.grant.clone()),
                hold: None,
            });
            self.next_id = next;
        }
        for hold in self.model.holds() {
            // One header plus three choices per protected file; exhaustion disables
            // the choices rather than recycling a token.
            let Some(next) = self.next_id.checked_add(4) else {
                self.rows.push(Row {
                    id: 4,
                    label: "Menu exhausted — restart companion".to_owned(),
                    enabled: false,
                    grant: None,
                    hold: None,
                });
                break;
            };
            self.rows.push(Row {
                id: self.next_id,
                label: format!("Protected: {} — {}", hold.path, hold.cause.text()),
                enabled: false,
                grant: None,
                hold: None,
            });
            for (offset, (label, choice)) in [
                ("    Keep mine", HoldChoice::KeepMine),
                ("    Take theirs", HoldChoice::TakeTheirs),
                ("    Compare in app", HoldChoice::Compare),
            ]
            .into_iter()
            .enumerate()
            {
                self.rows.push(Row {
                    id: self.next_id + 1 + offset as i32,
                    label: label.to_owned(),
                    enabled: self.model.connected(),
                    grant: None,
                    hold: Some((hold.collection.clone(), hold.id.clone(), choice)),
                });
            }
            self.next_id = next;
        }
        if self.model.holds_omitted() > 0 {
            self.rows.push(Row {
                id: 6,
                label: format!(
                    "{} more protected files — use mdbase holds",
                    self.model.holds_omitted()
                ),
                enabled: false,
                grant: None,
                hold: None,
            });
        }
        if self.model.omitted() > 0 {
            self.rows.push(Row {
                id: 3,
                label: format!(
                    "{} additional entries — use mdbase access list",
                    self.model.omitted()
                ),
                enabled: false,
                grant: None,
                hold: None,
            });
        }
        self.rows.push(Row {
            id: QUIT,
            label: "Quit companion (daemon keeps running)".to_owned(),
            enabled: true,
            grant: None,
            hold: None,
        });
        self.revision = self.revision.wrapping_add(1);
    }

    /// Recheck the latest subscription at click time, not only the rendered menu.
    /// Native consent still belongs to the daemon, regardless of the event source.
    pub fn action(&self, id: i32, latest: &CompanionModel) -> Option<Action> {
        if id == QUIT {
            return Some(Action::Quit);
        }
        let row = self.rows.iter().find(|row| row.id == id && row.enabled)?;
        if let Some((collection, hold, choice)) = &row.hold {
            return latest
                .resolve(collection, hold, *choice)
                .map(Action::Review);
        }
        latest.review(row.grant.as_deref()?).map(Action::Review)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::AccessEntry;

    fn entry(id: &str) -> AccessEntry {
        serde_json::from_value(serde_json::json!({
            "grant": id, "collection": "fixture", "app_id": "fixture", "app_name": "Fixture app",
            "client_pk": "00", "capabilities": [], "state": "pending_approval",
            "first_seen_ms": 0, "acknowledged": false
        }))
        .unwrap()
    }

    #[test]
    fn delayed_click_never_selects_a_replacement_grant() {
        let mut model = CompanionModel::default();
        model.replace(&[entry("first")]);
        let mut menu = Menu::new(true);
        assert!(menu.update(&model));
        let old_id = menu
            .rows()
            .iter()
            .find(|row| row.enabled && row.id != QUIT)
            .unwrap()
            .id;
        match menu.action(old_id, &model).unwrap() {
            Action::Review(request) => {
                assert_eq!(request.params(), serde_json::json!({"grant": "first"}))
            }
            Action::Quit => panic!("expected review request"),
        }
        model.replace(&[entry("second")]);
        menu.update(&model);
        assert!(menu.action(old_id, &model).is_none());
        let new_id = menu
            .rows()
            .iter()
            .find(|row| row.enabled && row.id != QUIT)
            .unwrap()
            .id;
        assert_ne!(old_id, new_id);
        assert!(matches!(
            menu.action(new_id, &model),
            Some(Action::Review(_))
        ));
    }

    #[test]
    fn latest_disconnect_or_revocation_disables_a_still_rendered_action() {
        let mut model = CompanionModel::default();
        model.replace(&[entry("first")]);
        let mut menu = Menu::new(false);
        menu.update(&model);
        let id = menu
            .rows()
            .iter()
            .find(|row| row.enabled && row.id != QUIT)
            .unwrap()
            .id;
        let mut revoked = entry("first");
        revoked.state = AccessState::RevokedLocally;
        model.replace(&[revoked]);
        assert!(menu.action(id, &model).is_none());
        model.disconnect();
        assert!(menu.action(id, &model).is_none());
        assert!(matches!(menu.action(QUIT, &model), Some(Action::Quit)));
    }

    #[test]
    fn menu_is_bounded_and_marks_the_profile_and_omitted_rows() {
        let mut model = CompanionModel::default();
        let rows: Vec<_> = (0..100).map(|n| entry(&format!("grant-{n}"))).collect();
        model.replace(&rows);
        let mut menu = Menu::new(true);
        menu.update(&model);
        assert_eq!(menu.rows().len(), super::super::MAX_PREVIEWS + 3);
        assert!(menu.rows()[0].label.contains("isolated profile"));
        assert!(
            menu.rows()
                .iter()
                .any(|row| row.label.starts_with("68 additional"))
        );
        assert!(menu.action(-1, &model).is_none());
        assert!(menu.action(i32::MAX, &model).is_none());
        let revision = menu.revision();
        assert!(!menu.update(&model));
        assert_eq!(menu.revision(), revision);
        assert!(menu.feedback(Some("Review pending — check daemon dialog")));
        assert!(!menu.feedback(Some("Review pending — check daemon dialog")));
        assert!(!menu.rows().iter().find(|row| row.id == 5).unwrap().enabled);
    }

    #[test]
    fn protected_files_offer_keep_take_and_compare_only_while_displayed() {
        use super::super::{HoldCause, HoldPreview};
        let hold = HoldPreview {
            collection: "col-1".to_owned(),
            id: "rec-1".to_owned(),
            path: "notes/plan.md".to_owned(),
            cause: HoldCause::Conflict,
        };
        let mut model = CompanionModel::default();
        model.replace(&[]);
        model.replace_holds(std::slice::from_ref(&hold));
        let mut menu = Menu::new(true);
        assert!(menu.update(&model));
        let header = menu
            .rows()
            .iter()
            .find(|row| row.label.starts_with("Protected: notes/plan.md"))
            .unwrap();
        assert!(!header.enabled);
        assert!(header.label.contains("another device changed it"));
        let choices: Vec<&Row> = menu
            .rows()
            .iter()
            .filter(|row| row.hold.is_some())
            .collect();
        assert_eq!(choices.len(), 3);
        match menu.action(choices[0].id, &model).unwrap() {
            Action::Review(request) => {
                assert_eq!(
                    request.method(),
                    crate::control::Method::COLLECTION_RESOLVE_HOLD
                );
                assert_eq!(
                    request.params(),
                    serde_json::json!({"collection": "col-1", "id": "rec-1", "how": "keep_mine"})
                );
                assert!(request.compare_link().is_none());
            }
            Action::Quit => panic!("expected a resolution"),
        }
        match menu.action(choices[2].id, &model).unwrap() {
            Action::Review(request) => assert_eq!(
                request.compare_link().as_deref(),
                Some("mdbase://hold/compare?collection=col-1&id=rec-1")
            ),
            Action::Quit => panic!("expected a compare hand-off"),
        }
        // Gone from the latest snapshot: the rendered row no longer acts.
        model.replace_holds(&[]);
        assert!(menu.action(choices[1].id, &model).is_none());
        model.replace_holds(std::slice::from_ref(&hold));
        model.disconnect();
        assert!(menu.action(choices[1].id, &model).is_none());
    }

    #[test]
    fn action_id_exhaustion_does_not_recycle_old_ids() {
        let mut menu = Menu::new(false);
        menu.next_id = i32::MAX;
        let mut model = CompanionModel::default();
        model.replace(&[entry("first")]);
        menu.update(&model);
        assert_eq!(menu.rows().len(), 3);
        assert!(
            menu.rows()
                .iter()
                .any(|row| row.label.contains("menu exhausted"))
        );
        assert!(menu.action(i32::MAX, &model).is_none());
        assert!(menu.rows()[0].label.contains("installed profile"));
    }
}
