//! Repository automation. Run `cargo xtask help`.
//!
//! Every CI check is a command here, so it runs the same way locally.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod arch;

use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

use serde_json::Value;

type Result<T> = std::result::Result<T, String>;

const USAGE: &str = "\
cargo xtask <command>

  arch          crate dependency direction, portable dependency trees, lint
                inheritance, determinism source scan
  wasm          build target/wasm/runtime.wasm (wasm-release profile + wasm-opt -Oz)
  wasm-size     report runtime.wasm raw/gzip/brotli sizes (no size gate)
  wasm-app      test/build app-runtime.wasm, report sizes, SQLite ABI smoke
  mdbase-wasm   build target/wasm/mdbase-core.wasm (the npm `mdbase` helpers) and copy
                it to packages/mdbase/wasm/
  determinism   replay conformance/determinism/*.log natively and in WASM (Node);
                outputs must match each other and the .expected.json golden
  sdk           the TS SDK in packages/sdk: npm ci, typecheck, test, build, size
  obsidian      the Obsidian runtime in packages/obsidian-runtime: npm ci, typecheck, test, build
  mdbase        the npm `mdbase` package in packages/mdbase: npm ci, typecheck, test, build
                (run `mdbase-wasm` first)
  ci            everything CI runs, in CI order (needs cargo-deny and Node)
";

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let result = match cmd.as_str() {
        "arch" => arch::run(),
        "wasm" => wasm_build().map(|_| ()),
        "wasm-size" => wasm_size(),
        "wasm-app" => wasm_app(),
        "mdbase-wasm" => mdbase_wasm().map(|_| ()),
        "determinism" => determinism(),
        "sdk" => sdk(),
        "obsidian" => obsidian(),
        "mdbase" => mdbase(),
        "ci" => ci(),
        "help" | "-h" | "--help" => {
            print!("{USAGE}");
            Ok(())
        }
        _ => Err(format!("unknown command {cmd:?}\n\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask {cmd}: {e}");
            ExitCode::FAILURE
        }
    }
}

pub(crate) fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn cargo() -> Command {
    let mut c = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    c.current_dir(repo_root());
    c
}

/// Run a command; error with its name if it fails.
fn run(mut c: Command) -> Result<()> {
    let shown = format!("{c:?}");
    eprintln!("$ {shown}");
    let status = c.status().map_err(|e| format!("{shown}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{shown} failed ({status})"))
    }
}

/// Run a command and capture stdout.
fn output(mut c: Command) -> Result<String> {
    let shown = format!("{c:?}");
    let out = c.output().map_err(|e| format!("{shown}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{shown} failed ({})\n{}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

pub(crate) fn cargo_metadata(extra: &[&str]) -> Result<Value> {
    let mut c = cargo();
    c.args(["metadata", "--format-version", "1"]).args(extra);
    serde_json::from_str(&output(c)?).map_err(|e| e.to_string())
}

/// Append Markdown to the GitHub job summary, if there is one.
fn job_summary(md: &str) {
    if let Some(path) = std::env::var_os("GITHUB_STEP_SUMMARY")
        && let Ok(mut f) = fs::OpenOptions::new().append(true).create(true).open(path)
    {
        let _ = writeln!(f, "{md}");
    }
}

/// Cargo's target directory (honours `CARGO_TARGET_DIR` and config).
fn target_dir() -> PathBuf {
    cargo_metadata(&["--no-deps"])
        .ok()
        .and_then(|m| m["target_directory"].as_str().map(PathBuf::from))
        .unwrap_or_else(|| repo_root().join("target"))
}

fn wasm_dir() -> PathBuf {
    target_dir().join("wasm")
}

/// wasm-opt from the pinned `binaryen` npm package (tools/wasm), or `$WASM_OPT`.
fn wasm_opt() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("WASM_OPT") {
        return Ok(PathBuf::from(p));
    }
    let p = repo_root().join("tools/wasm/node_modules/.bin/wasm-opt");
    if p.exists() {
        Ok(p)
    } else {
        Err("wasm-opt not found; run `npm ci --prefix tools/wasm` (pinned binaryen)".into())
    }
}

/// Features Rust enables by default on wasm32-unknown-unknown. `strip = true`
/// removes the target_features section, so wasm-opt must be told explicitly.
const WASM_FEATURES: &[&str] = &[
    "--enable-bulk-memory",
    "--enable-bulk-memory-opt",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-reference-types",
    "--enable-multivalue",
];

fn wasm_build() -> Result<PathBuf> {
    build_wasm_module("mdbn-wasm", "mdbn_wasm", "runtime")
}

/// Dedicated first-party artifact; ordinary runtime imports remain compatible.
fn wasm_app() -> Result<()> {
    let mut c = cargo();
    c.args([
        "test",
        "--locked",
        "-p",
        "mdbn-wasm",
        "--features",
        "app-runtime",
    ]);
    run(c)?;
    let mut c = cargo();
    c.args([
        "clippy",
        "--locked",
        "-p",
        "mdbn-wasm",
        "--target",
        "wasm32-unknown-unknown",
        "--features",
        "app-runtime",
        "--",
        "-D",
        "warnings",
    ]);
    run(c)?;
    let out =
        build_wasm_module_features("mdbn-wasm", "mdbn_wasm", "app-runtime", &["app-runtime"])?;
    let mut c = Command::new("node");
    c.args(["scripts/wasm-size.mjs"])
        .arg(&out)
        .arg("tools/wasm/budget.json");
    run(c)?;
    let mut c = Command::new("npm");
    c.args(["ci", "--prefix", "packages/sdk", "--no-audit", "--no-fund"]);
    run(c)?;
    let mut c = Command::new("node");
    c.arg("scripts/app-wasm-smoke.mjs").arg(out);
    run(c)
}

/// `mdbase-core.wasm`: the pure helpers behind the npm `mdbase` package
/// (`crates/mdbase-wasm`). Also copied into `packages/mdbase/wasm/` so the
/// package's tests and build find it.
fn mdbase_wasm() -> Result<PathBuf> {
    let out = build_wasm_module("mdbase-wasm", "mdbase_wasm", "mdbase-core")?;
    let pkg = repo_root().join("packages/mdbase/wasm");
    fs::create_dir_all(&pkg).map_err(|e| e.to_string())?;
    let dest = pkg.join("mdbase-core.wasm");
    fs::copy(&out, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    println!("copied to {}", dest.display());
    Ok(out)
}

/// Build `package` for wasm32 with the `wasm-release` profile, then
/// `wasm-opt -Oz` it to `target/wasm/<name>.wasm`.
fn build_wasm_module(package: &str, lib: &str, name: &str) -> Result<PathBuf> {
    build_wasm_module_features(package, lib, name, &[])
}

fn build_wasm_module_features(
    package: &str,
    lib: &str,
    name: &str,
    features: &[&str],
) -> Result<PathBuf> {
    let mut c = cargo();
    c.args([
        "build",
        "--locked",
        "-p",
        package,
        "--lib",
        "--target",
        "wasm32-unknown-unknown",
        "--profile",
        "wasm-release",
    ]);
    if !features.is_empty() {
        c.args(["--features", &features.join(",")]);
    }
    run(c)?;
    let built = target_dir().join(format!("wasm32-unknown-unknown/wasm-release/{lib}.wasm"));
    let dir = wasm_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let unopt = dir.join(format!("{name}.unopt.wasm"));
    fs::copy(&built, &unopt).map_err(|e| format!("{}: {e}", built.display()))?;
    let out = dir.join(format!("{name}.wasm"));
    let mut c = Command::new(wasm_opt()?);
    // `--converge` repeats -Oz until the module stops shrinking (about 0.4% gzip).
    c.args(["-Oz", "--converge"])
        .args(WASM_FEATURES)
        .args(["--strip-debug", "--strip-producers"])
        .arg(&unopt)
        .arg("-o")
        .arg(&out);
    run(c)?;
    println!("wrote {}", out.display());
    Ok(out)
}

fn wasm_size() -> Result<()> {
    let wasm = wasm_dir().join("runtime.wasm");
    if !wasm.exists() {
        return Err(format!(
            "{} missing; run `cargo xtask wasm` first",
            wasm.display()
        ));
    }
    let mut c = Command::new("node");
    c.current_dir(repo_root())
        .arg("scripts/wasm-size.mjs")
        .arg(&wasm)
        .arg("tools/wasm/budget.json");
    run(c)
}

fn determinism() -> Result<()> {
    let root = repo_root();
    let wasm = wasm_dir().join("runtime.wasm");
    if !wasm.exists() {
        return Err(format!(
            "{} missing; run `cargo xtask wasm` first",
            wasm.display()
        ));
    }
    let mut c = cargo();
    c.args([
        "build",
        "--locked",
        "--quiet",
        "-p",
        "mdbn-conformance",
        "--bin",
        "replay",
    ]);
    run(c)?;
    let native_bin = target_dir().join("debug/replay");
    let dir = root.join("conformance/determinism");
    let mut logs: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "log"))
        .collect();
    logs.sort();
    if logs.is_empty() {
        return Err(format!("no *.log fixtures in {}", dir.display()));
    }
    let mut md = String::from(
        "## Determinism: native vs WASM replay\n\n| Fixture | native | wasm | golden |\n|---|---|---|---|\n",
    );
    let mut failures = Vec::new();
    for log in &logs {
        let name = log
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let mut n = Command::new(&native_bin);
        n.arg(log);
        let native = output(n)?.trim_end().to_owned();
        let mut w = Command::new("node");
        w.current_dir(&root)
            .arg("scripts/wasm-replay.mjs")
            .arg(&wasm)
            .arg(log);
        let in_wasm = output(w)?.trim_end().to_owned();
        let golden_path = log.with_extension("expected.json");
        let golden = fs::read_to_string(&golden_path)
            .map_err(|e| format!("{}: {e}", golden_path.display()))?
            .trim_end()
            .to_owned();
        let mark = |ok: bool| if ok { "match" } else { "**DIFFERS**" };
        let _ = writeln!(
            md,
            "| `{name}` | `{}` | {} | {} |",
            short_digest(&native),
            mark(in_wasm == native),
            mark(native == golden)
        );
        println!("{name}\n  native: {native}\n  wasm:   {in_wasm}\n  golden: {golden}");
        if in_wasm != native {
            failures.push(format!("{name}: WASM output differs from native"));
        }
        if native != golden {
            failures.push(format!(
                "{name}: native output differs from {} (update it only for an intended semantics change)",
                golden_path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    job_summary(&md);
    if failures.is_empty() {
        println!(
            "determinism: {} fixture(s), native == wasm == golden",
            logs.len()
        );
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

fn short_digest(json: &str) -> String {
    json.split("\"digest\":\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .unwrap_or(json)
        .to_owned()
}

/// The TS SDK (`packages/sdk`): typecheck, tests (incl. the golden wire fixtures), build.
fn sdk() -> Result<()> {
    npm_package("packages/sdk")
}

/// The Obsidian runtime (`packages/obsidian-runtime`): typecheck, tests, build.
fn obsidian() -> Result<()> {
    npm_package("packages/obsidian-runtime")
}

/// The npm `mdbase` package (`packages/mdbase`): the Node addon, then
/// typecheck, tests, build. Needs `cargo xtask mdbase-wasm` first.
fn mdbase() -> Result<()> {
    let mut c = Command::new("node");
    c.current_dir(repo_root().join("packages/mdbase"))
        .args(["scripts/build-native.mjs"]);
    run(c)?;
    npm_package("packages/mdbase")
}

fn npm_package(path: &str) -> Result<()> {
    let dir = repo_root().join(path);
    for args in [
        &["ci", "--no-audit", "--no-fund"][..],
        &["run", "typecheck"],
        &["test"],
        &["run", "build"],
        &["run", "--if-present", "size"],
    ] {
        let mut c = Command::new("npm");
        c.current_dir(&dir).args(args);
        run(c)?;
    }
    Ok(())
}

fn ci() -> Result<()> {
    // Same order as .github/workflows/ci.yml: fast lane, then wasm, then sim.
    let steps: &[&[&str]] = &[
        &["fmt", "--all", "--check"],
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--locked",
            "--",
            "-D",
            "warnings",
        ],
        &["xtask", "arch"],
        &["deny", "--locked", "check"],
        &["test", "--workspace", "--locked"],
        &[
            "run",
            "--locked",
            "-p",
            "mdbn-conformance",
            "--bin",
            "spec-conformance",
        ],
        &[
            "clippy",
            "--locked",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "mdbn-core",
            "-p",
            "mdbn-wire",
            "-p",
            "mdbn-replica",
            "-p",
            "mdbn-store-file",
            "-p",
            "mdbn-wasm",
            "-p",
            "mdbase-wasm",
            "--",
            "-D",
            "warnings",
        ],
    ];
    for args in steps {
        let mut c = cargo();
        c.args(*args);
        run(c)?;
    }
    wasm_build()?;
    wasm_size()?;
    determinism()?;
    wasm_app()?;
    sdk()?;
    obsidian()?;
    mdbase_wasm()?;
    mdbase()?;
    let mut c = cargo();
    c.args([
        "run",
        "--locked",
        "--release",
        "-p",
        "mdbn-sim",
        "--",
        "--seeds",
        "1000",
    ]);
    run(c)?;
    println!("ci: all checks passed");
    Ok(())
}
