//! Native message ingress and lifetime allocation bounds, testable without a GUI.

pub(super) const CLICK_CAPACITY: usize = 8;
const ITEM_BUDGET: usize = 60_000;

// Windows muda IDs start at1000 and WM_COMMAND carries16bits. Count the menu
// container as well as its rows. This process creates no other muda menus.
#[derive(Default)]
pub(super) struct Budget(usize);
impl Budget {
    pub fn take(&mut self, rows: usize) -> bool {
        let Some(next) = rows
            .checked_add(1)
            .and_then(|n| self.0.checked_add(n))
            .filter(|n| *n <= ITEM_BUDGET)
        else {
            return false;
        };
        self.0 = next;
        true
    }
}

pub(super) fn click_id(text: &str) -> Option<i32> {
    if text.len() > 18 {
        return None;
    }
    let digits = text.strip_prefix("mdbase-")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id = digits.parse::<i32>().ok()?;
    if id.to_string() != digits || (id != 1 && id < 100) {
        return None;
    }
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_accounts_for_every_container_and_never_wraps() {
        let mut budget = Budget::default();
        assert!(budget.take(ITEM_BUDGET - 1));
        assert!(!budget.take(0));
        assert!(!budget.take(usize::MAX));
        assert_eq!(budget.0, ITEM_BUDGET);
        assert_eq!(CLICK_CAPACITY, 8);
    }
    #[test]
    fn refused_allocation_does_not_reset_consumed_ids() {
        let mut budget = Budget::default();
        assert!(budget.take(3));
        assert!(!budget.take(ITEM_BUDGET));
        assert_eq!(budget.0, 4);
        assert!(budget.take(ITEM_BUDGET - 5));
        assert!(!budget.take(0));
    }
    #[test]
    fn native_clicks_accept_only_our_canonical_bounded_action_ids() {
        assert_eq!(click_id("mdbase-1"), Some(1));
        assert_eq!(click_id("mdbase-100"), Some(100));
        assert_eq!(click_id("mdbase-2147483647"), Some(i32::MAX));
        for text in [
            "",
            "1",
            "other-100",
            "mdbase-2",
            "mdbase-99",
            "mdbase-0100",
            "mdbase-+100",
            "mdbase--100",
            "mdbase-2147483648",
            "mdbase-100suffix",
        ] {
            assert_eq!(click_id(text), None, "{text}");
        }
    }
}
