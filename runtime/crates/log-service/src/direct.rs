//! HTTP-only direct-download span normalization. No new log-service wire type
//! or authority: hosts must separately verify the signed capability and object.
use crate::limits::MAX_OBJECT_BYTES;

/// A transport range failure, without object/capability identifiers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeRejection {
    /// Unsupported, malformed, reversed, overflowing or over-cap single range.
    Syntax,
    /// A requested endpoint is outside the object (HTTP 416).
    Unsatisfiable,
    /// Backend metadata exceeds the sealed-object service cap.
    ObjectSize,
}

/// A checked response span within one immutable sealed object's full size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DownloadSpan {
    offset: u64,
    length: u64,
    total: u64,
    partial: bool,
}
impl DownloadSpan {
    /// Normalize an optional single closed `bytes=start-end` range. Both
    /// endpoints must be inside the object: never clamp or silently serve full.
    /// Deliberately reject suffix/open/multi ranges, signs and inner whitespace.
    pub fn resolve(header: Option<&str>, total: u64) -> Result<Self, RangeRejection> {
        if total > MAX_OBJECT_BYTES {
            return Err(RangeRejection::ObjectSize);
        }
        let Some(header) = header else {
            return Ok(Self {
                offset: 0,
                length: total,
                total,
                partial: false,
            });
        };
        let (start, end) = header
            .strip_prefix("bytes=")
            .and_then(|h| h.split_once('-'))
            .ok_or(RangeRejection::Syntax)?;
        let decimal = |s: &str| -> Result<u64, RangeRejection> {
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err(RangeRejection::Syntax);
            }
            s.parse().map_err(|_| RangeRejection::Syntax)
        };
        let start = decimal(start)?;
        let end = decimal(end)?;
        let requested = end
            .checked_sub(start)
            .and_then(|n| n.checked_add(1))
            .filter(|n| *n <= MAX_OBJECT_BYTES)
            .ok_or(RangeRejection::Syntax)?;
        if start >= total || end >= total {
            return Err(RangeRejection::Unsatisfiable);
        }
        Ok(Self {
            offset: start,
            length: requested,
            total,
            partial: true,
        })
    }
    /// First returned byte.
    pub fn offset(self) -> u64 {
        self.offset
    }
    /// Exact expected response body length.
    pub fn length(self) -> u64 {
        self.length
    }
    /// Full immutable object size, never confused with ranged body length.
    pub fn total(self) -> u64 {
        self.total
    }
    /// Whether the response must be 206 rather than 200.
    pub fn partial(self) -> bool {
        self.partial
    }
    /// Exact Content-Range for a 206; absent for a full 200 (including empty).
    pub fn content_range(self) -> Option<String> {
        self.partial.then(|| {
            format!(
                "bytes {}-{}/{}",
                self.offset,
                self.offset + self.length - 1,
                self.total
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_boundary_and_eof_rejection() {
        let full = DownloadSpan::resolve(None, MAX_OBJECT_BYTES).unwrap();
        assert_eq!(full.length(), MAX_OBJECT_BYTES);
        assert!(!full.partial());
        assert_eq!(full.content_range(), None);
        let one = DownloadSpan::resolve(Some("bytes=4-4"), 5).unwrap();
        assert_eq!((one.offset(), one.length()), (4, 1));
        assert_eq!(one.content_range().as_deref(), Some("bytes 4-4/5"));
        assert_eq!(
            DownloadSpan::resolve(Some("bytes=3-9"), 5),
            Err(RangeRejection::Unsatisfiable)
        );
        assert_eq!(
            DownloadSpan::resolve(Some("bytes=5-5"), 5),
            Err(RangeRejection::Unsatisfiable)
        );
        assert_eq!(
            DownloadSpan::resolve(Some("bytes=0-0"), 0),
            Err(RangeRejection::Unsatisfiable)
        );
        assert_eq!(
            DownloadSpan::resolve(None, 0).unwrap().content_range(),
            None
        );
    }
    #[test]
    fn strict_grammar_overflow_and_service_cap() {
        for h in [
            "",
            "bytes=",
            "bytes=-1",
            "bytes=1-",
            "bytes=1-0",
            "bytes=0-1,2-3",
            "bytes=+0-1",
            "bytes=0-+1",
            "bytes= 0-1",
            "bytes=0-1 ",
            "Bytes=0-1",
            "bytes=0-18446744073709551615",
            "bytes=18446744073709551616-18446744073709551616",
        ] {
            assert_eq!(
                DownloadSpan::resolve(Some(h), 5),
                Err(RangeRejection::Syntax)
            );
        }
        let over = format!("bytes=0-{MAX_OBJECT_BYTES}");
        assert_eq!(
            DownloadSpan::resolve(Some(&over), 5),
            Err(RangeRejection::Syntax)
        );
        assert_eq!(
            DownloadSpan::resolve(None, MAX_OBJECT_BYTES + 1),
            Err(RangeRejection::ObjectSize)
        );
    }
}
