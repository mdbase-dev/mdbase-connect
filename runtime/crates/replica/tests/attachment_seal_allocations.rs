//! Native, thread-scoped allocation proof for the additive sealing substrate.
//! The single caller region/input/custody are created BEFORE measurement. This
//! does not qualify Worker/WASM/shared-slot/Noise memory or activate uploads.
#![cfg(not(target_arch = "wasm32"))]

use allocation_counter::{AllocationInfo, measure};
use mdbn_replica::attachments::{AttachmentWriter, MAX_SEALED_CHUNK};
use mdbn_replica::crypto::chunked_blob::{AttachmentLimits, CHUNK_BYTES};
use mdbn_replica::crypto::{CsprngEntropy, Entropy, Secret32};
use mdbn_replica::seal::{KeyringSealer, Sealer};
use mdbn_wire::common::B16;
use std::hint::black_box;
use zeroize::Zeroizing;

const COL: B16 = B16([3; 16]);
const META_BUDGET: u64 = 64 << 10;
struct Rng(u8);
impl Entropy for Rng {
    fn fill(&mut self, out: &mut [u8]) {
        out.fill(self.0);
        self.0 = self.0.wrapping_add(1);
    }
}
impl CsprngEntropy for Rng {}

fn sealer() -> KeyringSealer {
    let mut keys = mdbn_replica::crypto::keys::Keyring::new();
    keys.insert(1, Secret32([9; 32]));
    let bytes = keys.to_bytes();
    let mut stored = Zeroizing::new((bytes.len() as u64).to_be_bytes().to_vec());
    stored.extend_from_slice(&bytes);
    let mut s = KeyringSealer::new(COL, B16([2; 16]), &[6; 32], &[7; 32]);
    s.import(&stored).unwrap();
    s.set_epoch(1);
    s
}
fn within_budget(info: AllocationInfo) -> bool {
    info.bytes_max <= META_BUDGET && info.bytes_total <= META_BUDGET
}

#[test]
fn in_place_sealing_has_only_bounded_metadata_allocations_with_failing_controls() {
    let s = sealer();
    for size in [0, 65_537, CHUNK_BYTES as usize] {
        let plain: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let mut region = vec![0xaa; MAX_SEALED_CHUNK as usize];
        region[..size].copy_from_slice(&plain);
        let pointer = region.as_ptr();
        let capacity = region.capacity();
        let mut rng = Rng(1);
        let mut writer =
            AttachmentWriter::new(&s, COL, size as u64, AttachmentLimits::default(), &mut rng)
                .unwrap();
        let mut span = None;
        let actual = measure(|| {
            span = Some(
                writer
                    .push_chunk_in_place(&s, &mut region, size, &mut rng)
                    .unwrap(),
            );
        });
        assert!(within_budget(actual), "{size}: {actual:?}");
        assert!(actual.bytes_current >= 0 && actual.bytes_current as u64 <= META_BUDGET);
        assert_eq!(region.as_ptr(), pointer);
        assert_eq!(region.capacity(), capacity);
        assert_eq!(writer.chunks().len(), 1);
        assert_eq!(
            span.as_ref().unwrap().cipher_hash(),
            writer.chunks()[0].cipher_hash
        );
        println!(
            "in_place size={size} peak_extra={} total={} retained={}",
            actual.bytes_max, actual.bytes_total, actual.bytes_current
        );
    }

    // Positive controls prove the SAME live-peak + total guard detects a body
    // allocation. They aren't included in substrate accounting or hidden by GC.
    let size = CHUNK_BYTES as usize;
    let plain = vec![7; size];
    let mut rng = Rng(1);
    let mut owned_writer =
        AttachmentWriter::new(&s, COL, size as u64, AttachmentLimits::default(), &mut rng).unwrap();
    let owned = measure(|| {
        let object = owned_writer.push_chunk(&s, &plain, &mut rng).unwrap();
        black_box(&object);
    });
    assert!(!within_budget(owned));
    assert!(owned.bytes_max >= size as u64 && owned.bytes_total >= size as u64);
    println!(
        "owned control rejected peak_extra={} total={}",
        owned.bytes_max, owned.bytes_total
    );

    let mut region = vec![0; MAX_SEALED_CHUNK as usize];
    region[..size].copy_from_slice(&plain);
    let mut writer =
        AttachmentWriter::new(&s, COL, size as u64, AttachmentLimits::default(), &mut rng).unwrap();
    let extra = measure(|| {
        let regression = vec![0u8; MAX_SEALED_CHUNK as usize];
        let span = writer
            .push_chunk_in_place(&s, &mut region, size, &mut rng)
            .unwrap();
        black_box((&regression, &span));
    });
    assert!(!within_budget(extra));
    assert!(extra.bytes_max >= MAX_SEALED_CHUNK && extra.bytes_total >= MAX_SEALED_CHUNK);
    println!(
        "extra9MiB control rejected peak_extra={} total={}",
        extra.bytes_max, extra.bytes_total
    );
}
