//! Borrowing canonical numeric-map reader, before allocations or native capture.
use super::{ApiResult, invalid};
pub(super) struct Reader<'a> {
    pub bytes: &'a [u8],
    pub pos: usize,
}
impl<'a> Reader<'a> {
    pub fn take(&mut self, n: usize) -> ApiResult<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or_else(invalid)?;
        let slice = self.bytes.get(self.pos..end).ok_or_else(invalid)?;
        self.pos = end;
        Ok(slice)
    }
    pub fn arg(&mut self, major: u8) -> ApiResult<u64> {
        let head = self.take(1)?[0];
        if head >> 5 != major {
            return Err(invalid());
        }
        let (n, min) = match head & 31 {
            value @ 0..=23 => return Ok(u64::from(value)),
            24 => (1, 24),
            25 => (2, 256),
            26 => (4, 65_536),
            27 => (8, 4_294_967_296),
            _ => return Err(invalid()),
        };
        let value = self
            .take(n)?
            .iter()
            .fold(0u64, |v, b| (v << 8) | u64::from(*b));
        if value < min {
            return Err(invalid());
        }
        Ok(value)
    }
    pub fn field(&mut self, key: u64) -> ApiResult<()> {
        if self.arg(0)? != key {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn fixed<const N: usize>(&mut self) -> ApiResult<[u8; N]> {
        if self.arg(2)? != N as u64 {
            return Err(invalid());
        }
        self.take(N)?.try_into().map_err(|_| invalid())
    }
}
