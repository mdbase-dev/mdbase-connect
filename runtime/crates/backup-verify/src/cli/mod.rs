//! CLI orchestration only. Options admitted before ANY filesystem operation.
mod args;
mod files;
mod layout;
use crate::{Refusal, memory::poison, memory_vec::OwnedVec};
use files::{FrozenFile, Reads};
use layout::Layout;
use mdbn_backup_verify::{CutVerifier, Verified};
use mdbn_log_service::OfflineDecodeBudget;
use std::ffi::OsString;

pub(crate) fn run(arguments: impl Iterator<Item = OsString>) -> Result<Verified, Refusal> {
    let arguments = args::parse(arguments)?;
    let work = OfflineDecodeBudget::new();
    let result = (|| {
        let paths = [&arguments.cut_dir, &arguments.completion, &arguments.trust];
        let total = paths
            .iter()
            .try_fold(0u64, |total, path| {
                total.checked_add(path.as_os_str().as_encoded_bytes().len() as u64)
            })
            .ok_or(Refusal::Bounds)?;
        // Transient joined names/canonicalized paths and fixed CLI bookkeeping.
        let _baseline = work
            .reserve_owned(
                total
                    .checked_mul(4)
                    .and_then(|bytes| bytes.checked_add(1024 * 1024))
                    .ok_or(Refusal::Bounds)?,
            )
            .map_err(|_| Refusal::Bounds)?;
        let mut reads = Reads::default();
        let mut trust = FrozenFile::admit(&arguments.trust, 65536, &work)?;
        let mut completion = FrozenFile::admit(&arguments.completion, 65536, &work)?;
        let mut verifier = {
            let trust = trust.read(&mut reads)?;
            let completion = completion.read(&mut reads)?;
            CutVerifier::new(trust.as_slice(), completion.as_slice(), &work)?
        };
        // No bulk enumeration before independent completion authentication.
        let layout = Layout::admit(
            &arguments.cut_dir,
            &arguments.trust,
            &arguments.completion,
            &work,
        )?;
        let mut header = FrozenFile::admit_expected(
            &arguments.cut_dir.join("header.cbor"),
            65536,
            layout.header_identity(),
            &work,
        )?;
        let mut finish = FrozenFile::admit_expected(
            &arguments.cut_dir.join("finish.cbor"),
            65536,
            layout.finish_identity(),
            &work,
        )?;
        {
            let header = header.read(&mut reads)?;
            let finish = finish.read(&mut reads)?;
            verifier.bind_header(header.as_slice(), finish.as_slice())?;
        }
        let names = layout.inventory(verifier.expected_pages(), verifier.expected_objects())?;
        // Keep original identities/fingerprints through final completion checks;
        // reopen against those identities rather than retaining unbounded handles.
        let mut files = OwnedVec::new(&work, 131072);
        for number in 1..=names.pages() {
            let path = arguments
                .cut_dir
                .join("pages")
                .join(format!("{number:010}.cbor"));
            let mut file = FrozenFile::admit_expected(
                &path,
                4 * 1024 * 1024,
                names.page_identity(number)?,
                &work,
            )?;
            {
                let raw = file.read(&mut reads)?;
                verifier.push_page(raw.as_slice())?;
            }
            file.close_handle();
            files.push(file)?;
        }
        verifier.finish_pages()?;
        for object in names.objects() {
            let path = arguments
                .cut_dir
                .join("objects")
                .join(format!("{}.cbor", object.address.to_hex()));
            let mut file =
                FrozenFile::admit_expected(&path, 9 * 1024 * 1024, object.identity, &work)?;
            {
                let raw = file.read(&mut reads)?;
                verifier.push_object(&object.address, raw.as_slice())?;
            }
            file.close_handle();
            files.push(file)?;
        }
        layout.recheck()?;
        for file in files.iter_mut() {
            file.verify_at_completion(&mut reads)?;
        }
        for file in [&mut trust, &mut completion, &mut header, &mut finish] {
            file.verify_at_completion(&mut reads)?;
        }
        layout.recheck()?;
        verifier.finish()
    })();
    if result.is_err() {
        poison(&work);
    }
    result
}
