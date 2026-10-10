//! A fresh collection with an owner, two writer devices, a viewer and a stranger,
//! set up over the wire through the control plane.

use std::sync::atomic::{AtomicI64, Ordering};

use mdbn_log_service::testkit::{ControlPlane, Device, filler, id16};
use mdbn_log_service::{Code, ServiceError};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::hash::chain_hash;
use mdbn_wire::log_service::{AppendParams, AppendResult, HeadParams, HeadResult};
use mdbn_wire::policy::{DeviceKind, MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;

use crate::client::{Client, Cred, map, random_uuid};

/// Where the service under test listens.
#[derive(Debug, Clone)]
pub struct Target {
    /// Name for reports.
    pub name: String,
    /// WebSocket base, e.g. `ws://127.0.0.1:7700`.
    pub ws: String,
    /// HTTP base, e.g. `http://127.0.0.1:7700`.
    pub http: String,
    /// `/debug/*` hooks are enabled.
    pub debug_hooks: bool,
}

/// The control-plane label every target pins (`testkit_config`).
pub const CP_LABEL: &str = "conformance";

/// A collection ready for tests: genesis, three devices enrolled, initial rekey done.
pub struct Fx {
    /// Target.
    pub t: Target,
    /// Control plane.
    pub cp: ControlPlane,
    /// Collection.
    pub c: Uuid,
    /// Owner's first device.
    pub a: Device,
    /// Owner's second device.
    pub b: Device,
    /// A viewer's device.
    pub viewer: Device,
    /// A device not enrolled anywhere.
    pub stranger: Device,
    /// Control-plane connection.
    pub cpc: Client,
    issued: AtomicI64,
}

/// Map an error to a test failure message.
pub fn e2s(e: ServiceError) -> String {
    e.to_string()
}

impl Fx {
    /// Set up a fresh collection.
    pub async fn new(t: &Target) -> Result<Fx, String> {
        let cp = ControlPlane::new(CP_LABEL);
        let c = random_uuid();
        let owner = random_uuid();
        let viewer_acct = random_uuid();
        // Devices are per fixture: service-wide state (credential revocation) must
        // not leak between cases sharing one service.
        let dev = |l: &str, acct| Device::new(&format!("{}/{l}", c.to_hex()), acct);
        let a = dev("a", owner);
        let b = dev("b", owner);
        let viewer = dev("viewer", viewer_acct);
        let stranger = dev("stranger", random_uuid());
        let cpc = Client::connect(&t.ws, &c, Cred::ControlPlane, &cp)
            .await
            .map_err(e2s)?;
        cpc.call(
            "create_log",
            map(vec![
                (0, c.to_cbor()),
                (1, Cbor::Bytes(cp.genesis(c, owner))),
            ]),
        )
        .await
        .map_err(e2s)?;
        let fx = Fx {
            t: t.clone(),
            cp,
            c,
            a,
            b,
            viewer,
            stranger,
            cpc,
            issued: AtomicI64::new(2),
        };
        fx.policy(vec![
            fx.a.enrol(DeviceKind::Desktop),
            fx.b.enrol(DeviceKind::Mobile),
            PolicyOp::MemberSet(MemberSet {
                account: viewer_acct,
                role: Role::Viewer,
            }),
            fx.viewer.enrol(DeviceKind::Desktop),
        ])
        .await
        .map_err(e2s)?;
        fx.unlimited().await?;
        let ac = fx.connect(&fx.a).await?;
        fx.rekey(&ac, &fx.a, 0, &[fx.a.id, fx.b.id, fx.viewer.id])
            .await?;
        Ok(fx)
    }

    /// Lift the rate limits so tests and benchmarks measure the service, not §11.
    pub async fn unlimited(&self) -> Result<(), String> {
        self.quota(1 << 40, 1_000_000, 1 << 34, 1_000_000).await
    }

    /// Set quotas.
    pub async fn quota(
        &self,
        storage: u64,
        items: u64,
        bytes: u64,
        burst: u64,
    ) -> Result<(), String> {
        self.cpc
            .call(
                "set_quota",
                map(vec![
                    (0, self.c.to_cbor()),
                    (
                        1,
                        Cbor::Array(vec![
                            Cbor::Uint(storage),
                            Cbor::Uint(items),
                            Cbor::Uint(bytes),
                            Cbor::Uint(burst),
                        ]),
                    ),
                ]),
            )
            .await
            .map_err(e2s)?;
        Ok(())
    }

    /// Connect a device.
    pub async fn connect(&self, d: &Device) -> Result<Client, String> {
        Client::connect(&self.t.ws, &self.c, Cred::Device(d), &self.cp)
            .await
            .map_err(e2s)
    }

    /// The head as `(seq, chain)`.
    pub async fn head(&self, c: &Client) -> Result<(u64, B32), String> {
        let h: HeadResult = c
            .call_t("head", &HeadParams { collection: self.c })
            .await
            .map_err(e2s)?;
        Ok((h.head, h.head_chain))
    }

    /// One append.
    pub async fn append(
        &self,
        c: &Client,
        seq: u64,
        prev: B32,
        items: Vec<Vec<u8>>,
    ) -> Result<AppendResult, ServiceError> {
        c.call_t(
            "append",
            &AppendParams {
                collection: self.c,
                expect_seq: seq,
                expect_prev: prev,
                items: items.into_iter().map(Bytes).collect(),
            },
        )
        .await
    }

    /// An entry by `d` at `(seq, prev)` under `epoch`, token from `label`.
    pub fn entry(&self, d: &Device, seq: u64, prev: B32, epoch: u64, label: &str) -> Vec<u8> {
        d.entry(
            self.c,
            seq,
            prev,
            epoch,
            id16(&format!("{}/{label}", self.c.to_hex())),
            None,
            filler(label, 200),
        )
    }

    /// A batch of `n` consecutive entries starting at `(seq, prev)`.
    pub fn entries(
        &self,
        d: &Device,
        seq: u64,
        prev: B32,
        epoch: u64,
        label: &str,
        n: usize,
    ) -> (Vec<Vec<u8>>, B32) {
        let mut out = Vec::new();
        let mut p = prev;
        for i in 0..n {
            let e = self.entry(d, seq + i as u64, p, epoch, &format!("{label}/{i}"));
            p = chain_hash(&e);
            out.push(e);
        }
        (out, p)
    }

    /// Append entries at the head, re-planning on `head_moved` (the writer loop of
    /// `log-entry.md` §3.1). Returns the first position.
    pub async fn append_at_head(
        &self,
        c: &Client,
        d: &Device,
        epoch: u64,
        label: &str,
        n: usize,
    ) -> Result<u64, ServiceError> {
        let (mut seq, mut prev) = {
            let h: HeadResult = c.call_t("head", &HeadParams { collection: self.c }).await?;
            (h.head + 1, h.head_chain)
        };
        loop {
            let (items, _) = self.entries(d, seq, prev, epoch, label, n);
            match self.append(c, seq, prev, items).await? {
                AppendResult::Appended(a) => return Ok(a.first),
                AppendResult::HeadMoved(h) => {
                    seq = h.head + 1;
                    prev = h.head_chain;
                }
                AppendResult::Duplicate(_) => {
                    return Err(ServiceError::new(Code::Invalid).msg("duplicate"));
                }
            }
        }
    }

    /// Append a policy item from the control plane at the head, re-signing on
    /// `head_moved` (`log-entry.md` §8). Returns its position.
    pub async fn policy(&self, ops: Vec<PolicyOp>) -> Result<u64, ServiceError> {
        let mut h: HeadResult = self
            .cpc
            .call_t("head", &HeadParams { collection: self.c })
            .await?;
        loop {
            let issued = self.issued.fetch_add(1, Ordering::Relaxed);
            let item = self
                .cp
                .policy_item(self.c, h.head + 1, h.head_chain, ops.clone(), issued);
            match self
                .append(&self.cpc, h.head + 1, h.head_chain, vec![item])
                .await?
            {
                AppendResult::Appended(a) => return Ok(a.first),
                AppendResult::HeadMoved(m) => {
                    h.head = m.head;
                    h.head_chain = m.head_chain;
                }
                AppendResult::Duplicate(_) => return Err(ServiceError::invalid("duplicate")),
            }
        }
    }

    /// A rekey by `d` from epoch `from`, re-planned at the head.
    pub async fn rekey(
        &self,
        c: &Client,
        d: &Device,
        from: u64,
        recipients: &[Uuid],
    ) -> Result<u64, String> {
        let (mut seq, mut prev) = self.head(c).await?;
        loop {
            let item = d.rekey(self.c, seq + 1, prev, from, recipients);
            match self
                .append(c, seq + 1, prev, vec![item])
                .await
                .map_err(e2s)?
            {
                AppendResult::Appended(a) => return Ok(a.first),
                AppendResult::HeadMoved(h) => {
                    seq = h.head;
                    prev = h.head_chain;
                }
                AppendResult::Duplicate(_) => return Err("duplicate rekey".into()),
            }
        }
    }
}
