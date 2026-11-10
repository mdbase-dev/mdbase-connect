//! The persisted `PolicyState` format.

use super::*;

impl PolicyState {
    // ------------------------------------------------------------ encoding

    /// Canonical bytes, for the store's `replica.policy` meta key. Always written
    /// as format [`POLICY_STATE_FORMAT`] (26 elements; element 24 is the
    /// cert-root witness, `null` while unproven; element 25 the handover roots).
    pub fn to_bytes(&self) -> Result<Vec<u8>, cbor::CborError> {
        let opt = |o: Option<Cbor>| o.unwrap_or(Cbor::Null);
        let devices = self
            .devices
            .iter()
            .map(|(id, d)| {
                Cbor::Array(vec![
                    id.to_cbor(),
                    d.account.to_cbor(),
                    d.kind.to_cbor(),
                    d.sign_pk.to_cbor(),
                    d.kem_pk.to_cbor(),
                    d.noise_pk.to_cbor(),
                    Cbor::Bool(d.active),
                    Cbor::Bool(d.keyed),
                    opt(d.introduced_by.map(|k| k.to_cbor())),
                    opt(d.delivered_by.map(|k| k.to_cbor())),
                    opt(d.local_root.map(|k| k.to_cbor())),
                    opt(d.sas_commit.map(|k| k.to_cbor())),
                ])
            })
            .collect();
        let grants =
            self.grants
                .iter()
                .map(|(id, g)| {
                    Cbor::Array(vec![
                        id.to_cbor(),
                        g.installation.to_cbor(),
                        Cbor::Text(g.app_id.clone()),
                        g.account.to_cbor(),
                        Cbor::Array(
                            g.capabilities
                                .iter()
                                .map(|c| Cbor::Text(c.clone()))
                                .collect(),
                        ),
                        g.client_pk.to_cbor(),
                        opt(g.file_folders.as_ref().map(|f| f.to_cbor())),
                        Cbor::Bool(g.active),
                        opt(g.approved.as_ref().map(|a| {
                            Cbor::Array(a.iter().map(|c| Cbor::Text(c.clone())).collect())
                        })),
                        opt(g.approved_folders.as_ref().map(|f| f.to_cbor())),
                        Cbor::Bool(g.folder_scoped),
                        opt(g.approved_seq.map(Cbor::Uint)),
                        opt(g.approved_by.map(|d| d.to_cbor())),
                    ])
                })
                .collect();
        let c = Cbor::Array(vec![
            Cbor::Uint(POLICY_STATE_FORMAT),
            Cbor::Uint(self.seq),
            opt(self.root.map(|r| r.to_cbor())),
            opt(self.root_pk.map(|r| r.to_cbor())),
            opt(self.owner.map(|r| r.to_cbor())),
            opt(self.cstate.map(|r| r.to_cbor())),
            Cbor::Bool(self.compress),
            Cbor::Uint(self.min_sem_major),
            Cbor::Bool(self.frozen),
            opt(self.last_issued_at.map(Cbor::int)),
            Cbor::Array(
                self.revoked_cp_keys
                    .iter()
                    .map(|(k, t)| Cbor::Array(vec![k.to_cbor(), Cbor::int(*t)]))
                    .collect(),
            ),
            Cbor::Array(
                self.members
                    .iter()
                    .map(|(a, r)| Cbor::Array(vec![a.to_cbor(), r.to_cbor()]))
                    .collect(),
            ),
            Cbor::Array(devices),
            Cbor::Array(grants),
            Cbor::Uint(self.epoch),
            Cbor::Bool(self.rekey_required),
            Cbor::Uint(self.sem_ratchet),
            Cbor::int(self.log_time),
            Cbor::Bool(self.content_seen),
            opt(self.cutover.map(Cbor::Uint)),
            Cbor::Uint(self.voids),
            self.ctl_chain.to_cbor(),
            Cbor::Array(
                self.signed_by_key
                    .iter()
                    .map(|(k, v)| {
                        Cbor::Array(vec![
                            k.to_cbor(),
                            Cbor::Array(
                                v.iter()
                                    .map(|(p, t)| Cbor::Array(vec![Cbor::Uint(*p), Cbor::int(*t)]))
                                    .collect(),
                            ),
                        ])
                    })
                    .collect(),
            ),
            Cbor::Array(self.cp_roots.iter().map(|r| r.to_cbor()).collect()),
            opt(self.cert_roots.as_ref().map(|w| {
                Cbor::Array(
                    w.iter()
                        .map(|(k, r)| Cbor::Array(vec![k.to_cbor(), r.to_cbor()]))
                        .collect(),
                )
            })),
            Cbor::Array(self.handover_roots.iter().map(|r| r.to_cbor()).collect()),
        ]);
        cbor::encode(&c)
    }

    /// Decode [`PolicyState::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Result<PolicyState, SchemaError> {
        let c = cbor::decode(bytes)?;
        let a = arr(&c)?;
        // Format 4 (current): 26 elements, element 25 the handover roots;
        // grant rows have 13 elements (format 3 and earlier: 10, read with the
        // folder-scoped flag and the approval position and signer unset).
        // Format 3: 26 elements, element 25 the handover roots.
        // Format 2: 25 elements, read with no handover roots recorded (a state
        // bricked by a later handover recovers by a cold rebuild, which replays
        // the handover and records it).
        // Element 24 is the cert-root witness.
        // Format 1: 24 elements, persisted before the witness existed; it is read
        // as unproven (`cert_roots: None`) and rewritten as the current format on the next
        // commit. A pinned warm reopen refuses an unproven state (rebuild and
        // replay under the pins). Readers that predate format 2 accept only
        // `[1, ..24 elements]`, so they refuse format 2 as an unknown format.
        //
        // `[1, ..25 elements]` is a pre-release format-1 state with the witness
        // in format 2's position. It is read as format 2 and rewritten as the
        // current format on the next commit.
        match (a.first(), a.len()) {
            (Some(Cbor::Uint(1)), 24 | 25)
            | (Some(Cbor::Uint(2)), 25)
            | (Some(Cbor::Uint(3)), 26)
            | (Some(Cbor::Uint(POLICY_STATE_FORMAT)), 26) => {}
            _ => return Err(bad("PolicyState: unknown format")),
        }
        let mut s = PolicyState::new();
        s.seq = u64::from_cbor(&a[1])?;
        s.root = opt(&a[2])?;
        s.root_pk = opt(&a[3])?;
        s.owner = opt(&a[4])?;
        s.cstate = opt(&a[5])?;
        s.compress = bool::from_cbor(&a[6])?;
        s.min_sem_major = u64::from_cbor(&a[7])?;
        s.frozen = bool::from_cbor(&a[8])?;
        s.last_issued_at = opt(&a[9])?;
        for kv in arr(&a[10])? {
            let kv = arr(kv)?;
            if kv.len() != 2 {
                return Err(bad("revoked key"));
            }
            s.revoked_cp_keys
                .insert(B16::from_cbor(&kv[0])?, i64::from_cbor(&kv[1])?);
        }
        for kv in arr(&a[11])? {
            let kv = arr(kv)?;
            if kv.len() != 2 {
                return Err(bad("member"));
            }
            s.members
                .insert(Uuid::from_cbor(&kv[0])?, Role::from_cbor(&kv[1])?);
        }
        for d in arr(&a[12])? {
            let d = arr(d)?;
            // 12 elements since `sas_commit`; 11 before.
            if d.len() != 11 && d.len() != 12 {
                return Err(bad("device"));
            }
            s.devices.insert(
                Uuid::from_cbor(&d[0])?,
                DeviceState {
                    account: Uuid::from_cbor(&d[1])?,
                    kind: DeviceKind::from_cbor(&d[2])?,
                    sign_pk: B32::from_cbor(&d[3])?,
                    kem_pk: B32::from_cbor(&d[4])?,
                    noise_pk: B32::from_cbor(&d[5])?,
                    active: bool::from_cbor(&d[6])?,
                    keyed: bool::from_cbor(&d[7])?,
                    introduced_by: opt(&d[8])?,
                    delivered_by: opt(&d[9])?,
                    local_root: opt(&d[10])?,
                    sas_commit: match d.get(11) {
                        Some(c) => opt(c)?,
                        None => None,
                    },
                },
            );
        }
        for g in arr(&a[13])? {
            let g = arr(g)?;
            if g.len() != 10 && g.len() != 13 {
                return Err(bad("grant"));
            }
            s.grants.insert(
                Uuid::from_cbor(&g[0])?,
                GrantState {
                    installation: Uuid::from_cbor(&g[1])?,
                    app_id: String::from_cbor(&g[2])?,
                    account: Uuid::from_cbor(&g[3])?,
                    capabilities: Vec::<String>::from_cbor(&g[4])?.into_iter().collect(),
                    client_pk: B32::from_cbor(&g[5])?,
                    file_folders: opt(&g[6])?,
                    folder_scoped: match g.get(10) {
                        Some(c) => bool::from_cbor(c)?,
                        None => false,
                    },
                    active: bool::from_cbor(&g[7])?,
                    approved: opt::<Vec<String>>(&g[8])?.map(|v| v.into_iter().collect()),
                    approved_folders: opt(&g[9])?,
                    approved_seq: match g.get(11) {
                        Some(c) => opt(c)?,
                        None => None,
                    },
                    approved_by: match g.get(12) {
                        Some(c) => opt(c)?,
                        None => None,
                    },
                },
            );
        }
        s.epoch = u64::from_cbor(&a[14])?;
        s.rekey_required = bool::from_cbor(&a[15])?;
        s.sem_ratchet = u64::from_cbor(&a[16])?;
        s.log_time = i64::from_cbor(&a[17])?;
        s.content_seen = bool::from_cbor(&a[18])?;
        s.cutover = opt(&a[19])?;
        s.voids = u64::from_cbor(&a[20])?;
        s.ctl_chain = B32::from_cbor(&a[21])?;
        for kv in arr(&a[22])? {
            let kv = arr(kv)?;
            if kv.len() != 2 {
                return Err(bad("signed_by_key"));
            }
            let mut v = Vec::new();
            for pt in arr(&kv[1])? {
                let pt = arr(pt)?;
                if pt.len() != 2 {
                    return Err(bad("signed_by_key"));
                }
                v.push((u64::from_cbor(&pt[0])?, i64::from_cbor(&pt[1])?));
            }
            s.signed_by_key.insert(B16::from_cbor(&kv[0])?, v);
        }
        for r in arr(&a[23])? {
            s.cp_roots.insert(B32::from_cbor(r)?);
        }
        s.cert_roots = match a.get(24) {
            None | Some(Cbor::Null) => None,
            Some(w) => {
                let mut set = BTreeSet::new();
                for kv in arr(w)? {
                    let kv = arr(kv)?;
                    if kv.len() != 2 {
                        return Err(bad("cert_roots"));
                    }
                    set.insert((B16::from_cbor(&kv[0])?, B16::from_cbor(&kv[1])?));
                }
                Some(set)
            }
        };
        if let Some(h) = a.get(25) {
            for r in arr(h)? {
                s.handover_roots.insert(B16::from_cbor(r)?);
            }
        }
        Ok(s)
    }
}

fn bad(reason: &'static str) -> SchemaError {
    SchemaError::Invalid {
        ty: "PolicyState",
        reason,
    }
}

fn arr(c: &Cbor) -> Result<&[Cbor], SchemaError> {
    mdbn_wire::schema::array(c, "PolicyState")
}

fn opt<T: Wire>(c: &Cbor) -> Result<Option<T>, SchemaError> {
    match c {
        Cbor::Null => Ok(None),
        c => Ok(Some(T::from_cbor(c)?)),
    }
}
