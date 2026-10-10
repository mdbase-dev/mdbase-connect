//! Lifecycle (spec 09) with captured time and seed (`intent.md` §4).
//!
//! Lifecycle assignments run during `api` planning only (`external` sources
//! run none). They never read a clock or entropy:
//! - `{now: true}` is the mutation's `clock.instant_ms` (RFC 3339, ms, `Z`);
//! - `{today: true}` is the mutation's `clock.local_date`;
//! - `{uuid: true}` / `{ulid: true}` draw from the mutation's
//!   generated-value stream ([`GenStream`]), in planner evaluation order: types
//!   in matched order, then actions in list order, then `set` keys in mapping
//!   order. That order is part of the semantics version.
//!
//! Re-planning a mutation therefore reproduces exactly the same values.

use crate::ids::{Uuid, mac};
use crate::intent::OpClock;
use crate::types::{Catalog, LifecycleEvent, Provider};
use crate::value::{Map, Value};

/// The generated-value stream of a mutation (`intent.md` §4.3):
/// `block(i) = MAC(seed, "mdbase/v1/gen", u32be(i))`, concatenated.
#[derive(Debug, Clone)]
pub struct GenStream {
    seed: [u8; 32],
    block: [u8; 32],
    next_block: u32,
    used: u8,
}

impl GenStream {
    /// The stream of `seed`.
    pub fn new(seed: [u8; 32]) -> GenStream {
        GenStream {
            seed,
            block: [0; 32],
            next_block: 0,
            used: 32,
        }
    }

    /// Take `out.len()` bytes from the stream.
    pub fn fill(&mut self, out: &mut [u8]) {
        for byte in out {
            if self.used == 32 {
                self.block = mac(&self.seed, "mdbase/v1/gen", &self.next_block.to_be_bytes());
                self.next_block = self.next_block.wrapping_add(1);
                self.used = 0;
            }
            *byte = self.block[usize::from(self.used)];
            self.used += 1;
        }
    }

    /// A version-4 UUID: 16 bytes, version nibble 4, variant `10`.
    pub fn uuid(&mut self) -> Uuid {
        let mut b = [0u8; 16];
        self.fill(&mut b);
        Uuid::v4_from_bytes(b)
    }

    /// A ULID: the 48-bit `instant_ms` followed by 10 stream bytes, as
    /// upper-case Crockford Base32 (26 characters).
    pub fn ulid(&mut self, instant_ms: i64) -> String {
        let mut b = [0u8; 16];
        let ms = u64::try_from(instant_ms).unwrap_or(0) & 0xffff_ffff_ffff;
        b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
        self.fill(&mut b[6..]);
        crockford_128(u128::from_be_bytes(b))
    }
}

fn crockford_128(v: u128) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    // 26 characters × 5 bits = 130 bits; the top two bits are zero.
    (0..26)
        .rev()
        .map(|i| {
            let idx = (v >> (i * 5)) & 0x1f;
            // `idx` < 32.
            #[allow(clippy::cast_possible_truncation)]
            let idx = idx as usize;
            ALPHABET[idx] as char
        })
        .collect()
}

/// `instant_ms` as RFC 3339 with milliseconds and `Z` (spec 09 `now`).
pub fn rfc3339_ms(instant_ms: i64) -> String {
    let days = instant_ms.div_euclid(86_400_000);
    let ms_of_day = instant_ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let h = ms_of_day / 3_600_000;
    let min = ms_of_day / 60_000 % 60;
    let s = ms_of_day / 1_000 % 60;
    let ms = ms_of_day % 1_000;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{ms:03}Z")
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (y, m, d).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Why lifecycle failed (request tier: always rejects an `api` write).
#[derive(Debug, Clone, PartialEq)]
pub struct LifecycleError {
    /// Spec code (`lifecycle_failed`, `type_conflict`, `expression_error`, ...).
    pub code: String,
    /// Message.
    pub message: String,
    /// The field being assigned.
    pub field: Option<String>,
}

/// Inputs shared by every assignment of one operation.
pub struct LifecycleContext<'a> {
    /// The catalog.
    pub catalog: &'a Catalog,
    /// The matched types (pre-lifecycle membership), in spec order.
    pub types: &'a [String],
    /// The mutation's captured clock.
    pub clock: &'a OpClock,
    /// The mutation's generated-value stream, shared across ops in order.
    pub generated: &'a mut GenStream,
    /// The record's path.
    pub path: &'a str,
    /// The previous frontmatter (updates only).
    pub previous: Option<&'a Map>,
}

/// Run the `event` actions of every matched type over `draft`, returning the
/// frontmatter to write (spec 09).
///
/// - Types run in matched order, each type's actions in list order. A guard
///   reads the draft as modified by the preceding actions; all providers of
///   one `set` read the draft as it was before that action.
/// - Different assignments to one field from different types are
///   `type_conflict`, whether or not their guards would run; identical ones
///   from several types execute once.
/// - Guards are CEL (`crate::cel`).
pub fn run(
    event: LifecycleEvent,
    ctx: LifecycleContext<'_>,
    mut draft: Map,
) -> Result<Map, LifecycleError> {
    let types: Vec<&crate::types::TypeDef> = ctx
        .types
        .iter()
        .filter_map(|n| ctx.catalog.type_named(n))
        .collect();
    // type_conflict: one field assigned differently by two types.
    let mut seen: Vec<(String, &str, &crate::types::LifecycleAction)> = Vec::new();
    for t in &types {
        for action in t.lifecycle.get(&event).into_iter().flatten() {
            for (field, provider) in &action.set {
                if let Some((_, other, other_action)) = seen
                    .iter()
                    .find(|(f, n, _)| f == field && *n != t.name.as_str())
                {
                    let same = other_action.guard == action.guard
                        && other_action
                            .set
                            .iter()
                            .any(|(f, p)| f == field && p == provider);
                    if !same {
                        return Err(LifecycleError {
                            code: "type_conflict".into(),
                            message: format!(
                                "types `{other}` and `{}` assign `{field}` differently",
                                t.name
                            ),
                            field: Some(field.clone()),
                        });
                    }
                }
                seen.push((field.clone(), t.name.as_str(), action));
            }
        }
    }
    let mut done: Vec<&crate::types::LifecycleAction> = Vec::new();
    for t in &types {
        for action in t.lifecycle.get(&event).into_iter().flatten() {
            // An identical action already run for another type runs once.
            if done.contains(&action) {
                continue;
            }
            done.push(action);
            if let Some(guard) = &action.guard
                && !guard_passes(guard, &draft, &ctx, ctx.path, ctx.clock)?
            {
                continue;
            }
            let before = draft.clone();
            let mut values: Vec<(&str, Option<Value>)> = Vec::new();
            for (field, provider) in &action.set {
                let v = match provider {
                    Provider::Now => Some(Value::string(rfc3339_ms(ctx.clock.instant_ms))),
                    Provider::Today => Some(Value::string(ctx.clock.local_date.clone())),
                    Provider::Uuid => Some(Value::string(ctx.generated.uuid().to_string())),
                    Provider::Ulid => Some(Value::string(ctx.generated.ulid(ctx.clock.instant_ms))),
                    Provider::Literal(v) => Some(v.clone()),
                    Provider::Copy(src) => crate::types::select_one(&before, src).cloned(),
                    Provider::Slugify(src) => Some(match crate::types::select_one(&before, src) {
                        Some(Value::Text(s)) => Value::string(slugify(s)),
                        _ => Value::Null,
                    }),
                };
                values.push((field, v));
            }
            for (field, v) in values {
                set_field(&mut draft, field, v).map_err(|message| LifecycleError {
                    code: "lifecycle_failed".into(),
                    message,
                    field: Some(field.to_owned()),
                })?;
            }
        }
    }
    Ok(draft)
}

/// Evaluate a lifecycle guard (spec 09, spec 10 lifecycle context): the draft
/// at top level and as `record`/`raw`, `old` for the previous frontmatter,
/// `file` with the path, `operation` with the captured clock. Anything other
/// than boolean `true` skips the action; an evaluation error fails the
/// operation with `lifecycle_expression_error`.
fn guard_passes(
    guard: &str,
    draft: &Map,
    ctx: &LifecycleContext<'_>,
    path: &str,
    clock: &OpClock,
) -> Result<bool, LifecycleError> {
    let previous = ctx.previous;
    // Date-time fields bind as timestamps (spec 10), in the draft and `old`.
    let typed = |m: &Map| {
        CelValue::from_value_typed(&Value::Map(m.clone()), &|loc: &[&str]| {
            ctx.catalog.is_date_time(ctx.types, loc)
        })
    };
    use crate::cel::{self, CelValue};
    let fail = |message: String| LifecycleError {
        code: "lifecycle_expression_error".into(),
        message,
        field: None,
    };
    let program = cel::compile(guard).map_err(|e| fail(format!("guard `{guard}`: {e}")))?;
    let file = CelValue::from_value(&Value::Map(
        [("path".to_owned(), Value::string(path))]
            .into_iter()
            .collect(),
    ));
    let mut act = cel::record_activation(draft, draft, file);
    if let CelValue::Map(m) = typed(draft) {
        for (k, v) in m.iter() {
            if let cel::Key::String(name) = k {
                act.bind(name.to_string(), v.clone());
            }
        }
        act.bind("record", CelValue::Map(m.clone()));
        act.bind("raw", CelValue::Map(m));
    }
    act.with_clock(cel_clock(clock.instant_ms, &clock.local_date, &clock.tz));
    act.bind("old", typed(&previous.cloned().unwrap_or_default()));
    act.bind(
        "operation",
        CelValue::from_value(&Value::Map(
            [
                (
                    "now".to_owned(),
                    Value::string(rfc3339_ms(clock.instant_ms)),
                ),
                ("today".to_owned(), Value::string(clock.local_date.clone())),
            ]
            .into_iter()
            .collect(),
        )),
    );
    match program.evaluate(&act) {
        Ok(CelValue::Bool(b)) => Ok(b),
        Ok(_) => Ok(false),
        Err(e) => Err(fail(format!("guard `{guard}`: {e}"))),
    }
}

/// The CEL clock for a captured instant, date and zone. Named zone rules come
/// from the embedded IANA release pinned by the semantics version (Q6).
/// Unknown zones leave conversions an error; `now()` and `today()` still read
/// the captured instant and local date, never an OS clock or UTC fallback.
pub fn cel_clock(instant_ms: i64, local_date: &str, tz: &str) -> crate::cel::Clock {
    use crate::cel::time::{NamedZone, TimeZoneRules, Timestamp};
    crate::cel::Clock {
        instant: Timestamp::from_millis(instant_ms).ok(),
        local_date: Some(local_date.to_owned()),
        tz: NamedZone::get(tz)
            .ok()
            .map(|zone| std::sync::Arc::new(zone) as std::sync::Arc<dyn TimeZoneRules>),
    }
}

/// `slugify` (spec 09): lowercase, transliterate to ASCII where a
/// decomposition exists, replace each run of other characters with `-`, trim
/// `-`.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in crate::unicode::nfd(s)
        .chars()
        .filter(|c| !crate::unicode::is_combining_mark(*c))
    {
        let lc = c.to_ascii_lowercase();
        if lc.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(lc);
        } else {
            dash = true;
        }
    }
    out
}

/// Assign (or, for `None`, remove) the value at a field reference, creating
/// missing intermediate objects (spec 07). Fails rather than replace a
/// non-object intermediate; an array index must already exist.
pub fn set_field(root: &mut Map, reference: &str, value: Option<Value>) -> Result<(), String> {
    use crate::types::FieldStep;
    let steps = crate::types::parse_field_ref(reference)
        .ok_or_else(|| format!("invalid field reference `{reference}`"))?;
    if steps.iter().any(|s| matches!(s, FieldStep::Each)) {
        return Err(format!("`{reference}` selects several values"));
    }
    let key_of = |s: &FieldStep| match s {
        FieldStep::Key(k) => k.clone(),
        FieldStep::Index(i) => i.to_string(),
        FieldStep::Each => String::new(),
    };
    let (last, path) = steps.split_last().ok_or("empty field reference")?;
    if path.is_empty() {
        match value {
            Some(v) => {
                root.insert(key_of(last), v);
            }
            None => {
                root.remove(&key_of(last));
            }
        }
        return Ok(());
    }
    let first = key_of(&path[0]);
    if !root.contains_key(&first) {
        if value.is_none() {
            return Ok(());
        }
        root.insert(first.clone(), Value::Map(Map::new()));
    }
    let mut cur = root.get_mut(&first).ok_or("unreachable")?;
    for step in &path[1..] {
        cur = match (step, cur) {
            (FieldStep::Index(i), Value::List(l)) => usize::try_from(*i)
                .ok()
                .and_then(|i| l.get_mut(i))
                .ok_or_else(|| format!("`{reference}`: no such array item"))?,
            (s, Value::Map(m)) => {
                let k = key_of(s);
                if !m.contains_key(&k) {
                    if value.is_none() {
                        return Ok(());
                    }
                    m.insert(k.clone(), Value::Map(Map::new()));
                }
                m.get_mut(&k).ok_or("unreachable")?
            }
            _ => {
                return Err(format!(
                    "`{reference}`: an intermediate value is not an object"
                ));
            }
        };
    }
    match (last, cur, value) {
        (FieldStep::Index(i), Value::List(l), Some(v)) => {
            let slot = usize::try_from(*i)
                .ok()
                .and_then(|i| l.get_mut(i))
                .ok_or_else(|| format!("`{reference}`: no such array item"))?;
            *slot = v;
        }
        (s, Value::Map(m), Some(v)) => {
            m.insert(key_of(s), v);
        }
        (s, Value::Map(m), None) => {
            m.remove(&key_of(s));
        }
        (_, Value::List(_), None) => {
            return Err(format!("`{reference}`: cannot remove an array item"));
        }
        _ => {
            return Err(format!(
                "`{reference}`: an intermediate value is not an object"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_is_reproducible_and_versioned() {
        let mut a = GenStream::new([7; 32]);
        let mut b = GenStream::new([7; 32]);
        let ua = a.uuid();
        assert_eq!(ua, b.uuid());
        let s = ua.to_string();
        assert_eq!(&s[14..15], "4");
        assert!(matches!(&s[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(a.uuid(), ua);
        // Crossing a block boundary keeps the stream contiguous.
        let mut c = GenStream::new([7; 32]);
        let mut all = [0u8; 48];
        c.fill(&mut all);
        let mut d = GenStream::new([7; 32]);
        let mut first = [0u8; 16];
        let mut second = [0u8; 32];
        d.fill(&mut first);
        d.fill(&mut second);
        assert_eq!(&all[..16], &first);
        assert_eq!(&all[16..], &second);
    }

    #[test]
    fn ulid_layout() {
        let mut g = GenStream::new([1; 32]);
        let u = g.ulid(1_700_000_000_000);
        assert_eq!(u.len(), 26);
        // The time prefix is the 48-bit instant in Crockford Base32.
        assert_eq!(&u[..10], "01HF7YAT00");
    }

    #[test]
    fn slugs() {
        assert_eq!(slugify("Caller Label"), "caller-label");
        assert_eq!(slugify("  Café — Crème Brûlée!! "), "cafe-creme-brulee");
        assert_eq!(slugify("---"), "");
    }

    #[test]
    fn nested_set() {
        let mut m = Map::new();
        set_field(&mut m, "a.b", Some(Value::Int(1))).unwrap();
        assert_eq!(m.get("a").and_then(|a| a.get("b")), Some(&Value::Int(1)));
        m.insert("s", Value::string("x"));
        assert!(set_field(&mut m, "s.t", Some(Value::Int(1))).is_err());
        set_field(&mut m, "a.b", None).unwrap();
        assert_eq!(m.get("a").and_then(Value::as_map).map(Map::len), Some(0));
    }

    #[test]
    fn rfc3339() {
        assert_eq!(rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339_ms(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(rfc3339_ms(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(rfc3339_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
