//! Isolated UNVERIFIED candidate ledger, never normal sg_* staging or swap.
//! CAS predicates and quota admission are repeated in each serialized SQL write.
//! Reserved capacities stay charged across abort/unknown/reopen; no cleanup API.
use super::*;
use crate::index::{BorrowedBlob, IndexDurability};
use mdbn_replica::mirror_admission::{
    self,
    candidate::{self, Error, Request},
    install_budget::{self, Buffer, Retained, Work, WorkingSet},
};

const TABLES: [&str; 2] = [
    "CREATE TABLE IF NOT EXISTS mi_candidate(id BLOB PRIMARY KEY, binding BLOB NOT NULL CHECK(length(binding)<=1024), charge INTEGER NOT NULL CHECK(charge=1024)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS mi_part(candidate BLOB NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<262144), bound INTEGER NOT NULL CHECK(bound>0 AND bound<=4194304), charge INTEGER NOT NULL CHECK(charge=bound+128), body BLOB CHECK(body IS NULL OR length(body)<=bound), PRIMARY KEY(candidate,ordinal)) WITHOUT ROWID",
];
// Conservative simultaneous allowance for bounded request CBOR, SQL strings,
// parameters, and tiny read/write reports. No body/readback is duplicated.
// This is logical workspace accounting, not allocator/SQLite/WAL certification.
const CONTROL_BYTES: u64 = 64 * 1024;
const TOTAL: &str =
    "((SELECT coalesce(sum(charge),0) FROM qc)+(SELECT coalesce(sum(charge),0) FROM qp))";
const SCAN_ROWS: u64 = 64;
const SCAN_KEY_BYTES: usize = 1024;
const SCAN_WORK_BYTES: u64 = 4096;
const SCAN_MEMORY_BYTES: u64 = 256 * 1024;
const HEADER_CHARGE: &str =
    "CASE WHEN typeof(charge)='integer' AND charge=1024 THEN charge ELSE NULL END";
const PART_CHARGE: &str = "CASE WHEN typeof(bound)='integer' AND bound>0 AND bound<=4194304 AND typeof(charge)='integer' AND charge=bound+128 AND (body IS NULL OR (typeof(body)='blob' AND length(body)<=bound)) THEN charge ELSE NULL END";
#[derive(Default)]
struct Quota {
    retained: Retained,
    parts: u64,
}
impl Quota {
    fn sql(&self, working: &WorkingSet) -> Result<(String, String), Error> {
        let candidates = self
            .retained
            .candidates
            .checked_add(1)
            .ok_or(Error::Budget(install_budget::Error::AccountingOverflow))?;
        let parts = self
            .parts
            .checked_add(1)
            .ok_or(Error::Budget(install_budget::Error::AccountingOverflow))?;
        working.precharge(Work {
            pass_bytes: candidates
                .saturating_add(parts)
                .saturating_mul(SCAN_WORK_BYTES)
                .saturating_mul(8)
                .saturating_add(CONTROL_BYTES),
            ..Work::default()
        })?;
        // The extra row detects growth without scanning an unbounded suffix.
        // These limits are private checked integer DATA, never authority.
        Ok((
            format!(
                "qc AS MATERIALIZED(SELECT {HEADER_CHARGE} AS charge FROM mi_candidate LIMIT {candidates}),qp AS MATERIALIZED(SELECT {PART_CHARGE} AS charge FROM mi_part LIMIT {parts})"
            ),
            format!(
                "(SELECT count(*) FROM qc)={} AND (SELECT count(*) FROM qp)={} AND (SELECT count(charge) FROM qc)=(SELECT count(*) FROM qc) AND (SELECT count(charge) FROM qp)=(SELECT count(*) FROM qp)",
                self.retained.candidates, self.parts
            ),
        ))
    }
}
fn control_work(working: &WorkingSet) -> Result<(), Error> {
    // Covers bounded validation, repeated request/gate/head encodings, keyed
    // lookups, SQL construction and scalar reports; row/body passes pay extra.
    working.precharge_candidate(Work {
        pass_bytes: 16 * CONTROL_BYTES,
        ..Work::default()
    })?;
    Ok(())
}
const GATE: &str = "EXISTS(SELECT 1 FROM st_meta WHERE k=? AND v=?) AND EXISTS(SELECT 1 FROM st_meta WHERE k=? AND v=?) AND coalesce((SELECT v FROM st_kv WHERE k='head'),?)=?";
fn candidate_index_error(error: IndexError) -> Error {
    // Drop diagnostics inside the charged operation, without formatting or
    // cloning another String. The returned category always requires reopen.
    Error::Storage(match error.kind {
        IndexErrorKind::Full => candidate::StorageRefusal::Full,
        IndexErrorKind::Corrupt => candidate::StorageRefusal::Corrupt,
        _ => candidate::StorageRefusal::Io,
    })
}
// Candidate reads use fixed categories too: the ordinary store query adapter
// formats native diagnostics, which this charged closed operation never needs.
fn query<I: IndexStorage>(
    s: &SqlStore<I>,
    sql: &str,
    params: Vec<SqlValue>,
) -> Result<StmtResult, Error> {
    let mut reports = s
        .index
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![st(sql, params)],
        })
        .map_err(candidate_index_error)?;
    if reports.len() != 1 {
        return Err(Error::Storage(candidate::StorageRefusal::Corrupt));
    }
    reports
        .pop()
        .ok_or(Error::Storage(candidate::StorageRefusal::Corrupt))
}
fn one<I: IndexStorage, T>(
    s: &SqlStore<I>,
    sql: &str,
    params: Vec<SqlValue>,
    read: impl Fn(&[SqlValue]) -> Result<T, Error>,
) -> Result<Option<T>, Error> {
    let report = query(s, sql, params)?;
    report.rows().next().map(read).transpose()
}
fn acknowledge_existing<I: IndexStorage>(s: &SqlStore<I>) -> Result<(), Error> {
    // An idempotent read is not a durability barrier. The caller's control
    // reservation remains live until this existing evidence is acknowledged.
    s.index
        .borrow_mut()
        .defer_sync(false)
        .map_err(candidate_index_error)?;
    Ok(())
}
fn run<I: IndexStorage>(s: &mut SqlStore<I>, stmts: Vec<Stmt>) -> Result<Vec<StmtResult>, Error> {
    let mut index = s.index.borrow_mut();
    // A private candidate acknowledgment must never remain in an ordinary
    // deferred-durability window. Failure here is unknown, requiring reopen.
    index.defer_sync(false).map_err(candidate_index_error)?;
    index
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts,
        })
        .map_err(candidate_index_error)
}
fn run_borrowed<I: IndexStorage>(
    s: &mut SqlStore<I>,
    statement: Stmt,
    body: &Buffer,
) -> Result<Vec<StmtResult>, Error> {
    let batch = Batch {
        mode: BatchMode::Transaction,
        stmts: vec![statement],
    };
    let mut index = s.index.borrow_mut();
    // The input's own charge and control charge remain live across both the
    // final deferred barrier and the bounded synchronous borrowed write.
    index.defer_sync(false).map_err(candidate_index_error)?;
    index
        .run_with_borrowed_blob(
            &batch,
            BorrowedBlob {
                parameter: 0,
                bytes: body.as_slice(),
            },
        )
        .map_err(candidate_index_error)
}
fn current<I: IndexStorage>(s: &SqlStore<I>, r: &Request) -> Result<(), Error> {
    r.validate()?;
    if s.index.borrow().info().durability != IndexDurability::Durable {
        return Err(Error::Unsupported);
    }
    // Compare inside SQLite and project one boolean. Never allocate/decode an
    // arbitrarily large corrupt/future marker, identity, or head blob.
    let matches = one(s, &format!("SELECT {GATE}"), gate(r)?, |row| match row {
        [SqlValue::Integer(n)] => Ok(*n == 1),
        _ => Err(Error::Storage(candidate::StorageRefusal::Corrupt)),
    })?
    .unwrap_or(false);
    if matches { Ok(()) } else { Err(Error::Drift) }
}
fn gate(r: &Request) -> Result<Vec<SqlValue>, Error> {
    let mut identity = Vec::with_capacity(32);
    identity.extend_from_slice(&r.identity.collection);
    identity.extend_from_slice(&r.identity.replica);
    Ok(vec![
        SqlValue::Text(mirror_admission::META.into()),
        blob(r.fence.encode()?),
        SqlValue::Text(mdbn_replica::store::meta_keys::IDENTITY.into()),
        blob(identity),
        blob(head_c(&Head::GENESIS)?),
        blob(head_c(&r.old_head)?),
    ])
}
fn initialized<I: IndexStorage>(s: &SqlStore<I>) -> Result<bool, Error> {
    Ok(one(
        s,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mi_candidate'",
        vec![],
        |_| Ok(true),
    )?
    .unwrap_or(false))
}
fn usage<I: IndexStorage>(s: &SqlStore<I>, working: &WorkingSet) -> Result<Quota, Error> {
    let candidates = initialized(s)?;
    let parts = one(
        s,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mi_part'",
        vec![],
        |_| Ok(true),
    )?
    .unwrap_or(false);
    if !candidates && !parts {
        return Ok(Quota::default());
    }
    // Do not report zero usage for an orphaned/future half-ledger.
    if candidates != parts {
        return Err(Error::Unsupported);
    }
    let _scan = working.reserve(SCAN_MEMORY_BYTES)?;
    let mut quota = Quota::default();
    for parts in [false, true] {
        let table = if parts { "mi_part" } else { "mi_candidate" };
        let key = if parts { "candidate" } else { "id" };
        let order = if parts { "candidate,ordinal" } else { "id" };
        let mut cursor: Option<(Vec<u8>, i64)> = None;
        loop {
            working.precharge(Work {
                pass_bytes: SCAN_ROWS * SCAN_WORK_BYTES + CONTROL_BYTES,
                ..Work::default()
            })?;
            let (predicate, params) = match &cursor {
                None => (String::new(), vec![]),
                Some((key, ordinal)) if parts => (
                    "WHERE (candidate,ordinal)>(?,?)".into(),
                    vec![blob(key.clone()), SqlValue::Integer(*ordinal)],
                ),
                Some((key, _)) => ("WHERE id>?".into(), vec![blob(key.clone())]),
            };
            // Project bounded keys/scalars before the backend copies values.
            // Unknown old IDs still count; oversized/non-blob keys refuse the
            // complete projection rather than becoming a partial undercount.
            let ordinal = if parts {
                "CASE WHEN typeof(ordinal)='integer' AND ordinal>=0 THEN ordinal ELSE NULL END"
            } else {
                "0"
            };
            let charge = if parts { PART_CHARGE } else { HEADER_CHARGE };
            let statement = st(
                &format!(
                    "SELECT CASE WHEN typeof({key})='blob' AND length({key})<={SCAN_KEY_BYTES} THEN {key} ELSE NULL END,{ordinal},{charge} FROM {table} {predicate} ORDER BY {order} LIMIT {SCAN_ROWS}"
                ),
                params,
            );
            let reports = s
                .index
                .borrow_mut()
                .run(&Batch {
                    mode: BatchMode::Autocommit,
                    stmts: vec![statement],
                })
                .map_err(candidate_index_error)?;
            let [report] = reports.as_slice() else {
                return Err(Error::Invalid);
            };
            if report.columns != 3 || report.values.len() % 3 != 0 || report.row_count() > SCAN_ROWS
            {
                return Err(Error::Invalid);
            }
            for row in report.rows() {
                let [
                    SqlValue::Blob(key),
                    SqlValue::Integer(ordinal),
                    SqlValue::Integer(charge),
                ] = row
                else {
                    return Err(Error::Storage(candidate::StorageRefusal::Corrupt));
                };
                if key.len() > SCAN_KEY_BYTES
                    || *ordinal < 0
                    || *charge < 0
                    || cursor
                        .as_ref()
                        .is_some_and(|old| (key.as_slice(), *ordinal) <= (old.0.as_slice(), old.1))
                {
                    return Err(Error::Invalid);
                }
                let next = quota.retained.adding(u64::from(!parts), *charge as u64)?;
                quota.retained = next;
                if parts {
                    quota.parts = quota
                        .parts
                        .checked_add(1)
                        .ok_or(Error::Budget(install_budget::Error::AccountingOverflow))?;
                }
                cursor = Some((key.clone(), *ordinal));
            }
            if report.row_count() < SCAN_ROWS {
                break;
            }
        }
    }
    Ok(quota)
}
fn binding<I: IndexStorage>(s: &SqlStore<I>, r: &Request) -> Result<Option<Vec<u8>>, Error> {
    if !initialized(s)? {
        return Ok(None);
    }
    one(
        s,
        "SELECT CASE WHEN length(binding)<=1024 THEN binding ELSE NULL END FROM mi_candidate WHERE id=?",
        vec![blob(r.candidate.to_vec())],
        |row| match row {
            [SqlValue::Blob(bytes)] => Ok(bytes.clone()),
            _ => Err(Error::Storage(candidate::StorageRefusal::Corrupt)),
        },
    )
}
fn exact<I: IndexStorage>(s: &SqlStore<I>, r: &Request) -> Result<Vec<u8>, Error> {
    current(s, r)?;
    let bytes = r.binding()?;
    if binding(s, r)?.as_deref() != Some(bytes.as_slice()) {
        return Err(Error::Conflict);
    }
    Ok(bytes)
}
fn slot<I: IndexStorage>(s: &SqlStore<I>, r: &Request, ordinal: u64) -> Result<Option<u64>, Error> {
    one(
        s,
        "SELECT CASE WHEN typeof(bound)='integer' AND bound>0 AND bound<=4194304 THEN bound ELSE NULL END FROM mi_part WHERE candidate=? AND ordinal=?",
        vec![blob(r.candidate.to_vec()), wide_int(ordinal)?],
        |row| match row {
            [SqlValue::Integer(n)] => {
                u64::try_from(*n).map_err(|_| Error::Storage(candidate::StorageRefusal::Corrupt))
            }
            _ => Err(Error::Storage(candidate::StorageRefusal::Corrupt)),
        },
    )
}

pub(super) fn begin<I: IndexStorage>(
    s: &mut SqlStore<I>,
    r: &Request,
    working: &WorkingSet,
) -> Result<(), Error> {
    control_work(working)?;
    let _control = working.reserve(CONTROL_BYTES)?;
    r.validate()?;
    current(s, r)?;
    let old = binding(s, r)?;
    // Prospective quota BEFORE constructing encoded candidate metadata.
    let quota = usage(s, working)?;
    quota.retained.adding(
        u64::from(old.is_none()),
        if old.is_none() {
            candidate::HEADER_BYTES
        } else {
            0
        },
    )?;
    let encoded = r.binding()?;
    if let Some(old) = old {
        return if old == encoded {
            acknowledge_existing(s)
        } else {
            Err(Error::Conflict)
        };
    }
    let mut stmts = TABLES.iter().map(|sql| st(sql, vec![])).collect::<Vec<_>>();
    let mut params = vec![blob(r.candidate.to_vec()), blob(encoded)];
    params.extend(gate(r)?);
    let (bounded, counts) = quota.sql(working)?;
    stmts.push(st(&format!("WITH {bounded} INSERT OR IGNORE INTO mi_candidate(id,binding,charge) SELECT ?,?,1024 WHERE {GATE} AND {counts} AND (SELECT count(*) FROM qc)<100000 AND {TOTAL}+1024<=4294967296"),params));
    run(s, stmts)?;
    current(s, r)?;
    if binding(s, r)?.as_deref() == Some(r.binding()?.as_slice()) {
        return Ok(());
    }
    usage(s, working)?
        .retained
        .adding(1, candidate::HEADER_BYTES)?;
    Err(Error::Conflict)
}
pub(super) fn reserve<I: IndexStorage>(
    s: &mut SqlStore<I>,
    r: &Request,
    ordinal: u64,
    bytes: u64,
    working: &WorkingSet,
) -> Result<(), Error> {
    control_work(working)?;
    let _control = working.reserve(CONTROL_BYTES)?;
    let charge = candidate::part_charge(ordinal, bytes)?;
    let encoded = exact(s, r)?;
    if let Some(old) = slot(s, r, ordinal)? {
        return if old == bytes {
            acknowledge_existing(s)
        } else {
            Err(Error::Conflict)
        };
    }
    let quota = usage(s, working)?;
    quota.retained.adding(0, charge)?;
    let (bounded, counts) = quota.sql(working)?;
    let mut params = vec![
        blob(r.candidate.to_vec()),
        wide_int(ordinal)?,
        wide_int(bytes)?,
        wide_int(charge)?,
        blob(r.candidate.to_vec()),
        blob(encoded),
    ];
    params.extend(gate(r)?);
    params.push(wide_int(charge)?);
    run(
        s,
        vec![st(
            &format!(
                "WITH {bounded} INSERT OR IGNORE INTO mi_part(candidate,ordinal,bound,charge) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM mi_candidate WHERE id=? AND binding=?) AND {GATE} AND {counts} AND {TOTAL}+?<=4294967296"
            ),
            params,
        )],
    )?;
    current(s, r)?;
    if slot(s, r, ordinal)? == Some(bytes) {
        return Ok(());
    }
    usage(s, working)?.retained.adding(0, charge)?;
    Err(Error::Conflict)
}
pub(super) fn read<I: IndexStorage>(
    s: &mut SqlStore<I>,
    r: &Request,
    ordinal: u64,
    expected_address: &Hash,
    working: &WorkingSet,
) -> Result<Buffer, Error> {
    control_work(working)?;
    let _control = working.reserve(CONTROL_BYTES)?;
    candidate::part_charge(ordinal, 1)?;
    let encoded = exact(s, r)?;
    let mut params = vec![
        blob(r.candidate.to_vec()),
        wide_int(ordinal)?,
        blob(r.candidate.to_vec()),
        blob(encoded.clone()),
    ];
    params.extend(gate(r)?);
    // Scalars only: neither an arbitrary body nor an invalid declared capacity
    // is copied into Rust while planning the prospective read allocation.
    let shape = query(
        s,
        &format!(
            "SELECT CASE WHEN typeof(bound)='integer' AND bound>0 AND bound<=4194304 AND typeof(charge)='integer' AND charge=bound+128 THEN bound ELSE NULL END,CASE WHEN body IS NULL THEN 0 WHEN typeof(body)='blob' AND length(body)>0 AND length(body)<=bound THEN length(body) ELSE NULL END FROM mi_part WHERE candidate=? AND ordinal=? AND EXISTS(SELECT 1 FROM mi_candidate WHERE id=? AND binding=?) AND {GATE} LIMIT 2"
        ),
        params,
    )?;
    if shape.columns != 2 {
        return Err(Error::Storage(candidate::StorageRefusal::Corrupt));
    }
    let (bound, bytes) = match shape.values.as_slice() {
        [] => {
            current(s, r)?;
            return Err(Error::Conflict);
        }
        [SqlValue::Integer(bound), SqlValue::Integer(0)]
            if *bound > 0 && *bound <= candidate::MAX_PART_BYTES as i64 =>
        {
            // A reserved but unfilled slot is unavailable DATA, not corrupt
            // storage, trusted absence, or permission to create anything.
            return Err(Error::Conflict);
        }
        [SqlValue::Integer(bound), SqlValue::Integer(bytes)]
            if *bound > 0
                && *bound <= candidate::MAX_PART_BYTES as i64
                && *bytes > 0
                && *bytes <= *bound =>
        {
            (*bound as u64, *bytes as usize)
        }
        _ => return Err(Error::Storage(candidate::StorageRefusal::Corrupt)),
    };
    candidate::part_charge(ordinal, bound)?;
    // Bill the actual caller's initialization BEFORE Buffer construction,
    // backend reads/copies, hashing or deferred-barrier work. No external
    // supplied-buffer assertion is used as evidence of initialization billing.
    working.precharge(Work {
        pass_bytes: (bytes as u64)
            .saturating_mul(16)
            .saturating_add(CONTROL_BYTES),
        ..Work::default()
    })?;
    // At most two bounded body values may be copied by the backend. They and
    // the returned Buffer coexist; fixed reports/params are in control space.
    // This is Rust logical capacity accounting, not SQLite C/page/RSS proof.
    let _backend = working.reserve((bytes as u64).saturating_mul(2).saturating_add(4096))?;
    let mut output = working.buffer(bytes)?;
    let mut params = vec![
        wide_int(bound)?,
        wide_int(bytes as u64)?,
        blob(r.candidate.to_vec()),
        wide_int(ordinal)?,
        blob(r.candidate.to_vec()),
        blob(encoded),
    ];
    params.extend(gate(r)?);
    let report = query(
        s,
        &format!(
            "SELECT CASE WHEN typeof(body)='blob' AND typeof(bound)='integer' AND bound=? AND bound>0 AND bound<=4194304 AND typeof(charge)='integer' AND charge=bound+128 AND length(body)=? AND length(body)<=bound THEN body ELSE NULL END FROM mi_part WHERE candidate=? AND ordinal=? AND EXISTS(SELECT 1 FROM mi_candidate WHERE id=? AND binding=?) AND {GATE} LIMIT 2"
        ),
        params,
    )?;
    if report.columns != 1 {
        return Err(Error::Storage(candidate::StorageRefusal::Corrupt));
    }
    let body = match report.values.as_slice() {
        [SqlValue::Blob(body)] if body.len() == bytes && body.capacity() <= bytes => body,
        [] => {
            current(s, r)?;
            return Err(Error::Conflict);
        }
        _ => return Err(Error::Storage(candidate::StorageRefusal::Corrupt)),
    };
    output.as_mut_slice().copy_from_slice(body);
    if mdbn_wire::hash::sha256(output.as_slice()) != *expected_address {
        return Err(Error::Conflict);
    }
    // DATA does not become a durable/currentness permit. Still close the
    // existing window before success and repeat the current request checks.
    acknowledge_existing(s)?;
    exact(s, r)?;
    if slot(s, r, ordinal)? != Some(bound) {
        return Err(Error::Conflict);
    }
    Ok(output)
}

pub(super) fn write<I: IndexStorage>(
    s: &mut SqlStore<I>,
    r: &Request,
    ordinal: u64,
    body: Buffer,
    working: &WorkingSet,
) -> Result<(), Error> {
    control_work(working)?;
    let _control = working.reserve(CONTROL_BYTES)?;
    // Storage accepts only an already charged body from this shared verifier
    // account. Pool identity is accounting, never authenticated authority.
    if !working.owns_buffer(&body) {
        return Err(Error::Invalid);
    }
    candidate::part_charge(ordinal, body.capacity() as u64)?;
    if body.as_slice().is_empty() {
        return Err(Error::Invalid);
    }
    let encoded = exact(s, r)?;
    let bound = slot(s, r, ordinal)?.ok_or(Error::Conflict)?;
    if body.capacity() as u64 > bound {
        return Err(Error::Invalid);
    }
    let quota = usage(s, working)?;
    quota.retained.adding(0, 0)?;
    let (bounded, counts) = quota.sql(working)?;
    working.precharge(Work {
        pass_bytes: (body.capacity() as u64)
            .saturating_mul(16)
            .saturating_add(CONTROL_BYTES),
        ..Work::default()
    })?;
    // Keep the charged, non-extractable Buffer live; replace only the NULL
    // parameter with its immutable bytes. There is no owned-body fallback.
    let mut params = vec![
        SqlValue::Null,
        blob(r.candidate.to_vec()),
        wide_int(ordinal)?,
        wide_int(bound)?,
        blob(r.candidate.to_vec()),
        blob(encoded),
    ];
    params.extend(gate(r)?);
    let reports = run_borrowed(
        s,
        st(
            &format!(
                "WITH input(body) AS(VALUES(?)),{bounded} UPDATE mi_part SET body=(SELECT body FROM input) WHERE candidate=? AND ordinal=? AND bound=? AND EXISTS(SELECT 1 FROM mi_candidate WHERE id=? AND binding=?) AND {GATE} AND {counts} AND (SELECT count(*) FROM qc)<=100000 AND {TOTAL}<=4294967296 AND (body IS NULL OR body=(SELECT body FROM input))"
            ),
            params,
        ),
        &body,
    )?;
    current(s, r)?;
    if reports.first().is_some_and(|r| r.changes == 1) {
        Ok(())
    } else {
        usage(s, working)?.retained.adding(0, 0)?;
        Err(Error::Conflict)
    }
}
