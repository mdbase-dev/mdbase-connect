//! Synthetic, real-shaped collections, deterministic per seed.

use std::path::Path;

use crate::{Error, Result};

/// The shape mix per 10,000 records (Connect benchmark fixtures, `records-10000`).
pub const SHAPES: &[(&str, u32)] = &[
    ("tasknotes-task", 3500),
    ("reader-source", 1500),
    ("editor-note", 1000),
    ("pickle-request", 1000),
    ("reader-annotation", 1000),
    ("pickle-response", 500),
    ("workout-exercise", 500),
    ("workout-quick-log", 400),
    ("workout-plan", 300),
    ("workout-session", 300),
];

/// Document body size buckets `(cumulative per mille, min bytes, max bytes)`, fitted to
/// the fixtures: p50 ≈ 4.5 KB, p95 ≈ 8 KB, p99 ≈ 8.4 KB, a long tail to 64 KB.
const BODY_SIZES: &[(u32, usize, usize)] = &[
    (100, 300, 2_000),
    (500, 2_000, 4_500),
    (950, 4_500, 8_000),
    (995, 8_000, 8_400),
    (1000, 8_400, 64_000),
];

/// Attachment size buckets `(cumulative per mille, min, max)`. The last bucket is
/// above the 8 MiB part size, so re-sealing exercises multi-part blobs.
const ATTACHMENT_SIZES: &[(u32, usize, usize)] = &[
    (700, 2_000, 200_000),
    (980, 200_000, 3_000_000),
    (1000, 8_500_000, 12_000_000),
];

/// A collection to generate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile {
    /// Records.
    pub records: u32,
    /// Attachments per 1,000 records.
    pub attachments_per_mille: u32,
    /// Wikilinks per record, on average, times 10.
    pub links_x10: u32,
    /// Add the non-portable and colliding paths old mirrors copied into hosted
    /// collections (R11): `?`/`:`, trailing dots, `.obsidian/`, `node_modules/`, device
    /// names, and a case-only collision. They are all migrated by renaming, and each
    /// rename must be reported.
    pub legacy_hazards: bool,
}

/// The R11 hazard paths. All but one need a rename: of the case-only pair, the first
/// claimant keeps its name.
pub const HAZARDS: &[&str] = &[
    "hazards/What? Why: now.md",
    "hazards/draft. /b.md",
    ".obsidian/workspace.md",
    "node_modules/pkg/readme.md",
    "hazards/Plain.md",
    "hazards/plain.md",
    "hazards/CON.md",
    ".git/config.md",
    ".vscode/settings.md",
];

impl Profile {
    /// A small collection for fast scenario loops (R1–R7).
    pub const SMALL: Profile = Profile {
        records: 300,
        attachments_per_mille: 50,
        links_x10: 6,
        legacy_hazards: false,
    };
    /// SMALL plus the R11 legacy path hazards.
    pub const HAZARDS: Profile = Profile {
        records: 300,
        attachments_per_mille: 50,
        links_x10: 6,
        legacy_hazards: true,
    };
    /// The benchmark sizes (R8).
    pub const R10K: Profile = Profile {
        records: 10_000,
        attachments_per_mille: 20,
        links_x10: 6,
        legacy_hazards: false,
    };
    /// As above.
    pub const R100K: Profile = Profile {
        records: 100_000,
        attachments_per_mille: 10,
        links_x10: 6,
        legacy_hazards: false,
    };
}

/// What was generated. Counts only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Generated {
    /// Records written.
    pub records: u64,
    /// Markdown bytes.
    pub record_bytes: u64,
    /// Attachments written.
    pub attachments: u64,
    /// Attachment bytes.
    pub attachment_bytes: u64,
    /// R11 hazard paths written.
    pub hazards: u64,
}

/// SplitMix64: small, deterministic, portable.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// From a seed.
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    /// The next 64 bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, n)`.
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next_u64() % n }
    }
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below((hi - lo).max(1) as u64) as usize
    }
    fn bucket(&mut self, table: &[(u32, usize, usize)]) -> usize {
        let p = self.below(1000) as u32;
        let (_, lo, hi) = table
            .iter()
            .find(|(c, _, _)| p < *c)
            .copied()
            .unwrap_or(table[table.len() - 1]);
        self.range(lo, hi)
    }
}

const WORDS: &[&str] = &[
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
    "mike",
    "november",
    "oscar",
    "papa",
    "quebec",
    "romeo",
    "sierra",
    "tango",
    "uniform",
    "victor",
    "whiskey",
    "xray",
    "yankee",
    "zulu",
    "ünïcode",
    "日本語",
    "emoji🙂",
];

fn words(rng: &mut Rng, bytes: usize) -> String {
    let mut s = String::with_capacity(bytes + 16);
    let mut col = 0;
    while s.len() < bytes {
        let w = WORDS[rng.below(WORDS.len() as u64) as usize];
        s.push_str(w);
        col += w.len() + 1;
        if col > 72 {
            s.push('\n');
            col = 0;
        } else {
            s.push(' ');
        }
    }
    s.push('\n');
    s
}

/// The path of synthetic record `i` (shape folders, stable names).
pub fn record_path(shape: &str, i: u32) -> String {
    format!("{shape}/{shape}-{i:06}.md")
}

/// Generate a collection under `root` (which must be empty or absent).
///
/// The output is plain files: `mdbase.yaml`, a type per shape, records with frontmatter
/// and wikilinks, and attachments under `attachments/`. The collection's display name in
/// LAB must start with `[test]` (`mdbase-lab` skill), and the driver sets it.
pub fn generate(root: &Path, profile: &Profile, seed: u64) -> Result<Generated> {
    let io = |e: std::io::Error| Error::Invalid(format!("generate: {e}"));
    if root.exists() && std::fs::read_dir(root).map_err(io)?.next().is_some() {
        return Err(Error::Invalid("generate into an empty folder only".into()));
    }
    let mut rng = Rng::new(seed);
    let mut g = Generated::default();
    std::fs::create_dir_all(root.join("_types")).map_err(io)?;
    std::fs::write(
        root.join("mdbase.yaml"),
        "spec_version: \"0.2.0\"\nname: \"[test] rehearsal\"\n",
    )
    .map_err(io)?;
    for (shape, _) in SHAPES {
        std::fs::write(
            root.join("_types").join(format!("{shape}.md")),
            format!(
                "---\nname: {shape}\nmatch:\n  path_glob: \"{shape}/**\"\nfields:\n  title: {{type: string}}\n  status: {{type: string}}\n  tags: {{type: list, items: {{type: string}}}}\n---\n"
            ),
        )
        .map_err(io)?;
    }

    let total: u32 = SHAPES.iter().map(|(_, w)| w).sum();
    let mut counts: Vec<(&str, u32)> = SHAPES
        .iter()
        .map(|(s, w)| {
            (
                *s,
                (u64::from(profile.records) * u64::from(*w) / u64::from(total)) as u32,
            )
        })
        .collect();
    let assigned: u32 = counts.iter().map(|(_, n)| n).sum();
    counts[0].1 += profile.records - assigned;

    let mut all_paths: Vec<String> = Vec::with_capacity(profile.records as usize);
    for (shape, n) in &counts {
        for i in 0..*n {
            all_paths.push(record_path(shape, i));
        }
    }
    const STATUS: &[&str] = &["open", "in-progress", "waiting", "done", "cancelled"];
    for (shape, n) in &counts {
        std::fs::create_dir_all(root.join(shape)).map_err(io)?;
        for i in 0..*n {
            let path = record_path(shape, i);
            let mut fm = format!(
                "---\ntitle: \"{shape} {i}\"\nstatus: {}\n",
                STATUS[rng.below(STATUS.len() as u64) as usize]
            );
            let tags = rng.below(4);
            if tags > 0 {
                fm.push_str("tags:\n");
                for t in 0..tags {
                    fm.push_str(&format!("  - t{}\n", (rng.below(40) + t) % 40));
                }
            }
            fm.push_str("---\n");
            let size = rng.bucket(BODY_SIZES).saturating_sub(fm.len());
            let mut body = words(&mut rng, size);
            let links = rng.below(u64::from(profile.links_x10) * 2 + 1) / 10;
            for _ in 0..links {
                let target = &all_paths[rng.below(all_paths.len() as u64) as usize];
                body.push_str(&format!("See [[{}]].\n", target.trim_end_matches(".md")));
            }
            let doc = fm + "\n" + &body;
            g.record_bytes += doc.len() as u64;
            std::fs::write(root.join(&path), doc).map_err(io)?;
            g.records += 1;
        }
    }

    if profile.legacy_hazards {
        for (i, path) in HAZARDS.iter().enumerate() {
            let full = root.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).map_err(io)?;
            }
            let doc = format!("---\ntitle: \"hazard {i}\"\nstatus: open\n---\n\nlegacy path {i}\n");
            g.record_bytes += doc.len() as u64;
            std::fs::write(&full, doc).map_err(io)?;
            g.hazards += 1;
        }
    }

    let attachments = u64::from(profile.records) * u64::from(profile.attachments_per_mille) / 1000;
    if attachments > 0 {
        std::fs::create_dir_all(root.join("attachments")).map_err(io)?;
    }
    for i in 0..attachments {
        let size = rng.bucket(ATTACHMENT_SIZES);
        let mut bytes = vec![0u8; size];
        for chunk in bytes.chunks_mut(8) {
            let v = rng.next_u64().to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
        std::fs::write(
            root.join("attachments").join(format!("file-{i:05}.bin")),
            &bytes,
        )
        .map_err(io)?;
        g.attachments += 1;
        g.attachment_bytes += size as u64;
    }
    Ok(g)
}
