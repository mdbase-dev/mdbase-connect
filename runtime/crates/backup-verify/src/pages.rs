//! Bounded exact six-section page chain/cursor validation.
use crate::Refusal;
use crate::completion::{MAX_PAGE_BYTES, collection, digest, exact_map, hash, uint};
use crate::header::Header;
use crate::memory::{Owned, poison, scratch};
use mdbn_log_service::OfflineDecodeBudget;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::B32;
use mdbn_wire::schema::Wire;

const PAGE_MAX: usize = 4 * 1024 * 1024;

pub(crate) struct Page {
    pub(crate) section: u64,
    pub(crate) rows: Owned<Vec<Cbor>>,
}

pub(crate) struct PageCursor {
    header: Header,
    work: OfflineDecodeBudget,
    expected_count: u64,
    expected_hash: B32,
    section: u64,
    number: u64,
    after: u64,
    hash: B32,
    bytes: u64,
    failed: bool,
}

impl PageCursor {
    pub(crate) fn new(
        header: Header,
        expected_count: u64,
        expected_hash: B32,
        work: &OfflineDecodeBudget,
    ) -> Self {
        let hash = header.hash;
        Self {
            header,
            work: work.clone(),
            expected_count,
            expected_hash,
            section: 1,
            number: 0,
            after: 0,
            hash,
            bytes: 0,
            failed: false,
        }
    }

    pub(crate) fn push(&mut self, raw: &[u8]) -> Result<Page, Refusal> {
        if self.failed {
            return Err(Refusal::Pages);
        }
        let work = self.work.clone();
        let result = self.push_checked(raw, &work);
        if result.is_err() {
            self.failed = true;
            poison(&self.work);
        }
        result
    }

    fn push_checked(&mut self, raw: &[u8], work: &OfflineDecodeBudget) -> Result<Page, Refusal> {
        if raw.len() > PAGE_MAX {
            return Err(Refusal::Bounds);
        }
        let bytes = self
            .bytes
            .checked_add(raw.len() as u64)
            .filter(|bytes| *bytes <= MAX_PAGE_BYTES)
            .ok_or(Refusal::Bounds)?;
        let value = Owned::construct(work, scratch(raw.len())?, || {
            work.request().raw(raw).map_err(|e| {
                if matches!(e.reason.as_deref(), Some("shape" | "cbor_shape")) {
                    Refusal::Canonical
                } else {
                    Refusal::Bounds
                }
            })
        })?;
        let fields = exact_map(&value, 11)?;
        let number = self.number.checked_add(1).ok_or(Refusal::Bounds)?;
        if uint(&fields[0].1)? != 1
            || collection(&fields[1].1)? != self.header.collection
            || mdbn_wire::common::Uuid::from_cbor(&fields[2].1).map_err(|_| Refusal::Canonical)?
                != self.header.session
            || uint(&fields[3].1)? != self.header.revision
            || uint(&fields[4].1)? != number
            || digest(&fields[5].1)? != self.hash
            || uint(&fields[6].1)? != self.section
            || self.section > 6
            || number > self.expected_count
            || uint(&fields[9].1)? != self.header.head
            || digest(&fields[10].1)? != self.header.chain
        {
            return Err(Refusal::Pages);
        }
        let Cbor::Array(rows) = &fields[7].1 else {
            return Err(Refusal::Canonical);
        };
        let Cbor::Bool(terminal) = fields[8].1 else {
            return Err(Refusal::Canonical);
        };
        if terminal != rows.is_empty() || rows.len() > if self.section == 1 { 32 } else { 100 } {
            return Err(Refusal::Pages);
        }
        let mut after = self.after;
        for row in rows {
            let Cbor::Array(values) = row else {
                return Err(Refusal::Canonical);
            };
            let expected = match self.section {
                1 => 4,
                2 => 5,
                3 => 4,
                4 => 6,
                5 => 4,
                6 => 3,
                _ => unreachable!(),
            };
            if values.len() != expected {
                return Err(Refusal::Canonical);
            }
            let next = uint(&values[0])?;
            if next == 0 || next <= after || self.section <= 2 && next > self.header.head {
                return Err(Refusal::Pages);
            }
            after = next;
        }
        let hash = hash(raw, work)?;
        let finished = terminal && self.section == 6;
        if finished != (number == self.expected_count) || finished && hash != self.expected_hash {
            return Err(Refusal::Pages);
        }
        self.number = number;
        self.hash = hash;
        self.bytes = bytes;
        let section = self.section;
        if terminal {
            self.section += 1;
            self.after = 0;
        } else {
            self.after = after;
        }
        let rows = value.map(|value| {
            let Cbor::Map(mut fields) = value else {
                unreachable!()
            };
            let Cbor::Array(rows) = fields.swap_remove(7).1 else {
                unreachable!()
            };
            rows
        });
        Ok(Page { section, rows })
    }

    pub(crate) fn finish(self) -> Result<(), Refusal> {
        let _alive = self.work.reserve_owned(0).map_err(|_| Refusal::Bounds)?;
        if self.failed
            || self.section != 7
            || self.number != self.expected_count
            || self.hash != self.expected_hash
        {
            poison(&self.work);
            return Err(Refusal::Pages);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::cbor;
    use mdbn_wire::common::B16;
    use mdbn_wire::hash::sha256;

    fn header() -> Header {
        Header {
            collection: B16([1; 16]),
            session: B16([2; 16]),
            head: 10,
            chain: B32([3; 32]),
            retained_from: 1,
            revision: 1,
            hash: B32([4; 32]),
        }
    }
    fn page(number: u64, section: u64, previous: B32, rows: Vec<Cbor>) -> Cbor {
        let h = header();
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), h.collection.to_cbor()),
            (Cbor::Uint(2), h.session.to_cbor()),
            (Cbor::Uint(3), Cbor::Uint(h.revision)),
            (Cbor::Uint(4), Cbor::Uint(number)),
            (Cbor::Uint(5), previous.to_cbor()),
            (Cbor::Uint(6), Cbor::Uint(section)),
            (Cbor::Uint(7), Cbor::Array(rows.clone())),
            (Cbor::Uint(8), Cbor::Bool(rows.is_empty())),
            (Cbor::Uint(9), Cbor::Uint(h.head)),
            (Cbor::Uint(10), h.chain.to_cbor()),
        ])
    }
    fn empty_sections() -> Vec<Vec<u8>> {
        let mut previous = header().hash;
        (1..=6)
            .map(|section| {
                let bytes = cbor::encode(&page(section, section, previous, vec![])).unwrap();
                previous = sha256(&bytes);
                bytes
            })
            .collect()
    }
    #[test]
    fn six_explicit_empty_terminals_are_required_for_framing() {
        // Framing alone does not establish signed genesis or inventory closure.
        let pages = empty_sections();
        let work = OfflineDecodeBudget::new();
        let mut cursor = PageCursor::new(header(), 6, sha256(&pages[5]), &work);
        for (i, bytes) in pages.iter().enumerate() {
            let page = cursor.push(bytes).unwrap();
            assert_eq!(page.section, i as u64 + 1);
            assert!(page.rows.is_empty());
        }
        cursor.finish().unwrap();
        let mut incomplete = PageCursor::new(header(), 6, sha256(&pages[5]), &work);
        for bytes in &pages[..5] {
            incomplete.push(bytes).unwrap();
        }
        assert!(incomplete.finish().is_err());
    }
    #[test]
    fn wrong_binding_or_section_poison_cursor_and_cannot_retry() {
        for field in [0, 3, 4, 6, 9] {
            let mut value = page(1, 1, header().hash, vec![]);
            let Cbor::Map(fields) = &mut value else {
                unreachable!()
            };
            fields[field].1 = Cbor::Uint(99);
            let work = OfflineDecodeBudget::new();
            let mut cursor = PageCursor::new(header(), 6, B32([5; 32]), &work);
            assert!(cursor.push(&cbor::encode(&value).unwrap()).is_err());
            assert!(cursor.push(&empty_sections()[0]).is_err());
            assert!(cursor.finish().is_err());
        }
    }
    #[test]
    fn original_cursors_reject_duplicate_and_out_of_head_rows() {
        for keys in [vec![1, 1], vec![2, 1], vec![11]] {
            let rows = keys
                .into_iter()
                .map(|key| {
                    Cbor::Array(vec![
                        Cbor::Uint(key),
                        Cbor::Uint(1),
                        Cbor::Bytes(vec![]),
                        Cbor::int(1),
                    ])
                })
                .collect();
            let value = page(1, 1, header().hash, rows);
            let mut cursor =
                PageCursor::new(header(), 7, B32([5; 32]), &OfflineDecodeBudget::new());
            assert!(cursor.push(&cbor::encode(&value).unwrap()).is_err());
        }
    }
}
