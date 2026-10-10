//! Separately typed discovery/source READ codecs; no generic Query continuation.
use super::*;
use mdbn_core::views::bases::IncrementalBasesBudget;
use mdbn_replica::replica::{BasesDiscoveryHandle, BasesDiscoveryPage, BasesViewSource};
// Match existing owned app output discipline without a new dependency.
struct WipedOutput(Vec<u8>);
impl Drop for WipedOutput {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}
#[cfg(test)]
mod tests;
const MAX_DISCOVERY_OUTPUT: usize = 1024 * 1024;
struct PageRequest {
    zone: String,
    limit: u32,
    resume: Option<BasesDiscoveryHandle>,
}
struct SourceRequest {
    zone: String,
    selection: BasesViewSelection,
}
impl PageRequest {
    fn decode(bytes: &[u8]) -> ApiResult<Self> {
        if bytes.len() > MAX_REQUEST {
            return Err(invalid());
        }
        let mut r = Reader { bytes, pos: 0 };
        if r.arg(5).map_err(|_| invalid())? != 4 {
            return Err(invalid());
        }
        r.field(0).map_err(|_| invalid())?;
        if r.arg(0).map_err(|_| invalid())? != 1 {
            return Err(invalid());
        }
        r.field(1).map_err(|_| invalid())?;
        let zone = text(&mut r, 128)?.to_owned();
        r.field(2).map_err(|_| invalid())?;
        let limit = u32::try_from(r.arg(0).map_err(|_| invalid())?).map_err(|_| invalid())?;
        if limit == 0 || limit > 128 {
            return Err(invalid());
        }
        r.field(3).map_err(|_| invalid())?;
        let resume = if r.bytes.get(r.pos) == Some(&0xf6) {
            r.pos += 1;
            None
        } else {
            Some(BasesDiscoveryHandle(r.fixed().map_err(|_| invalid())?))
        };
        if r.pos != bytes.len() {
            return Err(invalid());
        }
        Ok(Self {
            zone,
            limit,
            resume,
        })
    }
}
impl SourceRequest {
    fn decode(bytes: &[u8]) -> ApiResult<Self> {
        if bytes.len() > MAX_REQUEST {
            return Err(invalid());
        }
        let mut r = Reader { bytes, pos: 0 };
        if r.arg(5).map_err(|_| invalid())? != 5 {
            return Err(invalid());
        }
        r.field(0).map_err(|_| invalid())?;
        if r.arg(0).map_err(|_| invalid())? != 1 {
            return Err(invalid());
        }
        r.field(1).map_err(|_| invalid())?;
        let record = B16(r.fixed().map_err(|_| invalid())?);
        r.field(2).map_err(|_| invalid())?;
        let revision = B32(r.fixed().map_err(|_| invalid())?);
        r.field(3).map_err(|_| invalid())?;
        let index = u32::try_from(r.arg(0).map_err(|_| invalid())?).map_err(|_| invalid())?;
        r.field(4).map_err(|_| invalid())?;
        let zone = text(&mut r, 128)?.to_owned();
        if r.pos != bytes.len() {
            return Err(invalid());
        }
        Ok(Self {
            zone,
            selection: BasesViewSelection {
                record,
                revision,
                index,
            },
        })
    }
}
fn clock(writer: &mut Writer, clock: &mdbn_core::intent::OpClock) -> ApiResult<()> {
    writer.wire(&mdbn_wire::intent::OpClock {
        instant: clock.instant_ms,
        tz: clock.tz.clone(),
        local_date: clock.local_date.clone(),
    })
}
fn page(writer: &mut Writer, page: &BasesDiscoveryPage) -> ApiResult<()> {
    if page.views.len() > 128 {
        return Err(too_large());
    }
    writer.map(5)?;
    writer.uint(0)?;
    writer.uint(1)?;
    writer.uint(1)?;
    writer.array(page.views.len())?;
    for view in &page.views {
        writer.descriptor(view)?;
    }
    writer.uint(2)?;
    clock(writer, &page.clock)?;
    writer.uint(3)?;
    writer.blob(&page.collection_revision.0)?;
    writer.uint(4)?;
    match page.next {
        Some(token) => writer.blob(&token.0),
        None => writer.put(&[0xf6]),
    }
}
fn source(writer: &mut Writer, source: &BasesViewSource) -> ApiResult<()> {
    if source.source.len() > 512 * 1024 {
        return Err(too_large());
    }
    writer.map(5)?;
    writer.uint(0)?;
    writer.uint(1)?;
    writer.uint(1)?;
    writer.descriptor(&source.view)?;
    writer.uint(2)?;
    // Exact bounded source text, not the 4096-byte label/cell text profile.
    writer.arg(3, source.source.len() as u64)?;
    writer.put(source.source.as_bytes())?;
    writer.uint(3)?;
    clock(writer, &source.clock)?;
    writer.uint(4)?;
    writer.blob(&source.collection_revision.0)
}
fn encode(
    ledger: &mut IncrementalBasesBudget,
    write: impl Fn(&mut Writer) -> ApiResult<()>,
) -> ApiResult<WipedOutput> {
    let mut count = Writer {
        output: None,
        size: 0,
    };
    write(&mut count)?;
    if count.size > MAX_DISCOVERY_OUTPUT {
        return Err(too_large());
    }
    ledger
        .retain(count.size as u64 + 64)
        .map_err(|_| too_large())?;
    ledger
        .admit(|work| {
            if work.charge(count.size as u64, count.size as u64 + 64) {
                Ok(())
            } else {
                Err(work.failure().expect("discovery codec"))
            }
        })
        .map_err(|_| too_large())?;
    let mut writer = Writer {
        output: Some(Vec::with_capacity(count.size)),
        size: 0,
    };
    // Writer contains only the counted owned output. Take into zeroizing storage
    // even when the second pass fails, before propagating the refusal.
    let result = write(&mut writer);
    let output = WipedOutput(writer.output.take().expect("bounded discovery output"));
    result?;
    if writer.size != count.size {
        return Err(too_large());
    }
    Ok(output)
}
impl AppRuntime {
    /// Actual resident-session bounded metadata READ. Wipes consumed input.
    pub fn bases_list_views_consuming(&mut self, session: u64, bytes: &mut [u8]) -> Vec<u8> {
        let result: ApiResult<WipedOutput> = (|| {
            if !self.healthy() {
                return Err(unavailable());
            }
            let replica = self.runtime.as_mut().ok_or_else(unavailable)?.replica_mut();
            let session = SessionId(session);
            replica.authorize_bases_read(session)?;
            let request = PageRequest::decode(bytes)?;
            replica.encode_bases_discovery_page(
                session,
                Some(&request.zone),
                request.limit,
                request.resume,
                |_, result, ledger| encode(ledger, |writer| page(writer, result)),
            )
        })();
        wipe(bytes);
        match result {
            Ok(mut bytes) => std::mem::take(&mut bytes.0),
            Err(error) => refusal(error.into_problem()),
        }
    }
    /// Exact native source revision/ordinal READ; no path/alias selection.
    pub fn bases_read_view_source_consuming(&mut self, session: u64, bytes: &mut [u8]) -> Vec<u8> {
        let result: ApiResult<WipedOutput> = (|| {
            if !self.healthy() {
                return Err(unavailable());
            }
            let replica = self.runtime.as_mut().ok_or_else(unavailable)?.replica_mut();
            let session = SessionId(session);
            replica.authorize_bases_read(session)?;
            let request = SourceRequest::decode(bytes)?;
            replica.encode_bases_view_source(
                session,
                request.selection,
                Some(&request.zone),
                |_, result, ledger| encode(ledger, |writer| source(writer, result)),
            )
        })();
        wipe(bytes);
        match result {
            Ok(mut bytes) => std::mem::take(&mut bytes.0),
            Err(error) => refusal(error.into_problem()),
        }
    }
}
