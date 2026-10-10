//! # mdbn-sim: the deterministic simulator
//!
//! **Responsibility.** Runs the real replica service, file-backed store and log
//! service under simulated time, network, file systems (with per-OS platform
//! models), editors and crashes, from a single seed, and checks oracles: no lost
//! acknowledged writes, no lost user edits, convergence, holds surfaced, zero
//! plaintext at the log service, and a determinism digest (file-layer correctness and performance;
//! simulation qualification). A failing seed replays exactly.
//!
//! | Module | What |
//! |---|---|
//! | [`rng`] | seeded randomness, per-actor streams, integer probabilities |
//! | [`sched`] | simulated time and the event queue |
//! | [`net`] | latency, loss, partitions, reordering; stream vs datagram links |
//! | [`disk`] | inodes, namespace, fsync, power loss with torn and reverted writes |
//! | [`kv`] | the transactional store model behind `IndexStorage` |
//! | [`platform`] | machines, processes, syscall hooks (interleave, stall, crash), Linux / macOS / Windows semantics |
//! | [`editors`] | external editors syscall by syscall |
//! | [`fileplatform`] | the OS models behind `mdbn_store_file::FilePlatform`, so the real store runs in the sim |
//! | [`obsidian`] | the Obsidian editor: throttled blind saves, reload/merge, revert-on-save, the editor fence |
//! | [`publish`] | the reference publish protocols (N, X, P, PS, PSE, Windows D) |
//! | [`world`] | actors, local processes, chaos, the run loop, quiescence, reports |
//! | [`oracle`] | tokens, the acknowledged-write ledger, violation classes |
//! | [`sut`] | the system under test: real replica engine + file store nodes, the log service actor |
//! | [`tap`] | no plaintext / no key material at untrusted parties (log service, private hosted replica) |
//! | [`trace`] | the trace and the determinism digest |
//! | [`scenario`] | named scenarios and the single-seed entry point |
//!
//! **Rules.** The library is deterministic: all randomness comes from the seed via
//! [`rng::SimRng`], all time from the simulated clock, no hash-map iteration. Only
//! the binary touches the real environment (arguments, threads, output files).
//!
//! **Allowed dependencies.** Internal: core, wire, replica, store-file,
//! log-service. Never `mdbn-platform-native` or `mdbn-store-pg`: the simulator
//! replaces real backends with models.

pub mod disk;
pub mod editors;
pub mod fileplatform;
pub mod kv;
pub mod net;
pub mod obsidian;
pub mod oracle;
pub mod platform;
pub mod publish;
pub mod rng;
pub mod scenario;
pub mod scenarios;
pub mod sched;
pub mod sut;
pub mod tap;
pub mod trace;
pub mod world;

pub use scenario::{Opts, run_checked, run_seed};
pub use world::{Report, World};
