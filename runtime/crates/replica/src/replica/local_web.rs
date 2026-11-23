use mdbn_wire::attachment::FileContent;
use mdbn_wire::client::{
    FileChunk, FileView, Include, OpenUploadParams, OpenUploadResult, Receipt, UploadChunkParams,
};
use mdbn_wire::common::{Bytes, Hash, Uuid};
use mdbn_wire::hash::sha256;
use mdbn_wire::intent::{BlobRef, FilePut, Op};
use mdbn_wire::unindexed_markdown::FileKindV1;
use zeroize::Zeroizing;

use super::{Replica, submit::store_err};
use crate::api::{ApiError, ApiResult, ClientApi, ErrorCode, Push, SessionId, StreamId, Target};
use crate::policy::capability::{CREATE, EDIT, READ};
use crate::store::{
    Content, Expect, FileLocal, FileRow, PendingRow, Publish, Store, StoreError, Tx,
};

const CHUNK_BYTES: u64 = 1 << 20;
const FILE_BYTES: u64 = 4 * CHUNK_BYTES;
const UPLOAD_MS: i64 = 60_000;

pub(super) struct Authority {
    live: Box<dyn Fn(Uuid) -> bool>,
    uploads: std::collections::BTreeMap<SessionId, Upload>,
    body: Option<Body>,
    next_stream: u64,
}

struct Upload {
    params: OpenUploadParams,
    file: Uuid,
    expires: i64,
    received: u8,
    bytes: Zeroizing<Vec<u8>>,
}

struct Body {
    owner: Uuid,
    mutation: Uuid,
    digest: Hash,
    bytes: Zeroizing<Vec<u8>>,
}

pub(super) fn pending_owner(row: &PendingRow) -> Option<Uuid> {
    row.grant.filter(|_| row.mutation.on_behalf.is_none())
}

pub(super) fn revoked() -> ApiError {
    ErrorCode::Unauthenticated
        .err_with_reason("local_web_revoked", "local bearer is no longer live")
}

pub(super) fn scope() -> ApiError {
    ErrorCode::Forbidden.err_with_reason("local_web_scope", "operation outside local web scope")
}

fn changed() -> ApiError {
    ErrorCode::Conflict.err_with_reason(
        "revision_mismatch",
        "file differs from the authorized revision",
    )
}

fn missing_upload() -> ApiError {
    ErrorCode::NotFound.err("upload is not active for this session")
}

fn size_limit() -> ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "local_attachment_limit",
        "local web attachments are limited to 4 MiB",
    )
}

impl<S: Store> Replica<S> {
    /// Install the trusted native transport's current bearer lifetime. The owner
    /// is local receipt custody, never a Connect grant or mutation `on_behalf`.
    /// An ordinary replica reopen has no owner and rejects dormant captures.
    pub fn enable_local_web(&mut self, live: impl Fn(Uuid) -> bool + 'static) -> ApiResult<()> {
        if !self.local_only() || !self.store.has_files() || self.local_web.is_some() {
            return Err(scope());
        }
        self.local_web = Some(Authority {
            live: Box::new(live),
            uploads: Default::default(),
            body: None,
            next_stream: 1,
        });
        Ok(())
    }

    pub(super) fn local_web_live(&self, owner: Uuid) -> bool {
        self.local_web
            .as_ref()
            .is_some_and(|auth| (auth.live)(owner))
    }

    pub(super) fn local_web_validate_ops(&self, ops: &[Op], has_body: bool) -> ApiResult<()> {
        if ops.len() > mdbn_core::plan::MAX_OPS as usize {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "operation_limit",
                "submit exceeds the local web operation limit",
            ));
        }
        for op in ops {
            let file = match op {
                Op::Create(_)
                | Op::Update(_)
                | Op::UpdateLive(_)
                | Op::Document(_)
                | Op::Delete(_)
                | Op::Rename(_) => continue,
                Op::FileDelete(op) if ops.len() == 1 => op.id,
                Op::FileMove(op) if ops.len() == 1 => op.id,
                Op::FilePut(op) if has_body && ops.len() == 1 => op.id,
                _ => return Err(scope()),
            };
            if let Some(row) = self.store.file(&file).map_err(store_err)? {
                Self::local_web_ordinary(&row)?;
            }
        }
        Ok(())
    }

    fn local_web_ordinary(row: &FileRow) -> ApiResult<()> {
        if row.kind != FileKindV1::Ordinary || !matches!(row.content, FileContent::Blob(_)) {
            return Err(scope());
        }
        if row.content.size() > FILE_BYTES {
            return Err(size_limit());
        }
        Ok(())
    }

    pub(super) fn local_web_close(&mut self, session: SessionId) {
        if let Some(auth) = self.local_web.as_mut() {
            auth.uploads.remove(&session);
        }
    }

    pub(super) fn local_web_store_body(
        &mut self,
        owner: Uuid,
        mutation: Uuid,
        digest: Hash,
        bytes: Vec<u8>,
    ) {
        if let Some(auth) = self.local_web.as_mut() {
            auth.body = Some(Body {
                owner,
                mutation,
                digest,
                bytes: Zeroizing::new(bytes),
            });
        }
    }

    pub(super) fn local_web_has_body(&self, owner: Uuid, mutation: &Uuid) -> bool {
        self.local_web
            .as_ref()
            .and_then(|auth| auth.body.as_ref())
            .is_some_and(|body| body.owner == owner && body.mutation == *mutation)
    }

    pub(super) fn local_web_retire_body(&mut self, mutation: &Uuid) {
        if let Some(auth) = self.local_web.as_mut()
            && auth
                .body
                .as_ref()
                .is_some_and(|body| body.mutation == *mutation)
        {
            auth.body = None;
        }
    }

    pub(super) fn local_web_open_upload(
        &mut self,
        session: SessionId,
        params: OpenUploadParams,
    ) -> ApiResult<OpenUploadResult> {
        if params.size > FILE_BYTES {
            return Err(size_limit());
        }
        if params.path.len() > 4096 {
            return Err(ErrorCode::InvalidRequest.err("file path exceeds local upload limit"));
        }
        let now = self.now();
        if self
            .local_web
            .as_ref()
            .and_then(|auth| auth.uploads.get(&session))
            .is_some_and(|upload| upload.expires > now)
        {
            return Err(crate::file_io::busy());
        }
        let file = if let Some(file) = params.file_id {
            self.require(session, EDIT)?;
            self.local_web_replace(file, &params)?;
            file
        } else {
            self.require(session, CREATE)?;
            if params.if_revision.is_some() {
                return Err(ErrorCode::InvalidRequest.err("if_revision requires a file to replace"));
            }
            self.mint_v7()
        };
        let result = OpenUploadResult {
            transfer: params.transfer,
            file_id: Some(file),
            chunk_size: CHUNK_BYTES,
            received: Vec::new(),
            expires_at: now.saturating_add(UPLOAD_MS),
        };
        let bytes = Zeroizing::new(vec![0; params.size as usize]);
        self.local_web.as_mut().ok_or_else(revoked)?.uploads.insert(
            session,
            Upload {
                params,
                file,
                bytes,
                expires: result.expires_at,
                received: 0,
            },
        );
        Ok(result)
    }

    fn local_web_replace(&self, file: Uuid, params: &OpenUploadParams) -> ApiResult<FileRow> {
        let row = self
            .store
            .file(&file)
            .map_err(store_err)?
            .ok_or_else(|| ErrorCode::NotFound.err("no such file to replace"))?;
        Self::local_web_ordinary(&row)?;
        if row.path != params.path
            || params
                .if_revision
                .is_some_and(|expected| expected != row.content.plain_hash())
        {
            return Err(changed());
        }
        Ok(row)
    }

    pub(super) fn local_web_upload_chunk(
        &mut self,
        session: SessionId,
        params: UploadChunkParams,
    ) -> ApiResult<u64> {
        let now = self.now();
        let upload = self
            .local_web
            .as_mut()
            .and_then(|auth| auth.uploads.get_mut(&session))
            .filter(|upload| upload.params.transfer == params.transfer && upload.expires > now)
            .ok_or_else(missing_upload)?;
        if params.index >= upload.params.size.div_ceil(CHUNK_BYTES) {
            return Err(ErrorCode::InvalidRequest.err("chunk index is outside this upload"));
        }
        let start = (params.index * CHUNK_BYTES) as usize;
        let end = (start + CHUNK_BYTES as usize).min(upload.bytes.len());
        let bytes = Zeroizing::new(params.bytes.0);
        let bit = 1 << params.index;
        let region = &mut upload.bytes[start..end];
        if bytes.len() != region.len() || (upload.received & bit != 0 && *region != **bytes) {
            return Err(ErrorCode::InvalidRequest.err("chunk does not match this upload"));
        }
        region.copy_from_slice(&bytes);
        upload.received |= bit;
        Ok(params.index)
    }

    pub(super) fn local_web_abort_upload(
        &mut self,
        session: SessionId,
        transfer: Uuid,
    ) -> ApiResult<()> {
        let auth = self.local_web.as_mut().ok_or_else(revoked)?;
        if auth
            .uploads
            .get(&session)
            .is_some_and(|upload| upload.params.transfer == transfer)
        {
            auth.uploads.remove(&session);
        }
        Ok(())
    }

    pub(super) fn local_web_commit_upload(
        &mut self,
        session: SessionId,
        transfer: Uuid,
    ) -> ApiResult<Receipt> {
        let crate::api::SessionAuth::LocalWeb(owner) = self.session(session)?.auth else {
            return Err(scope());
        };
        let now = self.now();
        let auth = self.local_web.as_mut().ok_or_else(revoked)?;
        let upload = auth
            .uploads
            .get(&session)
            .filter(|upload| upload.params.transfer == transfer && upload.expires > now)
            .ok_or_else(missing_upload)?;
        if upload.received != (1 << upload.params.size.div_ceil(CHUNK_BYTES)) - 1 {
            return Err(ErrorCode::InvalidRequest.err("upload is missing chunks"));
        }
        let mut upload = auth.uploads.remove(&session).ok_or_else(missing_upload)?;
        let digest = sha256(&upload.bytes);
        if upload
            .params
            .digest
            .is_some_and(|expected| expected != digest)
        {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "digest_mismatch",
                "uploaded bytes differ from the declared digest",
            ));
        }
        let if_revision = if let Some(file) = upload.params.file_id {
            self.require(session, EDIT)?;
            let row = self.local_web_replace(file, &upload.params)?;
            self.local_read_verified(&row.path, row.content.size(), row.content.plain_hash())?;
            Some(row.content.plain_hash())
        } else {
            self.require(session, CREATE)?;
            None
        };
        let op = Op::FilePut(FilePut {
            id: upload.file,
            path: upload.params.path,
            blob: BlobRef {
                plain_hash: digest,
                size: upload.params.size,
                blob_id: digest,
                id_epoch: 0,
                part_size: CHUNK_BYTES,
            },
            if_revision,
            base: None,
        });
        let zone = self
            .session(session)?
            .tz
            .clone()
            .unwrap_or_else(|| self.host.zones.default_zone());
        let level = crate::convert::wire_level(self.catalog.settings().validation);
        self.submit_one(
            session,
            Some(owner),
            vec![op],
            upload.params.mutation_id,
            None,
            &zone,
            false,
            &Include {
                effective: None,
                body: None,
                document: None,
                diagnostics: None,
            },
            level,
            Some((digest, std::mem::take(&mut *upload.bytes))),
        )
    }

    fn local_read_verified(
        &mut self,
        path: &str,
        size: u64,
        digest: Hash,
    ) -> ApiResult<Zeroizing<Vec<u8>>> {
        if size > FILE_BYTES {
            return Err(size_limit());
        }
        let mut source = self
            .store
            .attachment_source(path, size)
            .map_err(store_err)?
            .ok_or_else(changed)?;
        let mut bytes = Zeroizing::new(vec![0; size as usize]);
        source.read_at(0, &mut bytes).map_err(|_| changed())?;
        if sha256(&bytes) != digest {
            return Err(changed());
        }
        Ok(bytes)
    }

    pub(super) fn local_web_read_file(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<(StreamId, FileView)> {
        let view = self.get_file(session, target)?;
        let row = self
            .store
            .file(&view.id)
            .map_err(store_err)?
            .ok_or_else(changed)?;
        Self::local_web_ordinary(&row)?;
        if revision.is_some_and(|revision| revision != view.digest) {
            return Err(changed());
        }
        let (offset, length) = range.unwrap_or((0, view.size));
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= view.size)
            .ok_or_else(|| ErrorCode::InvalidRequest.err("range is outside the file"))?;
        let mut bytes = self.local_read_verified(&view.path, view.size, view.digest)?;
        self.require(session, READ)?;
        let auth = self.local_web.as_mut().ok_or_else(revoked)?;
        let stream = StreamId(auth.next_stream);
        auth.next_stream = auth
            .next_stream
            .checked_add(1)
            .filter(|seq| *seq < (1_u64 << 53))
            .ok_or_else(|| ErrorCode::TooLarge.err("stream IDs exhausted"))?;
        let bytes = if offset == 0 && end == view.size {
            std::mem::take(&mut *bytes)
        } else {
            bytes[offset as usize..end as usize].to_vec()
        };
        self.pushes.push((
            session,
            Push::FileChunk(FileChunk {
                stream: stream.0,
                offset,
                bytes: Bytes(bytes),
                last: true,
            }),
        ));
        Ok((stream, view))
    }

    pub(super) fn stage_local_web_publish(
        &self,
        owner: Uuid,
        mutation: &Uuid,
        tx: &mut Tx,
    ) -> Result<Option<Hash>, StoreError> {
        let mut temporary = None;
        for row in &mut tx.files_put {
            let old = self.store.file(&row.id)?;
            let digest = row.content.plain_hash();
            let publish = match old {
                Some(old) if old.path != row.path => Publish::Move {
                    id: row.id,
                    from: old.path,
                    to: row.path.clone(),
                    expect: Expect::Revision(old.content.plain_hash()),
                    content: None,
                },
                Some(old) if old.content == row.content => continue,
                old => {
                    let body = self
                        .local_web
                        .as_ref()
                        .and_then(|auth| auth.body.as_ref())
                        .filter(|body| {
                            body.owner == owner
                                && body.mutation == *mutation
                                && body.digest == digest
                        })
                        .ok_or_else(|| StoreError::Corrupt("missing scoped upload bytes".into()))?;
                    if self.store.blob_size(&digest)?.is_none() {
                        tx.blob_parts.push((digest, 0, body.bytes.to_vec()));
                        temporary = Some(digest);
                    }
                    Publish::Write {
                        id: Some(row.id),
                        path: row.path.clone(),
                        content: Content::Blob(digest),
                        expect: old.map_or(Expect::Absent, |old| {
                            Expect::Revision(old.content.plain_hash())
                        }),
                    }
                }
            };
            row.local = FileLocal::Materialized;
            tx.publish.push(publish);
        }
        for id in &tx.files_del {
            if let Some(old) = self.store.file(id)? {
                tx.publish.push(Publish::Delete {
                    id: Some(*id),
                    path: old.path,
                    expect: Expect::Revision(old.content.plain_hash()),
                });
            }
        }
        Ok(temporary)
    }
}
