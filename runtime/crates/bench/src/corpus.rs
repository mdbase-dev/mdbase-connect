//! Deterministic synthetic vaults for performance work.
//!
//! A corpus is a function of its [`Spec`]: the same spec always produces the
//! same files, byte for byte, on every machine. Nothing here reads real user
//! data. The shapes are modelled on typical Obsidian vaults (see
//! `tools/perf/README.md` for the assumptions):
//!
//! - general notes in a 1-3 level folder tree, about 70% with frontmatter
//!   (tags, aliases, dates, a few custom properties);
//! - daily notes with checkbox tasks and links;
//! - TaskNotes-shaped task notes under `TaskNotes/Tasks/` (title, status,
//!   priority, due, scheduled, contexts, projects as wikilinks, time
//!   estimates, blocked-by links, recurrence);
//! - project notes that tasks link to;
//! - a few long reference notes (20-80 KB);
//! - wikilinks with preferential attachment (a few hub notes collect most
//!   backlinks), aliases and heading links, embeds of attachments;
//! - attachments: many small images and a few large files, filled with
//!   incompressible deterministic bytes behind real magic numbers.
//!
//! The corpus also contains `mdbase.yaml`, a `task` type matched by path, and
//! a TaskNotes-style `.base` view file.

use std::collections::BTreeSet;

/// Which mix of notes to generate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    /// A typical personal vault: mostly notes, a quarter tasks, daily notes.
    RealShaped,
    /// TaskNotes-heavy: nearly every note is a task (for task view targets).
    Tasks,
}

/// How many attachments to generate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attachments {
    /// Notes only.
    None,
    /// One small image per 10 notes, one large file per 2,000 notes.
    Light,
    /// One image per 4 notes (up to 2 MB), one large file per 500 notes.
    Full,
}

/// A corpus specification. Equal specs produce identical corpora.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spec {
    /// Number of Markdown notes (excluding config, types and views).
    pub notes: u32,
    /// The note mix.
    pub profile: Profile,
    /// The attachment set.
    pub attachments: Attachments,
    /// PRNG seed.
    pub seed: u64,
    /// Write inline `#tags` and `[[note#heading]]` links in note bodies (real
    /// vaults have both).
    pub inline_tags: bool,
}

impl Spec {
    /// A real-shaped corpus of `notes` notes with light attachments, seed 1.
    pub fn real(notes: u32) -> Spec {
        Spec {
            notes,
            profile: Profile::RealShaped,
            attachments: Attachments::Light,
            seed: 1,
            inline_tags: true,
        }
    }

    /// A task-heavy corpus of `notes` notes without attachments, seed 1.
    pub fn tasks(notes: u32) -> Spec {
        Spec {
            notes,
            profile: Profile::Tasks,
            attachments: Attachments::None,
            seed: 1,
            inline_tags: true,
        }
    }
}

/// What a generated corpus contains.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Markdown notes, including config/type/view files.
    pub markdown_files: u64,
    /// Total bytes of Markdown.
    pub markdown_bytes: u64,
    /// Task notes (TaskNotes-shaped).
    pub task_notes: u64,
    /// Wikilinks written (including embeds).
    pub links: u64,
    /// Checkbox lines written.
    pub checkboxes: u64,
    /// Attachment files.
    pub attachment_files: u64,
    /// Total attachment bytes.
    pub attachment_bytes: u64,
    /// Distinct folders.
    pub folders: u64,
}

/// SplitMix64: small, fast, and identical on every platform.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// A generator seeded with `seed`.
    pub fn new(seed: u64) -> Rng {
        Rng(seed ^ 0x6d64_6261_7365_2d70)
    }
    /// The next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// Uniform in `0..n` (`n > 0`).
    pub fn below(&mut self, n: u64) -> u64 {
        ((u128::from(self.next_u64()) * u128::from(n)) >> 64) as u64
    }
    /// Uniform in `lo..=hi`.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
    /// True with probability `pct`%.
    pub fn pct(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
    /// Skewed towards 0: index in `0..n` with density ~ 1/sqrt(x) (hubs).
    pub fn skewed(&mut self, n: u64) -> u64 {
        let u = self.below(1 << 20);
        (u * u / (1 << 20)) * n / (1 << 20)
    }
    /// A random element.
    pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &[
    "alpha",
    "anchor",
    "apple",
    "archive",
    "atlas",
    "autumn",
    "beacon",
    "birch",
    "bridge",
    "budget",
    "cabin",
    "canvas",
    "cedar",
    "chapter",
    "circuit",
    "cloud",
    "compass",
    "copper",
    "coral",
    "crystal",
    "delta",
    "desert",
    "draft",
    "echo",
    "ember",
    "engine",
    "field",
    "filter",
    "forest",
    "fossil",
    "garden",
    "glacier",
    "harbor",
    "harvest",
    "horizon",
    "index",
    "island",
    "journal",
    "kernel",
    "lantern",
    "ledger",
    "lemon",
    "lighthouse",
    "maple",
    "marble",
    "meadow",
    "meeting",
    "method",
    "mirror",
    "module",
    "monsoon",
    "mountain",
    "network",
    "notebook",
    "oasis",
    "orbit",
    "orchard",
    "outline",
    "paper",
    "pattern",
    "pebble",
    "pilot",
    "planet",
    "plaza",
    "pocket",
    "prairie",
    "prism",
    "project",
    "quartz",
    "question",
    "radar",
    "reading",
    "recipe",
    "report",
    "review",
    "ribbon",
    "river",
    "rocket",
    "sandbox",
    "schema",
    "season",
    "signal",
    "sketch",
    "socket",
    "spiral",
    "spring",
    "summit",
    "syntax",
    "tablet",
    "theory",
    "thread",
    "timber",
    "topic",
    "tower",
    "trail",
    "travel",
    "tundra",
    "uplink",
    "valley",
    "vector",
    "velvet",
    "voyage",
    "willow",
    "window",
    "winter",
    "workshop",
    "yarrow",
    "zenith",
    "café",
    "naïve",
    "über",
    "fjörd",
    "señor",
    "日本",
    "検索",
    "zürich",
    "crème",
    "façade",
];

const AREAS: &[&str] = &[
    "Work", "Personal", "Research", "Reading", "Health", "Finance", "Travel", "Learning",
    "Writing", "Home", "Meetings", "People", "Ideas", "Archive", "Clients", "Recipes",
];

const TAGS: &[&str] = &[
    "idea",
    "todo",
    "reference",
    "meeting",
    "book",
    "article",
    "person",
    "project",
    "review",
    "draft",
    "important",
    "followup",
    "question",
    "research",
    "learning",
    "health",
    "finance",
    "travel",
    "work/planning",
    "work/report",
    "work/1on1",
    "home/repair",
    "reading/queue",
    "reading/done",
    "status/active",
    "status/someday",
    "lang/rust",
    "lang/ts",
    "evergreen",
    "seedling",
    "quote",
    "howto",
    "checklist",
    "log",
    "retro",
    "decision",
    "spec",
    "bug",
];

const STATUSES: &[(&str, u64)] = &[("open", 45), ("in-progress", 20), ("done", 30), ("none", 5)];
const PRIORITIES: &[&str] = &["none", "low", "normal", "normal", "high"];
const CONTEXTS: &[&str] = &[
    "@home",
    "@office",
    "@phone",
    "@computer",
    "@errands",
    "@deep",
];

/// Base date: 2026-01-01 (days since 1970-01-01).
const BASE_DAY: i64 = 20_454;

fn ymd(days: i64) -> (i64, u32, u32) {
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn date(days: i64) -> String {
    let (y, m, d) = ymd(days);
    format!("{y:04}-{m:02}-{d:02}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Note,
    Daily,
    Task,
    Project,
    Long,
}

struct Meta {
    kind: Kind,
    folder: String,
    title: String,
}

struct Attachment {
    path: String,
    name: String,
    size: u64,
    magic: &'static [u8],
}

/// Generate a corpus, handing each file (relative path, bytes) to `sink` in a
/// deterministic order. Returns the corpus statistics.
pub fn generate(spec: &Spec, mut sink: impl FnMut(&str, &[u8])) -> Stats {
    let mut rng = Rng::new(spec.seed);
    let inline_tags = spec.inline_tags;
    let mut stats = Stats::default();
    let n = u64::from(spec.notes);

    // Plan every note first so links can point at real titles.
    let mut titles = BTreeSet::new();
    let mut folders = BTreeSet::new();
    let area_folders: Vec<String> = {
        let per_area = ((n as f64).sqrt() as u64 / 4).max(1);
        let mut v = Vec::new();
        for a in AREAS {
            v.push((*a).to_string());
            for i in 0..per_area {
                let sub = format!(
                    "{a}/{} {i}",
                    capitalise(WORDS[(i as usize * 7) % WORDS.len()])
                );
                if i % 3 == 0 {
                    v.push(format!(
                        "{sub}/{}",
                        capitalise(WORDS[(i as usize * 13 + 5) % WORDS.len()])
                    ));
                }
                v.push(sub);
            }
        }
        v
    };
    let projects = match spec.profile {
        Profile::RealShaped => (n * 3 / 100).max(1),
        Profile::Tasks => (n / 50).max(1),
    };
    let mut metas: Vec<Meta> = Vec::with_capacity(n as usize);
    let mut daily_day = BASE_DAY - (n as i64 / 8);
    for i in 0..n {
        let kind = if i < projects {
            Kind::Project
        } else {
            match spec.profile {
                Profile::Tasks => Kind::Task,
                Profile::RealShaped => match rng.below(100) {
                    0..=59 => Kind::Note,
                    60..=69 => Kind::Daily,
                    70..=97 => Kind::Task,
                    _ => Kind::Long,
                },
            }
        };
        let (folder, title) = match kind {
            Kind::Daily => {
                daily_day += 1;
                ("Daily".to_string(), date(daily_day))
            }
            Kind::Task => (
                "TaskNotes/Tasks".to_string(),
                unique_title(&mut rng, &mut titles, 3, 7),
            ),
            Kind::Project => (
                "Projects".to_string(),
                unique_title(&mut rng, &mut titles, 1, 3),
            ),
            Kind::Long => (
                "Reference".to_string(),
                unique_title(&mut rng, &mut titles, 2, 4),
            ),
            Kind::Note => (
                area_folders[rng.below(area_folders.len() as u64) as usize].clone(),
                unique_title(&mut rng, &mut titles, 1, 5),
            ),
        };
        folders.insert(folder.clone());
        metas.push(Meta {
            kind,
            folder,
            title,
        });
    }

    // Attachments are planned up front so notes can embed them.
    let (images, large) = match spec.attachments {
        Attachments::None => (0, 0),
        Attachments::Light => (n / 10, (n / 2000).max(1)),
        Attachments::Full => (n / 4, (n / 500).max(1)),
    };
    let mut atts = Vec::new();
    for i in 0..images {
        let (ext, magic): (&str, &[u8]) = if rng.pct(60) {
            ("png", b"\x89PNG\r\n\x1a\n")
        } else {
            ("jpg", b"\xff\xd8\xff\xe0")
        };
        let size = match spec.attachments {
            Attachments::Full => {
                rng.range(20_000, 300_000)
                    + if rng.pct(10) {
                        rng.range(0, 1_700_000)
                    } else {
                        0
                    }
            }
            _ => rng.range(10_000, 200_000),
        };
        let name = format!("Pasted image {}{:04}.{ext}", 20_260_000 + i / 97, i % 9973);
        atts.push(Attachment {
            path: format!("Attachments/{name}"),
            name,
            size,
            magic,
        });
    }
    for i in 0..large {
        let (ext, magic): (&str, &[u8]) = match i % 3 {
            0 => ("pdf", b"%PDF-1.7\n"),
            1 => ("mp4", b"\x00\x00\x00\x18ftypmp42"),
            _ => ("zip", b"PK\x03\x04"),
        };
        let size = match spec.attachments {
            Attachments::Full => rng.range(5_000_000, 50_000_000),
            _ => rng.range(2_000_000, 10_000_000),
        };
        let name = format!("{} {}.{ext}", capitalise(rng.pick(WORDS)), i);
        atts.push(Attachment {
            path: format!("Attachments/Files/{name}"),
            name,
            size,
            magic,
        });
    }
    if !atts.is_empty() {
        folders.insert("Attachments".into());
    }
    if large > 0 {
        folders.insert("Attachments/Files".into());
    }
    stats.folders = folders.len() as u64 + 3; // + _types, TaskNotes/Views, root

    // Fixed files.
    let fixed: [(&str, String); 3] = [
        (
            "mdbase.yaml",
            "spec_version: \"0.3.0\"\nname: \"Perf corpus\"\nsettings:\n  timezone: \"UTC\"\n"
                .into(),
        ),
        ("_types/task.md", TASK_TYPE.into()),
        ("TaskNotes/Views/tasks-default.base", TASKS_BASE.into()),
    ];
    for (p, t) in &fixed {
        stats.markdown_files += 1;
        stats.markdown_bytes += t.len() as u64;
        sink(p, t.as_bytes());
    }

    let mut buf = String::new();
    for (i, m) in metas.iter().enumerate() {
        buf.clear();
        let mut ctx = NoteCtx {
            inline_tags,
            rng: &mut rng,
            metas: &metas,
            atts: &atts,
            stats: &mut stats,
            projects,
        };
        match m.kind {
            Kind::Task => ctx.task(i as u64, &mut buf),
            Kind::Daily => ctx.daily(&mut buf),
            Kind::Project => ctx.project(m, &mut buf),
            Kind::Long => ctx.note(true, &mut buf),
            Kind::Note => ctx.note(false, &mut buf),
        }
        if m.kind == Kind::Task {
            stats.task_notes += 1;
        }
        let path = format!("{}/{}.md", m.folder, m.title);
        stats.markdown_files += 1;
        stats.markdown_bytes += buf.len() as u64;
        sink(&path, buf.as_bytes());
    }

    let mut bytes = Vec::new();
    for a in &atts {
        bytes.clear();
        bytes.extend_from_slice(a.magic);
        let mut fill = Rng::new(spec.seed ^ fnv(&a.path));
        while (bytes.len() as u64) < a.size {
            bytes.extend_from_slice(&fill.next_u64().to_le_bytes());
        }
        bytes.truncate(a.size as usize);
        stats.attachment_files += 1;
        stats.attachment_bytes += a.size;
        sink(&a.path, &bytes);
    }
    stats
}

/// Write a corpus to `dir` (created if missing). Returns its statistics.
pub fn write_to(spec: &Spec, dir: &std::path::Path) -> std::io::Result<Stats> {
    let mut err = None;
    let mut made = BTreeSet::new();
    let stats = generate(spec, |rel, bytes| {
        if err.is_some() {
            return;
        }
        let p = dir.join(rel);
        let parent = p.parent().map(std::path::Path::to_path_buf);
        let r = (|| {
            if let Some(parent) = parent
                && made.insert(parent.clone())
            {
                std::fs::create_dir_all(&parent)?;
            }
            std::fs::write(&p, bytes)
        })();
        if let Err(e) = r {
            err = Some(e);
        }
    });
    match err {
        Some(e) => Err(e),
        None => Ok(stats),
    }
}

fn fnv(s: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in s.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn capitalise(w: &str) -> String {
    let mut c = w.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

fn unique_title(rng: &mut Rng, seen: &mut BTreeSet<String>, lo: u64, hi: u64) -> String {
    let words = rng.range(lo, hi);
    let mut t = String::new();
    for i in 0..words {
        if i > 0 {
            t.push(' ');
        }
        let w = rng.pick(WORDS);
        if i == 0 {
            t.push_str(&capitalise(w))
        } else {
            t.push_str(w)
        }
    }
    let mut cand = t.clone();
    let mut k = 2;
    while !seen.insert(cand.clone()) {
        cand = format!("{t} {k}");
        k += 1;
    }
    cand
}

struct NoteCtx<'a> {
    inline_tags: bool,
    rng: &'a mut Rng,
    metas: &'a [Meta],
    atts: &'a [Attachment],
    stats: &'a mut Stats,
    projects: u64,
}

impl NoteCtx<'_> {
    fn link_target(&mut self) -> &str {
        let i = self.rng.skewed(self.metas.len() as u64) as usize;
        &self.metas[i].title
    }

    fn link(&mut self, out: &mut String) {
        self.stats.links += 1;
        let style = self.rng.below(10);
        let target = self.link_target().to_string();
        match style {
            0 => out.push_str(&format!("[[{target}|{}]]", self.rng.pick(WORDS))),
            1 => {
                let heading = capitalise(self.rng.pick(WORDS));
                if self.inline_tags {
                    out.push_str(&format!("[[{target}#{heading}]]"));
                } else {
                    out.push_str(&format!("[[{target}]]"));
                }
            }
            _ => out.push_str(&format!("[[{target}]]")),
        }
    }

    fn tags(&mut self, max: u64) -> Vec<&'static str> {
        let k = self.rng.below(max + 1);
        let mut v: Vec<&'static str> = (0..k)
            .map(|_| TAGS[self.rng.skewed(TAGS.len() as u64) as usize])
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    fn sentence(&mut self, out: &mut String, links_pct: u64) {
        let words = self.rng.range(6, 22);
        for i in 0..words {
            if i > 0 {
                out.push(' ');
            }
            if self.rng.pct(links_pct) {
                self.link(out);
            } else if i == 0 {
                out.push_str(&capitalise(self.rng.pick(WORDS)));
            } else {
                out.push_str(self.rng.pick(WORDS));
            }
        }
        out.push_str(". ");
    }

    fn paragraph(&mut self, out: &mut String, links_pct: u64) {
        for _ in 0..self.rng.range(2, 6) {
            self.sentence(out, links_pct);
        }
        if self.rng.pct(15) && self.inline_tags {
            out.push('#');
            out.push_str(self.rng.pick(TAGS));
        }
        out.push_str("\n\n");
    }

    fn checkboxes(&mut self, out: &mut String, lo: u64, hi: u64) {
        for _ in 0..self.rng.range(lo, hi) {
            self.stats.checkboxes += 1;
            out.push_str(if self.rng.pct(40) { "- [x] " } else { "- [ ] " });
            self.sentence(out, 8);
            out.push('\n');
        }
        out.push('\n');
    }

    fn embed(&mut self, out: &mut String) {
        if self.atts.is_empty() {
            return;
        }
        let a = &self.atts[self.rng.below(self.atts.len() as u64) as usize];
        self.stats.links += 1;
        out.push_str(&format!("![[{}]]\n\n", a.name));
    }

    fn body(&mut self, out: &mut String, target: u64, links_pct: u64) {
        let start = out.len() as u64;
        let mut section = 0;
        while (out.len() as u64) - start < target {
            if section > 0 && self.rng.pct(35) {
                out.push_str(&format!("## {}\n\n", capitalise(self.rng.pick(WORDS))));
            }
            self.paragraph(out, links_pct);
            if self.rng.pct(10) {
                self.checkboxes(out, 1, 5);
            }
            if self.rng.pct(6) {
                self.embed(out);
            }
            if self.rng.pct(5) {
                out.push_str("```\nlet x = 1;\n```\n\n");
            }
            section += 1;
        }
    }

    fn note(&mut self, long: bool, out: &mut String) {
        if self.rng.pct(70) {
            out.push_str("---\n");
            let tags = self.tags(4);
            if !tags.is_empty() {
                out.push_str("tags:\n");
                for t in tags {
                    out.push_str(&format!("  - {t}\n"));
                }
            }
            if self.rng.pct(15) {
                out.push_str(&format!(
                    "aliases:\n  - {}\n",
                    capitalise(self.rng.pick(WORDS))
                ));
            }
            out.push_str(&format!(
                "created: {}\n",
                date(BASE_DAY - self.rng.below(900) as i64)
            ));
            if self.rng.pct(20) {
                out.push_str(&format!("rating: {}\n", self.rng.range(1, 5)));
            }
            if self.rng.pct(15) {
                out.push_str("source: \"https://example.com/");
                out.push_str(self.rng.pick(WORDS));
                out.push_str("\"\n");
            }
            if self.rng.pct(10) {
                out.push_str("related: \"[[");
                let t = self.link_target().to_string();
                out.push_str(&t);
                out.push_str("]]\"\n");
                self.stats.links += 1;
            }
            out.push_str("---\n");
        }
        let target = if long {
            self.rng.range(20_000, 80_000)
        } else {
            match self.rng.below(100) {
                0..=39 => self.rng.range(150, 800),
                40..=74 => self.rng.range(800, 3_000),
                _ => self.rng.range(3_000, 10_000),
            }
        };
        self.body(out, target, 3);
        if self.rng.pct(25) {
            self.checkboxes(out, 1, 8);
        }
    }

    fn daily(&mut self, out: &mut String) {
        if self.rng.pct(50) {
            out.push_str(&format!("---\nmood: {}\n---\n", self.rng.range(1, 5)));
        }
        out.push_str("## Log\n\n");
        let t = self.rng.range(100, 1_500);
        self.body(out, t, 6);
        out.push_str("## Tasks\n\n");
        self.checkboxes(out, 1, 8);
    }

    fn project(&mut self, m: &Meta, out: &mut String) {
        out.push_str(&format!(
            "---\ntags:\n  - project\nstatus: active\n---\n# {}\n\n",
            m.title
        ));
        let t = self.rng.range(300, 3_000);
        self.body(out, t, 4);
    }

    fn task(&mut self, i: u64, out: &mut String) {
        let r = self.rng.below(100);
        let mut acc = 0;
        let mut status = "open";
        for (s, w) in STATUSES {
            acc += w;
            if r < acc {
                status = s;
                break;
            }
        }
        let created = BASE_DAY - self.rng.below(400) as i64;
        out.push_str("---\n");
        out.push_str(&format!("title: \"Task {i}: {}\"\n", self.rng.pick(WORDS)));
        out.push_str(&format!("status: {status}\n"));
        out.push_str(&format!("priority: {}\n", self.rng.pick(PRIORITIES)));
        if self.rng.pct(60) {
            out.push_str(&format!(
                "due: {}\n",
                date(BASE_DAY + self.rng.range(0, 120) as i64 - 60)
            ));
        }
        if self.rng.pct(40) {
            out.push_str(&format!(
                "scheduled: {}\n",
                date(BASE_DAY + self.rng.range(0, 60) as i64 - 30)
            ));
        }
        if self.rng.pct(50) {
            out.push_str(&format!("contexts:\n  - \"{}\"\n", self.rng.pick(CONTEXTS)));
        }
        if self.rng.pct(70) {
            let p = self.rng.below(self.projects) as usize;
            out.push_str(&format!("projects:\n  - \"[[{}]]\"\n", self.metas[p].title));
            self.stats.links += 1;
        }
        if self.rng.pct(30) {
            out.push_str(&format!("timeEstimate: {}\n", self.rng.range(1, 16) * 15));
        }
        if self.rng.pct(8) {
            out.push_str("recurrence: \"FREQ=WEEKLY;BYDAY=MO\"\ncomplete_instances: []\n");
        }
        if self.rng.pct(10) {
            let t = self.link_target().to_string();
            out.push_str(&format!(
                "blockedBy:\n  - uid: \"[[{t}]]\"\n    reltype: FINISHTOSTART\n"
            ));
            self.stats.links += 1;
        }
        out.push_str(&format!(
            "dateCreated: {}T09:{:02}:00Z\n",
            date(created),
            self.rng.below(60)
        ));
        out.push_str(&format!(
            "dateModified: {}T17:{:02}:00Z\n",
            date(created + self.rng.below(30) as i64),
            self.rng.below(60)
        ));
        if status == "done" {
            out.push_str(&format!(
                "completedDate: {}\n",
                date(created + self.rng.below(30) as i64)
            ));
        }
        out.push_str("tags:\n  - task\n");
        out.push_str("---\n");
        if self.rng.pct(60) {
            let t = self.rng.range(50, 1_200);
            self.body(out, t, 4);
        }
    }
}

/// The `task` type: TaskNotes' default folder, matched by path.
pub const TASK_TYPE: &str = r#"---
kind: mdbase.type
name: task
version: 1
match:
  path_glob: "TaskNotes/Tasks/**/*.md"
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title, status]
    properties:
      title: { type: string, minLength: 1 }
      status: { type: string }
      priority: { type: string }
      due: { type: string, format: date }
      scheduled: { type: string, format: date }
      contexts: { type: array, items: { type: string } }
      projects: { type: array, items: { type: string } }
      timeEstimate: { type: integer }
      dateCreated: { type: string }
      dateModified: { type: string }
      tags: { type: array, items: { type: string } }
---
"#;

/// A trimmed TaskNotes default task view (`open-tasks-view`), with the views
/// the plugin generates by default: grouped by status, sorted by due,
/// overdue, today, unscheduled.
pub const TASKS_BASE: &str = r#"# All Tasks
filters:
  and:
    - file.hasTag("task")
views:
  - type: tasknotesTaskList
    name: "Manual Order"
    groupBy:
      property: status
      direction: ASC
  - type: tasknotesTaskList
    name: "All Tasks"
    sort:
      - column: due
        direction: ASC
  - type: tasknotesTaskList
    name: "Overdue"
    filters:
      and:
        - status != "done"
        - or:
          - and:
            - due.isEmpty() == false
            - date(due) < today()
          - and:
            - scheduled.isEmpty() == false
            - date(scheduled) < today()
    sort:
      - column: due
        direction: ASC
  - type: tasknotesTaskList
    name: "Today"
    filters:
      and:
        - status != "done"
        - or:
          - date(due).format("YYYY-MM-DD") == today().format("YYYY-MM-DD")
          - date(scheduled).format("YYYY-MM-DD") == today().format("YYYY-MM-DD")
  - type: tasknotesTaskList
    name: "Unscheduled"
    filters:
      and:
        - status != "done"
        - date(due).isEmpty()
        - date(scheduled).isEmpty()
    sort:
      - column: status
        direction: ASC
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(spec: &Spec) -> (u64, Stats) {
        let mut h = 0u64;
        let s = generate(spec, |p, b| {
            h = h.rotate_left(5) ^ fnv(p) ^ (b.len() as u64);
            for c in b.chunks(4096) {
                h ^= fnv(std::str::from_utf8(&c[..c.len().min(64)]).unwrap_or("bin"));
            }
        });
        (h, s)
    }

    #[test]
    fn deterministic_and_shaped() {
        let spec = Spec::real(1_000);
        let (a, sa) = digest(&spec);
        let (b, sb) = digest(&spec);
        assert_eq!(a, b);
        assert_eq!(sa, sb);
        assert_eq!(sa.markdown_files, 1_003);
        assert!(sa.task_notes > 150 && sa.task_notes < 400, "{sa:?}");
        assert!(sa.links > 2_000, "{sa:?}");
        assert_eq!(sa.attachment_files, 100 + 1);
        let (c, _) = digest(&Spec { seed: 2, ..spec });
        assert_ne!(a, c);
    }

    #[test]
    fn tasks_profile_is_mostly_tasks() {
        let (_, s) = digest(&Spec::tasks(1_000));
        assert_eq!(s.task_notes, 980);
        assert_eq!(s.attachment_files, 0);
    }

    #[test]
    fn dates() {
        assert_eq!(date(BASE_DAY), "2026-01-01");
        assert_eq!(date(BASE_DAY + 59), "2026-03-01");
    }
}
