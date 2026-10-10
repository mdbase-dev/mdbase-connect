//! Real app-runtime-only Bases producer. Current session authority and the
//! Replica's independent source/actor/index fences are mandatory. This native
//! codec is the sole SDK grammar; it is not a benchmark bridge or permission.
use super::*;
mod discovery;
use mdbn_core::views::bases::{BasesDisplayCell, PropertySelector, RuntimeValue};
use mdbn_replica::{
    SessionId,
    api::{ApiResult, ErrorCode},
    replica::{BasesExecutionResult, BasesExecutionWindow, BasesReadRequest, BasesViewSelection},
};
const MAX_REQUEST: usize = 128 * 1024;
const MAX_TEXT: usize = 4096;
const MAX_ITEMS: usize = 4096;
const MAX_ROWS: usize = 65_536;
const JS_SAFE: i64 = 9_007_199_254_740_991;
/// Explicit reference-qualified profile. This is NOT native tie-matrix proof.
pub const PROFILE: &str = "whole-view-synthetic-policy-reference-v1";
fn invalid() -> mdbn_replica::api::ApiError {
    ErrorCode::InvalidRequest
        .err_with_reason("invalid_bases_request", "invalid bounded Bases request")
}
fn too_large() -> mdbn_replica::api::ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "view_codec_budget",
        "Bases output exceeds its bounded codec profile",
    )
}
fn unavailable() -> mdbn_replica::api::ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "runtime_not_ready",
        "app runtime is not ready for Bases execution",
    )
}
struct Request {
    selection: BasesViewSelection,
    hints: BTreeMap<String, String>,
    zone: String,
    window: Option<BasesExecutionWindow>,
}
fn text<'a>(r: &mut Reader<'a>, max: usize) -> ApiResult<&'a str> {
    let n = usize::try_from(r.arg(3).map_err(|_| invalid())?).map_err(|_| invalid())?;
    if n > max {
        return Err(invalid());
    }
    std::str::from_utf8(r.take(n).map_err(|_| invalid())?).map_err(|_| invalid())
}
impl Request {
    fn decode(bytes: &[u8]) -> ApiResult<Self> {
        if bytes.len() > MAX_REQUEST {
            return Err(invalid());
        }
        let mut r = Reader { bytes, pos: 0 };
        let fields = r.arg(5).map_err(|_| invalid())?;
        if fields != 6 && fields != 7 {
            return Err(invalid());
        }
        r.field(0).map_err(|_| invalid())?;
        let record = B16(r.fixed().map_err(|_| invalid())?);
        r.field(1).map_err(|_| invalid())?;
        let revision = B32(r.fixed().map_err(|_| invalid())?);
        r.field(2).map_err(|_| invalid())?;
        let index = u32::try_from(r.arg(0).map_err(|_| invalid())?).map_err(|_| invalid())?;
        r.field(3).map_err(|_| invalid())?;
        let count = r.arg(5).map_err(|_| invalid())?;
        if count > 4096 {
            return Err(invalid());
        }
        let mut hints = BTreeMap::new();
        let mut total = 0usize;
        for _ in 0..count {
            let key = text(&mut r, MAX_TEXT)?;
            let kind = text(&mut r, MAX_TEXT)?;
            total = total
                .checked_add(key.len() + kind.len())
                .ok_or_else(invalid)?;
            if total > 65_536 || hints.contains_key(key) {
                return Err(invalid());
            }
            hints.insert(key.into(), kind.into());
        }
        r.field(4).map_err(|_| invalid())?;
        let zone = text(&mut r, 128)?.to_owned();
        r.field(5).map_err(|_| invalid())?;
        if text(&mut r, 64)? != PROFILE {
            return Err(invalid());
        }
        let window = if fields == 7 {
            r.field(6).map_err(|_| invalid())?;
            if r.arg(5).map_err(|_| invalid())? != 2 {
                return Err(invalid());
            }
            r.field(0).map_err(|_| invalid())?;
            let offset = u32::try_from(r.arg(0).map_err(|_| invalid())?).map_err(|_| invalid())?;
            r.field(1).map_err(|_| invalid())?;
            let limit = u32::try_from(r.arg(0).map_err(|_| invalid())?).map_err(|_| invalid())?;
            if limit == 0 || limit > 65_536 {
                return Err(invalid());
            }
            Some(BasesExecutionWindow { offset, limit })
        } else {
            None
        };
        if r.pos != bytes.len() {
            return Err(invalid());
        }
        Ok(Self {
            selection: BasesViewSelection {
                record,
                revision,
                index,
            },
            hints,
            zone,
            window,
        })
    }
}
// A counting pass precedes bounded direct encoding. No complete CBOR cell tree
// or partial output is ever published; the second pass emits the same grammar.
struct Writer {
    output: Option<Vec<u8>>,
    size: usize,
}
impl Writer {
    fn put(&mut self, bytes: &[u8]) -> ApiResult<()> {
        self.size = self.size.checked_add(bytes.len()).ok_or_else(too_large)?;
        if self.size > http::MAX_FRAME {
            return Err(too_large());
        }
        if let Some(out) = &mut self.output {
            out.extend_from_slice(bytes);
        }
        Ok(())
    }
    fn arg(&mut self, major: u8, n: u64) -> ApiResult<()> {
        if n < 24 {
            return self.put(&[(major << 5) | n as u8]);
        }
        let (tag, start) = if n <= u8::MAX.into() {
            (24, 7)
        } else if n <= u16::MAX.into() {
            (25, 6)
        } else if n <= u32::MAX.into() {
            (26, 4)
        } else {
            (27, 0)
        };
        self.put(&[(major << 5) | tag])?;
        self.put(&n.to_be_bytes()[start..])
    }
    fn uint(&mut self, n: u64) -> ApiResult<()> {
        self.arg(0, n)
    }
    fn signed(&mut self, n: i64) -> ApiResult<()> {
        if n >= 0 {
            self.uint(n as u64)
        } else {
            self.arg(1, (-1 - n) as u64)
        }
    }
    fn array(&mut self, n: usize) -> ApiResult<()> {
        self.arg(4, n as u64)
    }
    fn map(&mut self, n: usize) -> ApiResult<()> {
        self.arg(5, n as u64)
    }
    fn text(&mut self, s: &str) -> ApiResult<()> {
        if s.len() > MAX_TEXT {
            return Err(too_large());
        }
        self.arg(3, s.len() as u64)?;
        self.put(s.as_bytes())
    }
    fn blob(&mut self, b: &[u8]) -> ApiResult<()> {
        self.arg(2, b.len() as u64)?;
        self.put(b)
    }
    fn boolean(&mut self, b: bool) -> ApiResult<()> {
        self.put(&[if b { 0xf5 } else { 0xf4 }])
    }
    fn float(&mut self, f: f64) -> ApiResult<()> {
        if !f.is_finite() {
            return Err(too_large());
        }
        self.put(&[0xfb])?;
        self.put(&f.to_bits().to_be_bytes())
    }
    fn wire(&mut self, v: &impl Wire) -> ApiResult<()> {
        self.put(&cbor::encode(&v.to_cbor()).map_err(|_| too_large())?)
    }
    fn error(&mut self, s: &str) -> ApiResult<()> {
        self.array(2)?;
        self.uint(8)?;
        self.text(s)
    }
    fn value(&mut self, v: &RuntimeValue, depth: u32) -> ApiResult<()> {
        if depth > 32 {
            return Err(too_large());
        }
        match v {
            RuntimeValue::Null => {
                self.array(1)?;
                self.uint(0)
            }
            RuntimeValue::Bool(b) => {
                self.array(2)?;
                self.uint(1)?;
                self.boolean(*b)
            }
            RuntimeValue::Number(n) if n.is_finite() => {
                self.array(2)?;
                self.uint(2)?;
                self.float(*n)
            }
            RuntimeValue::Number(_) => self.error("non_finite_number"),
            RuntimeValue::String(s) => {
                self.array(2)?;
                self.uint(3)?;
                self.text(s)
            }
            RuntimeValue::Date(d) => {
                if !(-JS_SAFE..=JS_SAFE).contains(&d.millis()) {
                    return Err(too_large());
                }
                self.array(5)?;
                self.uint(4)?;
                self.signed(d.millis())?;
                self.text(d.display())?;
                self.text(&d.timezone_name())?;
                self.boolean(d.is_date_only())
            }
            RuntimeValue::Duration(d) => {
                let components = d.value().components();
                if !components.iter().all(|v| v.is_finite()) {
                    return self.error("non_finite_duration");
                }
                self.array(3)?;
                self.uint(5)?;
                self.array(8)?;
                for value in components {
                    self.float(value)?;
                }
                self.text(d.display())
            }
            RuntimeValue::List(values) => {
                if values.len() > MAX_ITEMS {
                    return Err(too_large());
                }
                self.array(2)?;
                self.uint(6)?;
                self.array(values.len())?;
                for value in values {
                    self.value(value, depth + 1)?;
                }
                Ok(())
            }
            RuntimeValue::Object(values) => {
                if values.len() > MAX_ITEMS {
                    return Err(too_large());
                }
                self.array(2)?;
                self.uint(7)?;
                self.map(values.len())?;
                for (key, value) in values {
                    self.text(key)?;
                    self.value(value, depth + 1)?;
                }
                Ok(())
            }
            RuntimeValue::Error(s) => self.error(s),
            _ => Err(ErrorCode::UpgradeRequired
                .err_with_reason("view_cell_unqualified", "unqualified Bases cell kind")),
        }
    }
    fn cell(&mut self, cell: &BasesDisplayCell) -> ApiResult<()> {
        match cell {
            BasesDisplayCell::Value(v) => self.value(v, 1),
            BasesDisplayCell::Unavailable { code, detail } => {
                self.array(3)?;
                self.uint(9)?;
                self.text(code)?;
                self.text(detail)
            }
        }
    }
    fn result(&mut self, result: &BasesExecutionResult) -> ApiResult<()> {
        if result.rows.len() > MAX_ROWS
            || result.columns.len() > 64
            || result.groups.len() > MAX_ROWS
        {
            return Err(too_large());
        }
        self.map(if result.window.is_some() { 8 } else { 7 })?;
        self.uint(0)?;
        self.uint(1)?;
        self.uint(1)?;
        self.descriptor(&result.view)?;
        self.uint(2)?;
        self.map(2)?;
        self.uint(0)?;
        self.array(result.columns.len())?;
        for column in &result.columns {
            self.text(&column_name(column))?;
        }
        self.uint(1)?;
        self.array(result.unavailable_columns.len())?;
        for (index, detail) in &result.unavailable_columns {
            if *index >= result.columns.len() {
                return Err(too_large());
            }
            self.map(3)?;
            self.uint(0)?;
            self.uint(*index as u64)?;
            self.uint(1)?;
            self.text("view_metadata_unavailable")?;
            self.uint(2)?;
            self.text(detail)?;
        }
        self.uint(3)?;
        self.array(result.rows.len())?;
        for row in &result.rows {
            if row.cells.len() != result.columns.len() {
                return Err(too_large());
            }
            self.array(4)?;
            self.blob(&row.record.0)?;
            self.text(&row.path)?;
            self.blob(&row.revision.0)?;
            self.array(row.cells.len())?;
            for cell in &row.cells {
                self.cell(cell)?;
            }
        }
        self.uint(4)?;
        self.array(result.groups.len())?;
        for group in &result.groups {
            if matches!(
                group.key,
                RuntimeValue::List(_) | RuntimeValue::Object(_) | RuntimeValue::Error(_)
            ) {
                return Err(too_large());
            }
            self.array(2)?;
            self.value(&group.key, 1)?;
            self.array(group.rows.len())?;
            for index in &group.rows {
                if *index >= result.rows.len() {
                    return Err(too_large());
                }
                self.uint(*index as u64)?;
            }
        }
        self.uint(5)?;
        self.wire(&mdbn_wire::intent::OpClock {
            instant: result.clock.instant_ms,
            tz: result.clock.tz.clone(),
            local_date: result.clock.local_date.clone(),
        })?;
        self.uint(6)?;
        self.blob(&result.collection_revision.0)?;
        if let Some(window) = &result.window {
            let request = window.request;
            let remaining = window.total_rows.saturating_sub(request.offset);
            if request.limit == 0
                || request.limit > 65_536
                || window.total_rows > 65_536
                || result.rows.len() != remaining.min(request.limit) as usize
                || window.groups.len() != result.groups.len()
            {
                return Err(too_large());
            }
            self.uint(8)?;
            self.map(4)?;
            self.uint(0)?;
            self.uint(u64::from(request.offset))?;
            self.uint(1)?;
            self.uint(u64::from(request.limit))?;
            self.uint(2)?;
            self.uint(u64::from(window.total_rows))?;
            self.uint(3)?;
            self.array(window.groups.len())?;
            let mut previous = None;
            for (placement, group) in window.groups.iter().zip(&result.groups) {
                if placement.ordinal >= window.total_rows
                    || previous.is_some_and(|p| placement.ordinal <= p)
                    || placement.total_rows == 0
                    || placement.total_rows > window.total_rows
                    || placement.row_ordinals.len() != group.rows.len()
                    || group.rows.is_empty()
                    || !placement.row_ordinals.windows(2).all(|w| w[0] < w[1])
                    || placement
                        .row_ordinals
                        .iter()
                        .any(|i| *i >= placement.total_rows)
                {
                    return Err(too_large());
                }
                previous = Some(placement.ordinal);
                self.array(3)?;
                self.uint(u64::from(placement.ordinal))?;
                self.uint(u64::from(placement.total_rows))?;
                self.array(placement.row_ordinals.len())?;
                for ordinal in &placement.row_ordinals {
                    self.uint(u64::from(*ordinal))?;
                }
            }
        }
        Ok(())
    }
    fn descriptor(&mut self, view: &mdbn_replica::replica::BasesViewDescriptor) -> ApiResult<()> {
        self.map(7)?;
        self.uint(0)?;
        self.blob(&view.record.0)?;
        self.uint(1)?;
        self.text(&view.path)?;
        self.uint(2)?;
        self.blob(&view.revision.0)?;
        self.uint(3)?;
        self.uint(u64::from(view.index))?;
        self.uint(4)?;
        match &view.name {
            Some(n) => self.text(n)?,
            None => self.put(&[0xf6])?,
        };
        self.uint(5)?;
        self.text(&view.view_type)?;
        self.uint(6)?;
        self.array(view.implementations.len())?;
        for i in &view.implementations {
            self.map(4)?;
            self.uint(0)?;
            self.text(&i.type_name)?;
            self.uint(1)?;
            self.text(&i.version)?;
            self.uint(2)?;
            self.blob(&i.contract_digest.0)?;
            self.uint(3)?;
            self.blob(&i.implementation_digest.0)?;
        }
        Ok(())
    }
}
fn column_name(column: &PropertySelector) -> String {
    let namespace = match column {
        PropertySelector::Note(_) => "note",
        PropertySelector::Formula(_) => "formula",
        PropertySelector::File(_) => "file",
    };
    let mut out = format!("{namespace}[\"");
    for c in column.key().chars() {
        if matches!(c, '\\' | '"') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push_str("\"]");
    out
}
fn measure(result: &BasesExecutionResult) -> ApiResult<usize> {
    let mut preflight = Writer {
        output: None,
        size: 0,
    };
    preflight.result(result)?;
    Ok(preflight.size)
}
fn encode_sized(result: &BasesExecutionResult, size: usize) -> ApiResult<Vec<u8>> {
    if size > http::MAX_FRAME {
        return Err(too_large());
    }
    let mut writer = Writer {
        output: Some(Vec::with_capacity(size)),
        size: 0,
    };
    writer.result(result)?;
    if writer.size != size {
        return Err(too_large());
    }
    Ok(writer.output.expect("bounded encoded output"))
}
#[cfg(test)]
fn encode(result: &BasesExecutionResult) -> ApiResult<Vec<u8>> {
    encode_sized(result, measure(result)?)
}
pub(crate) fn refusal(problem: mdbn_wire::client::Problem) -> Vec<u8> {
    let envelope = |problem: mdbn_wire::client::Problem| {
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(7), problem.to_cbor()),
        ])
    };
    match cbor::encode(&envelope(problem)) {
        Ok(bytes) if bytes.len() <= http::MAX_FRAME => bytes,
        _ => cbor::encode(&envelope(too_large().into_problem()))
            .expect("fixed bounded canonical refusal"),
    }
}
impl AppRuntime {
    /// Consuming/wiping real app-runtime read export, never legacy rt_open/RAM.
    /// The caller cannot supply sources, AST, catalogue/head, authority or caps.
    pub fn bases_execute_consuming(&mut self, session: u64, bytes: &mut [u8]) -> Vec<u8> {
        let result: ApiResult<Vec<u8>> = (|| {
            if !self.healthy() {
                return Err(unavailable());
            }
            let runtime = self.runtime.as_mut().ok_or_else(unavailable)?;
            let replica = runtime.replica_mut();
            let session = SessionId(session);
            replica.authorize_bases_read(session)?;
            let request = Request::decode(bytes)?;
            replica.encode_indexed_bases_read_request(
                session,
                BasesReadRequest {
                    selection: request.selection,
                    property_types: &request.hints,
                    timezone: &request.zone,
                    window: request.window,
                },
                measure,
                encode_sized,
            )
        })();
        wipe(bytes);
        result.unwrap_or_else(|e| refusal(e.into_problem()))
    }
}
#[cfg(test)]
mod tests;
