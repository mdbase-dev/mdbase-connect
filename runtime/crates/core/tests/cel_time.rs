//! Time zone rules against Python's `zoneinfo` (an independent TZif reader) on
//! real tzdb files, and the CEL temporal functions.

use std::sync::Arc;

use mdbn_core::cel::time::{TimeZoneRules, Timestamp, Tzif};
use mdbn_core::cel::{Activation, CelValue, Clock, compile, record_activation};
use mdbn_core::value::{Map, Value};

fn zone(name: &str) -> Tzif {
    let data: &[u8] = match name {
        "Australia_Melbourne" => include_bytes!("data/tzif/Australia_Melbourne"),
        "America_New_York" => include_bytes!("data/tzif/America_New_York"),
        "America_Santiago" => include_bytes!("data/tzif/America_Santiago"),
        "Pacific_Apia" => include_bytes!("data/tzif/Pacific_Apia"),
        "Asia_Kolkata" => include_bytes!("data/tzif/Asia_Kolkata"),
        "Europe_London" => include_bytes!("data/tzif/Europe_London"),
        "UTC" => include_bytes!("data/tzif/UTC"),
        "Australia_Lord_Howe" => include_bytes!("data/tzif/Australia_Lord_Howe"),
        "America_St_Johns" => include_bytes!("data/tzif/America_St_Johns"),
        other => panic!("{other}"),
    };
    Tzif::parse(data).unwrap()
}

#[test]
fn offsets_agree_with_zoneinfo() {
    let table = include_str!("data/tz-offsets.txt");
    let mut n = 0;
    let mut cache: Vec<(String, Tzif)> = Vec::new();
    for line in table.lines() {
        let mut it = line.split(' ');
        let (z, t, off) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
        if !cache.iter().any(|(name, _)| name == z) {
            cache.push((z.to_owned(), zone(z)));
        }
        let tz = &cache.iter().find(|(name, _)| name == z).unwrap().1;
        let t: i64 = t.parse().unwrap();
        assert_eq!(tz.offset_at(t), off.parse::<i32>().unwrap(), "{z} at {t}");
        n += 1;
    }
    assert!(n > 10_000);
}

#[test]
fn start_of_day_is_the_first_instant_of_the_local_date() {
    for z in [
        "Australia_Melbourne",
        "America_Santiago",
        "Pacific_Apia",
        "Australia_Lord_Howe",
        "America_St_Johns",
    ] {
        let tz: Arc<dyn TimeZoneRules> = Arc::new(zone(z));
        let mut act = Activation::new();
        act.with_clock(Clock {
            instant: None,
            local_date: None,
            tz: Some(tz),
        });
        let p = compile("[startOfDay(d), startOfDay(d) - duration('1s')].map(t, date(t))").unwrap();
        // Every day of 2011 (Apia skipped 2011-12-30) and of 2026.
        for year in [2011, 2026] {
            for doy in 0..365 {
                let d = mdbn_core::cel::time::Timestamp {
                    seconds: (mdbn_core_days(year) + doy) * 86_400,
                    nanos: 0,
                };
                let date = &d.to_rfc3339()[..10];
                act.bind("d", CelValue::string(date));
                match p.evaluate(&act) {
                    Ok(CelValue::List(l)) => {
                        let s = |v: &CelValue| match v {
                            CelValue::String(s) => s.to_string(),
                            _ => panic!(),
                        };
                        // The start is on the date (or the date was skipped:
                        // then it is on the next date) and one second earlier
                        // is an earlier date.
                        assert!(s(&l[0]).as_str() >= date, "{z} {date}");
                        assert!(s(&l[1]).as_str() < date, "{z} {date}: {l:?}");
                    }
                    other => panic!("{z} {date}: {other:?}"),
                }
            }
        }
    }
}

fn mdbn_core_days(year: i64) -> i64 {
    // Days from 1970-01-01 to January 1 of `year` (1970 < year).
    (1970..year)
        .map(|y| {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                366
            } else {
                365
            }
        })
        .sum()
}

fn eval_record(
    expr: &str,
    tz: Option<&str>,
    instant: &str,
    today: &str,
) -> Result<CelValue, String> {
    let mut m = Map::new();
    m.insert("due", Value::string("2026-06-20"));
    m.insert("title", Value::string("Open task"));
    let mut act = record_activation(&m, &m, CelValue::Null);
    act.with_clock(Clock {
        instant: Some(Timestamp::parse(instant).unwrap()),
        local_date: Some(today.to_owned()),
        tz: tz.map(|z| Arc::new(zone(z)) as Arc<dyn TimeZoneRules>),
    });
    compile(expr)
        .map_err(|e| e.to_string())?
        .evaluate(&act)
        .map_err(|e| e.message)
}

fn t(expr: &str) {
    match eval_record(
        expr,
        Some("Australia_Melbourne"),
        "2026-06-20T03:00:00Z",
        "2026-06-20",
    ) {
        Ok(CelValue::Bool(true)) => {}
        other => panic!("{expr} => {other:?}"),
    }
}

fn e(expr: &str) {
    assert!(
        eval_record(expr, None, "2026-06-20T03:00:00Z", "2026-06-20").is_err(),
        "{expr}"
    );
}

#[test]
fn spec_fixture_expressions() {
    // cel.date_strings, cel.date_month_clamp, cel.standard_duration,
    // cel.date_timestamp_conversion (cel/cel-profile.yaml).
    t(
        r#"due < "2026-07-01" && due.addMonths(1) == "2026-07-20" && due.addDays(11) == "2026-07-01" && due.daysUntil("2026-06-25") == 5 && due.year() == 2026 && due.month() == 6 && due.day() == 20 && due.dayOfWeek() == 6"#,
    );
    t(r#""2026-01-31".addMonths(1) == "2026-02-28" && "2024-02-29".addYears(1) == "2025-02-28""#);
    t(
        r#"timestamp("2026-06-20T00:00:00Z") + duration("36h") == timestamp("2026-06-21T12:00:00Z")"#,
    );
    t(
        r#"startOfDay(due) == timestamp("2026-06-19T14:00:00Z") && date(timestamp("2026-06-20T15:30:00Z")) == "2026-06-21""#,
    );
    // cel.invalid_date_receiver, cel.date_timestamp_mixing.
    e(r#"title.addDays(1) == "x""#);
    e("due < now()");
}

#[test]
fn clock_and_temporal_semantics() {
    t("now() == timestamp('2026-06-20T03:00:00Z') && today() == '2026-06-20'");
    t("now() - timestamp('2026-06-19T03:00:00Z') == duration('24h')");
    t("string(now()) == '2026-06-20T03:00:00Z' && string(duration('1.5h')) == '5400s'");
    t("duration('1h') > duration('59m') && duration('-1h') < duration('0s')");
    // CEL defines unary minus for int and double only.
    e("-duration('1h') < duration('0s')");
    t("int(timestamp('1970-01-01T00:01:00Z')) == 60");
    t(
        "timestamp('2026-06-20T03:04:05.123Z').getHours() == 3 && timestamp('2026-06-20T03:04:05.123Z').getMilliseconds() == 123",
    );
    t(
        "timestamp('2026-06-20T23:00:00Z').getDate('+10:00') == 21 && timestamp('2026-06-20T00:00:00Z').getMonth() == 5",
    );
    t("timestamp('2026-06-21T00:00:00Z').getDayOfWeek() == 0");
    t("duration('90m').getHours() == 1 && duration('90m').getMinutes() == 90");
    t("'2024-03-01'.addDays(-1) == '2024-02-29' && '2026-12-31'.addMonths(2) == '2027-02-28'");
    t("'2026-06-20'.daysUntil('2025-06-20') == -365 && '2026-06-22'.dayOfWeek() == 1");
    t("date('2026-06-20') == '2026-06-20'");
    e("date('2026-02-30')");
    e("timestamp('2026-06-20')");
    e("duration('1d')");
    e("timestamp('9999-12-31T23:59:59Z') + duration('1s')");
    // No zone rules: zone conversions are errors, now() and today() are not.
    e("date(now()) == today()");
    assert!(matches!(
        eval_record(
            "now() > timestamp('2026-01-01T00:00:00Z') && today() == '2026-06-20'",
            None,
            "2026-06-20T03:00:00Z",
            "2026-06-20"
        ),
        Ok(CelValue::Bool(true))
    ));
}

#[test]
fn no_clock_means_no_now() {
    let p = compile("now()").unwrap();
    assert!(p.evaluate(&Activation::new()).is_err());
}

#[test]
fn references_report_nondeterministic_bindings() {
    let r = compile("has(raw.due) && raw.due < today()")
        .unwrap()
        .references();
    assert_eq!(r.nondeterministic(), ["today"]);
    let r = compile("file.mtime > now() - duration('24h')")
        .unwrap()
        .references();
    assert_eq!(r.nondeterministic(), ["now", "file.mtime"]);
    let r = compile("has(raw.parent) && link(raw.parent).asFile() != null")
        .unwrap()
        .references();
    assert_eq!(r.nondeterministic(), ["asFile"]);
    let r = compile("tags.exists(file, file == 'x') && status == 'open'")
        .unwrap()
        .references();
    assert!(r.nondeterministic().is_empty());
    assert!(
        r.identifiers.contains("tags")
            && r.identifiers.contains("status")
            && !r.identifiers.contains("file")
    );
    let r = compile("file.hasLink(x) || size(file.backlinks) > 0")
        .unwrap()
        .references();
    assert_eq!(r.nondeterministic(), ["file.backlinks", "file.hasLink"]);
}

/// A fake link host: a link string `x` read at `from` resolves to the record
/// `<folder of from>/x.md` when it exists.
#[derive(Debug)]
struct FakeLinks {
    records: Vec<(&'static str, Map)>,
}

impl FakeLinks {
    fn resolve(&self, v: &CelValue, from: &str) -> Option<&'static str> {
        let CelValue::String(s) = v else { return None };
        let folder = from.rsplit_once('/').map_or("", |(f, _)| f);
        let want = if folder.is_empty() {
            format!("{s}.md")
        } else {
            format!("{folder}/{s}.md")
        };
        self.records.iter().map(|(p, _)| *p).find(|p| *p == want)
    }
}

impl mdbn_core::cel::LinkHost for FakeLinks {
    fn link(&self, value: &CelValue, _from: &str) -> Result<CelValue, String> {
        Ok(value.clone())
    }
    fn as_file(&self, value: &CelValue, from: &str) -> Result<CelValue, String> {
        let Some(path) = self.resolve(value, from) else {
            return Ok(CelValue::Null);
        };
        let m = &self.records.iter().find(|(p, _)| *p == path).unwrap().1;
        let cm = mdbn_core::cel::CelMap::new();
        let mut cm = cm.with_origin(path);
        for (k, v) in m.iter() {
            cm.insert(
                mdbn_core::cel::Key::String(Arc::from(k)),
                CelValue::from_value(v),
            );
        }
        Ok(CelValue::Map(Arc::new(cm)))
    }
    fn as_link(&self, path: &str) -> Result<CelValue, String> {
        Ok(CelValue::string(path))
    }
    fn has_link(&self, path: &str, value: &CelValue) -> Result<bool, String> {
        Ok(path == "tasks/t.md" && self.resolve(value, path) == Some("tasks/p.md"))
    }
}

#[test]
fn links_resolve_relative_to_the_record_they_were_read_from() {
    let rec = |pairs: &[(&str, &str)]| -> Map {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), Value::string(*v)))
            .collect()
    };
    let host = FakeLinks {
        records: vec![
            ("tasks/p.md", rec(&[("lead", "ann")])),
            // `ann` read from tasks/p.md resolves in tasks/, not people/.
            ("tasks/ann.md", rec(&[("team", "engineering")])),
            ("people/ann.md", rec(&[("team", "wrong")])),
        ],
    };
    let task = rec(&[("project", "p"), ("missing", "nope")]);
    let mut file = mdbn_core::cel::CelMap::new();
    file.insert(
        mdbn_core::cel::Key::String(Arc::from("path")),
        CelValue::string("tasks/t.md"),
    );
    file.insert(
        mdbn_core::cel::Key::String(Arc::from("folder")),
        CelValue::string("tasks"),
    );
    file.insert(
        mdbn_core::cel::Key::String(Arc::from("tags")),
        CelValue::List(Arc::new(vec![
            CelValue::string("#project/alpha"),
            CelValue::string("x"),
        ])),
    );
    let mut act = record_activation(&task, &task, CelValue::Map(Arc::new(file)));
    act.with_links(&host);
    let ok = |expr: &str| match compile(expr).unwrap().evaluate(&act) {
        Ok(CelValue::Bool(true)) => {}
        other => panic!("{expr} => {other:?}"),
    };
    ok("project.asFile().lead.asFile().team == 'engineering'");
    ok("raw.project.asFile().lead == 'ann'");
    ok("missing.asFile() == null && link(project).asFile() != null");
    ok("file.hasLink('p') && !file.hasLink('q') && file.asLink() == 'tasks/t.md'");
    ok("file.inFolder('tasks') && file.inFolder('') && !file.inFolder('task')");
    ok(
        "file.hasTag('project') && file.hasTag('#project/alpha') && !file.hasTag('proj') && file.hasTag('x')",
    );
    // Without a host the link helpers are evaluation errors.
    let plain = record_activation(&task, &task, CelValue::Null);
    assert!(
        compile("project.asFile() == null")
            .unwrap()
            .evaluate(&plain)
            .is_err()
    );
}

#[test]
fn typed_date_times_compare_with_timestamps() {
    // lifecycle.guard_timestamps: reviewedAt is `format: date-time` in the schema.
    let mut m = Map::new();
    m.insert("reviewedAt", Value::string("2025-06-01T09:00:00+10:00"));
    m.insert("title", Value::string("2025-06-01T09:00:00Z"));
    let typed = |loc: &[&str]| loc == ["reviewedAt"];
    let record = CelValue::from_value_typed(&Value::Map(m.clone()), &typed);
    let mut act = Activation::new();
    if let CelValue::Map(fields) = &record {
        for (k, v) in fields.iter() {
            if let mdbn_core::cel::Key::String(k) = k {
                act.bind(&**k, v.clone());
            }
        }
    }
    act.bind("old", record.clone());
    let guard = compile(
        r#"reviewedAt < timestamp("2026-01-01T00:00:00Z") && old.?reviewedAt.orValue(null) == reviewedAt"#,
    )
    .unwrap();
    assert!(matches!(guard.evaluate(&act), Ok(CelValue::Bool(true))));
    // An untyped location stays a string: comparing it with a timestamp is an error.
    assert!(
        compile(r#"title < timestamp("2026-01-01T00:00:00Z")"#)
            .unwrap()
            .evaluate(&act)
            .is_err()
    );
    // An invalid date-time at a typed location stays a string.
    let mut bad = Map::new();
    bad.insert("reviewedAt", Value::string("June"));
    assert!(
        matches!(CelValue::from_value_typed(&Value::Map(bad), &typed), CelValue::Map(m) if matches!(m.get_str("reviewedAt"), Some(CelValue::String(_))))
    );
}

#[derive(Debug)]
struct MemberHost;

impl mdbn_core::cel::LinkHost for MemberHost {
    fn link(&self, v: &CelValue, _: &str) -> Result<CelValue, String> {
        Ok(v.clone())
    }
    fn as_file(&self, _: &CelValue, _: &str) -> Result<CelValue, String> {
        Ok(CelValue::Null)
    }
    fn as_link(&self, p: &str) -> Result<CelValue, String> {
        Ok(CelValue::string(p))
    }
    fn has_link(&self, _: &str, _: &CelValue) -> Result<bool, String> {
        Ok(false)
    }
    fn file_member(&self, path: &str, member: &str) -> Result<Option<CelValue>, String> {
        Ok(match member {
            "backlinks" => Some(CelValue::List(Arc::new(vec![CelValue::string(&format!(
                "{path}<-a"
            ))]))),
            _ => None,
        })
    }
}

#[test]
fn borrowed_host_supplies_file_members() {
    let host = MemberHost;
    let mut file = mdbn_core::cel::CelMap::new();
    file.insert(
        mdbn_core::cel::Key::String(Arc::from("path")),
        CelValue::string("t.md"),
    );
    file.insert(
        mdbn_core::cel::Key::String(Arc::from("links")),
        CelValue::List(Arc::new(vec![])),
    );
    let mut act = record_activation(&Map::new(), &Map::new(), CelValue::Map(Arc::new(file)));
    act.with_links(&host);
    let ok = |e: &str| {
        assert!(
            matches!(compile(e).unwrap().evaluate(&act), Ok(CelValue::Bool(true))),
            "{e}"
        )
    };
    ok("file.backlinks == ['t.md<-a'] && size(file.links) == 0 && has(file.backlinks)");
    // Not provided by the file map or the host: a missing key, as before.
    assert!(compile("file.embeds").unwrap().evaluate(&act).is_err());
}

#[test]
fn the_syntax_tree_is_public() {
    use mdbn_core::cel::ast::{BinOp, Expr};
    let p = compile("status == 'open' && title.matches('^a')").unwrap();
    let Expr::And(a, b) = p.ast() else {
        panic!("{:?}", p.ast())
    };
    assert!(
        matches!(a.as_ref(), Expr::Bin(BinOp::Eq, l, _) if matches!(l.as_ref(), Expr::Ident(n) if n == "status"))
    );
    assert!(matches!(b.as_ref(), Expr::MatchesLit { source, .. } if source == "^a"));
    // Programs can be shared across threads (also asserted at compile time
    // in mdbn_core::cel).
    fn shareable<T: Send + Sync>(_: &T) {}
    shareable(&p);
    assert_eq!(p.references().identifiers.len(), 2);
}
