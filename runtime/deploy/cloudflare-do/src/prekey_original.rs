//! Private CLOSED-actor public-input capture. This is not an original-caller
//! witness: the genuine closed HTTP nonce/caller producer is not wired yet.
//! No SQL, ordinary service config, testkit, or request-selected trust. V2 source
//! primitives remain behind the unqualified producer guard; no positive witness.

mod v2;

use js_sys::{Array, Object, Reflect, Uint8Array};
use mdbn_log_service::auth::NonceCache;
use mdbn_log_service::decode::Budget;
use mdbn_log_service::model::{parse_uuid, unhex};
use mdbn_wire::common::B32;
use std::cell::{Cell, RefCell};
use wasm_bindgen::JsValue;
use worker::{Env, ObjectNamespace, State, Url};

const MAX_CONFIG_BYTES: usize = 4096;
const MAX_ROOTS: usize = 16;
const RUN: &str = "gate4-pitr-lab-20261009-01";
const NIL: &str = "00000000-0000-0000-0000-000000000000";
const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

#[derive(Clone)]
struct Member {
    kind: String,
    collection: String,
    namespace: String,
    object: String,
}

struct Binding {
    run: String,
    active: String,
    deleted: String,
    code_config_sha256: String,
    members: Vec<Member>,
}

/// Captured public inputs reserved for the subsequent native verifier. They are
/// never exported as a permit or substituted for an authenticated caller.
struct PublicInputs {
    _roots: Vec<B32>,
    _audience: String,
    _binding: Binding,
    _minimum_epoch: u64,
    namespace: ObjectNamespace,
    member: Member,
}

pub(crate) struct ClosedOriginal {
    state: State,
    env: Env,
    inputs: Option<PublicInputs>,
    seen: NonceCache,
    next: Cell<u64>,
    slot: RefCell<Option<Slot>>,
}

enum Slot {
    Reading(u64),
    Authenticated {
        handle: u64,
        challenge: [u8; 32],
        auth: Box<v2::Authenticated>,
    },
}
impl Slot {
    fn handle(&self) -> u64 {
        match self {
            Self::Reading(handle) | Self::Authenticated { handle, .. } => *handle,
        }
    }
}
struct Reservation<'a> {
    slot: &'a RefCell<Option<Slot>>,
    handle: u64,
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut slot = self.slot.borrow_mut();
        if matches!(slot.as_ref(), Some(Slot::Reading(handle)) if *handle == self.handle) {
            *slot = None;
        }
    }
}

// Minimal native-owned verification bytes, never a host DTO/custody export.
// Volatile writes prevent the drop wipe being optimized away; no await holds it.
struct VerificationBytes(Vec<u8>);
impl Drop for VerificationBytes {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            // SAFETY: each byte is a live uniquely borrowed element of this Vec.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    }
}

impl ClosedOriginal {
    pub(crate) fn new(state: State, env: &Env) -> Self {
        let inputs = capture(&state, env);
        Self {
            state,
            env: env.clone(),
            inputs,
            seen: NonceCache::default(),
            next: Cell::new(1),
            slot: RefCell::new(None),
        }
    }

    /// Source-only v2 pipeline. The producer guard still refuses BEFORE request
    /// body/secret access: actual external clock/floor/drain authority is unheld.
    pub(crate) async fn begin(
        &self,
        raw: worker::worker_sys::web_sys::Request,
    ) -> Result<Uint8Array, JsValue> {
        self.require_caller_producer()?;
        let refused = || JsValue::from_str("prekey_caller_unavailable");
        let inputs = self.inputs.as_ref().ok_or_else(refused)?;
        let request = worker::Request::from(raw);
        let url = request.url().map_err(|_| refused())?;
        let query: Vec<_> = url.query_pairs().collect();
        if request.method() != worker::Method::Post
            || url.path() != "/v1/rpc"
            || query.len() != 1
            || query[0].0 != "c"
            || query[0].1 != inputs.member.collection
        {
            return Err(refused());
        }
        let collection = parse_uuid(&inputs.member.collection).ok_or_else(refused)?;
        let issuer_text = public_var(&self.env, "LOGSVC_TOKEN_ISSUERS").ok_or_else(refused)?;
        let issuers = parse_roots(&issuer_text)
            .filter(|keys| keys.len() <= 2)
            .ok_or_else(refused)?;
        let headers = request.headers();
        let authorization = headers
            .get("authorization")
            .map_err(|_| refused())?
            .ok_or_else(refused)?;
        let token = authorization.strip_prefix("Bearer ").ok_or_else(refused)?;
        let nonce = headers
            .get("x-mdbase-nonce")
            .map_err(|_| refused())?
            .ok_or_else(refused)?;
        let signature = headers
            .get("x-mdbase-sig")
            .map_err(|_| refused())?
            .ok_or_else(refused)?;
        if nonce.len() != 64 || signature.len() != 128 {
            return Err(refused());
        }
        let budget = Budget::default();
        let verified =
            v2::preflight(token, &issuers, crate::now_ms(), &budget).map_err(|_| refused())?;
        let handle = self.next.get();
        if handle == 0 || handle > MAX_SAFE_INTEGER || self.slot.borrow().is_some() {
            return Err(refused());
        }
        self.next.set(handle + 1);
        *self.slot.borrow_mut() = Some(Slot::Reading(handle));
        let _reservation = Reservation {
            slot: &self.slot,
            handle,
        };
        let body = crate::ingress::read(&request, v2::BODY_CAP)
            .await
            .map_err(|_| refused())?;
        self.require_caller_producer()?;
        if !matches!(self.slot.borrow().as_ref(), Some(Slot::Reading(current)) if *current == handle)
        {
            return Err(refused());
        }
        // The existing key only, one bounded native text buffer and one decoded
        // verification buffer; no config(), private sealer or new key is loaded.
        let binding = self
            .env
            .secret("LOGSVC_URL_SECRET")
            .map_err(|_| refused())?;
        let text = js_sys::JsString::from(binding.as_ref().clone());
        if text.length() != 64 {
            return Err(refused());
        }
        let text = VerificationBytes(String::from(text).into_bytes());
        let secret = VerificationBytes(
            unhex(std::str::from_utf8(&text.0).map_err(|_| refused())?).ok_or_else(refused)?,
        );
        let auth = v2::authenticate(
            v2::HttpProof {
                token,
                nonce: &nonce,
                signature: &signature,
                path: url.path(),
            },
            &body.bytes,
            v2::VerifyInputs {
                verified: &verified,
                secret: &secret.0,
                seen: &self.seen,
                now: crate::now_ms(),
                collection,
                budget,
            },
        )
        .map_err(|_| refused())?;
        drop(secret);
        drop(text);
        let challenge = crate::random_bytes();
        let bytes = auth.begin_data(handle, challenge).map_err(|_| refused())?;
        *self.slot.borrow_mut() = Some(Slot::Authenticated {
            handle,
            challenge,
            auth: Box::new(auth),
        });
        Ok(Uint8Array::from(bytes.as_slice()))
    }

    pub(crate) fn accept(&self, handle: u64, envelope: Uint8Array) -> Result<(), JsValue> {
        self.require_caller_producer()?;
        if envelope.length() == 0 || envelope.length() as usize > v2::ENVELOPE_CAP {
            return Err(JsValue::from_str("prekey_envelope_refused"));
        }
        let refused = || JsValue::from_str("prekey_ticket_refused");
        let slot = self.slot.borrow();
        let Some(Slot::Authenticated {
            handle: current,
            challenge,
            auth,
        }) = slot.as_ref()
        else {
            return Err(refused());
        };
        if *current != handle {
            return Err(refused());
        }
        let inputs = self.inputs.as_ref().ok_or_else(refused)?;
        let bytes = envelope.to_vec(); // Bounded JS view BEFORE owned copy.
        let _original = auth
            .admission(
                &bytes,
                &inputs._roots,
                &inputs._audience,
                &inputs._binding.run,
                challenge,
            )
            .map_err(|_| JsValue::from_str("prekey_envelope_refused"))?;
        // Historical crypto/binder success is not an external receive/current
        // clock/floor/phase proof. Do NOT release a positive witness here.
        Err(JsValue::from_str("prekey_caller_unavailable"))
    }

    pub(crate) fn finish(&self, handle: u64) -> Result<(), JsValue> {
        let mut slot = self.slot.borrow_mut();
        if slot.as_ref().is_none_or(|slot| slot.handle() != handle) {
            return Err(JsValue::from_str("prekey_ticket_refused"));
        }
        *slot = None;
        // Finishing never resets seen nonce state, including after CP failure.
        Ok(())
    }

    pub(crate) fn state(&self) -> &State {
        &self.state
    }

    /// Void-or-throw physical guard, not caller verification or serving authority.
    pub(crate) fn require_caller_producer(&self) -> Result<(), JsValue> {
        let refused = || JsValue::from_str("prekey_context_refused");
        let inputs = self.inputs.as_ref().ok_or_else(refused)?;
        let expected = inputs
            .namespace
            .id_from_name(&inputs.member.collection)
            .map_err(|_| refused())?;
        if self.state.id() != expected || self.state.id().to_string() != inputs.member.object {
            return Err(refused());
        }
        // Do not replace LOG's authenticated HTTP nonce/VerifiedCaller with
        // syntactically valid headers, a CP signature, or an authority boolean.
        Err(JsValue::from_str("prekey_caller_unavailable"))
    }
}

fn public_var(env: &Env, key: &str) -> Option<String> {
    let binding = env.var(key).ok()?;
    let text = js_sys::JsString::from(binding.as_ref().clone());
    // Bound the native JS string before copying into WASM. The subsequent UTF-8
    // check also rejects multibyte values over the configured byte budget.
    if text.length() as usize > MAX_CONFIG_BYTES {
        return None;
    }
    let value = String::from(text);
    (value.len() <= MAX_CONFIG_BYTES).then_some(value)
}

fn capture(state: &State, env: &Env) -> Option<PublicInputs> {
    // Missing/invalid public config refuses before accessing the namespace,
    // request body, ordinary config(), private keys, or actor storage.
    if public_var(env, "LAB")?.as_str() != "1" || public_var(env, "SERVICE_KIND")?.as_str() != "log"
    {
        return None;
    }
    let binding = parse_binding(&public_var(env, "PITR_BINDING")?)?;
    let minimum_epoch = parse_epoch(&public_var(env, "PITR_MINIMUM_EPOCH")?)?;
    let roots = parse_roots(&public_var(env, "LOGSVC_ROOT_KEYS")?)?;
    let audience = parse_audience(&public_var(env, "CP_URL")?)?;
    let namespace = env.durable_object("LOG").ok()?;
    let mut matches = binding.members.iter().filter(|member| {
        member.kind == "log"
            && namespace
                .id_from_name(&member.collection)
                .ok()
                .is_some_and(|expected| {
                    state.id() == expected && state.id().to_string() == member.object
                })
    });
    let member = matches.next()?.clone();
    if matches.next().is_some() {
        return None;
    }
    Some(PublicInputs {
        _roots: roots,
        _audience: audience,
        _binding: binding,
        _minimum_epoch: minimum_epoch,
        namespace,
        member,
    })
}

fn parse_roots(text: &str) -> Option<Vec<B32>> {
    if text.is_empty() || text.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let mut roots = Vec::new();
    for part in text.split(',') {
        let key = part.trim();
        if key.len() != 64
            || !key.bytes().all(|b| b.is_ascii_hexdigit())
            || roots.len() == MAX_ROOTS
        {
            return None;
        }
        let root = B32(unhex(key)?.try_into().ok()?);
        if root.0 == [0; 32] || roots.contains(&root) {
            return None;
        }
        roots.push(root);
    }
    (!roots.is_empty()).then_some(roots)
}

fn parse_audience(text: &str) -> Option<String> {
    if text.is_empty() || text.len() > 255 || !text.is_ascii() {
        return None;
    }
    let url = Url::parse(text).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.port() == Some(0)
        || url.origin().ascii_serialization() != text
        || !host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return None;
    }
    Some(text.to_owned())
}

fn parse_epoch(text: &str) -> Option<u64> {
    if text.is_empty()
        || text.len() > 16
        || text.starts_with('0')
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let epoch = text.parse::<u64>().ok()?;
    (epoch <= MAX_SAFE_INTEGER).then_some(epoch)
}

fn is_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn canonical_uuid(text: &str) -> bool {
    text.len() == 36
        && parse_uuid(text).is_some()
        && text.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

fn exact(value: &JsValue, keys: &[&str]) -> Option<()> {
    if !value.is_object() || value.is_null() || Array::is_array(value) {
        return None;
    }
    let object = Object::from(value.clone());
    let actual = Object::keys(&object);
    if actual.length() as usize != keys.len()
        || !actual.iter().all(|k| {
            k.as_string()
                .is_some_and(|key| keys.contains(&key.as_str()))
        })
    {
        return None;
    }
    Some(())
}

fn string(value: &JsValue, key: &str) -> Option<String> {
    Reflect::get(value, &JsValue::from_str(key))
        .ok()?
        .as_string()
}

fn parse_binding(text: &str) -> Option<Binding> {
    if text.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let value = js_sys::JSON::parse(text).ok()?;
    exact(
        &value,
        &["run", "active", "deleted", "codeConfigSha256", "members"],
    )?;
    let mut binding = Binding {
        run: string(&value, "run")?,
        active: string(&value, "active")?,
        deleted: string(&value, "deleted")?,
        code_config_sha256: string(&value, "codeConfigSha256")?,
        members: Vec::new(),
    };
    let raw = Reflect::get(&value, &JsValue::from_str("members")).ok()?;
    if !Array::is_array(&raw) {
        return None;
    }
    let raw = Array::from(&raw);
    if raw.length() != 5 {
        return None;
    }
    for member in raw.iter() {
        exact(&member, &["kind", "collection", "namespace", "object"])?;
        binding.members.push(Member {
            kind: string(&member, "kind")?,
            collection: string(&member, "collection")?,
            namespace: string(&member, "namespace")?,
            object: string(&member, "object")?,
        });
    }
    binding_valid(&binding).then_some(binding)
}

fn binding_valid(binding: &Binding) -> bool {
    if binding.run != RUN
        || !canonical_uuid(&binding.active)
        || !canonical_uuid(&binding.deleted)
        || binding.active == NIL
        || binding.deleted == NIL
        || binding.active == binding.deleted
        || !is_hex(&binding.code_config_sha256, 64)
        || binding.members.len() != 5
    {
        return false;
    }
    let mut pairs = Vec::new();
    let mut objects = Vec::new();
    let mut log_namespace = None;
    let mut hosted_namespace = None;
    for member in &binding.members {
        if !is_hex(&member.namespace, 32) || !is_hex(&member.object, 64) {
            return false;
        }
        match member.kind.as_str() {
            "log" | "hosted"
                if member.collection == binding.active || member.collection == binding.deleted => {}
            "registry" if member.collection == NIL => {}
            _ => return false,
        }
        let pair = (&member.kind, &member.collection);
        let object = (&member.namespace, &member.object);
        if pairs.contains(&pair) || objects.contains(&object) {
            return false;
        }
        pairs.push(pair);
        objects.push(object);
        let namespace = if member.kind == "hosted" {
            &mut hosted_namespace
        } else {
            &mut log_namespace
        };
        match *namespace {
            None => *namespace = Some(&member.namespace),
            Some(previous) if previous == &member.namespace => {}
            _ => return false,
        }
    }
    log_namespace.is_some() && hosted_namespace.is_some() && log_namespace != hosted_namespace
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_cleanup_is_exact_and_successor_safe() {
        let slot = RefCell::new(Some(Slot::Reading(7)));
        {
            let _reservation = Reservation {
                slot: &slot,
                handle: 7,
            };
        }
        assert!(slot.borrow().is_none());
        *slot.borrow_mut() = Some(Slot::Reading(8));
        {
            let _stale = Reservation {
                slot: &slot,
                handle: 7,
            };
        }
        assert_eq!(slot.borrow().as_ref().unwrap().handle(), 8);
    }

    #[test]
    fn roots_are_public_bounded_explicit_and_unique() {
        let first = "11".repeat(32);
        let second = "22".repeat(32);
        assert_eq!(parse_roots(&first).unwrap(), vec![B32([0x11; 32])]);
        assert_eq!(
            parse_roots(&format!(" {first}, {second} ")).unwrap().len(),
            2
        );
        for bad in [
            "".into(),
            "00".repeat(32),
            "11".repeat(31),
            format!("{first},"),
            format!("{first},{first}"),
            "testkit".into(),
            "1".repeat(MAX_CONFIG_BYTES + 1),
        ] {
            assert!(parse_roots(&bad).is_none());
        }
        let too_many = (1..=MAX_ROOTS + 1)
            .map(|n| format!("{n:064x}"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(parse_roots(&too_many).is_none());
    }

    #[test]
    fn audience_is_an_explicit_canonical_https_origin() {
        for good in ["https://cp.example", "https://127.0.0.1:8443"] {
            assert_eq!(parse_audience(good).as_deref(), Some(good));
        }
        for bad in [
            "",
            "http://cp.example",
            "https://cp.example/",
            "https://CP.example",
            "https://cp.example:443",
            "https://cp.example:0",
            "https://cp.example/path",
            "https://cp.example?x=1",
            "https://cp.example#x",
            "https://user@cp.example",
            "https://[::1]",
            "https://cp.example\n",
        ] {
            assert!(parse_audience(bad).is_none());
        }
    }

    #[test]
    fn epoch_is_positive_exact_and_javascript_safe() {
        assert_eq!(parse_epoch("1"), Some(1));
        assert_eq!(parse_epoch("9007199254740991"), Some(MAX_SAFE_INTEGER));
        for bad in ["", "0", "01", "-1", "1.0", "1e3", "9007199254740992", " 1"] {
            assert!(parse_epoch(bad).is_none());
        }
    }

    fn fixture() -> Binding {
        let active = "11111111-1111-1111-1111-111111111111".to_owned();
        let deleted = "22222222-2222-2222-2222-222222222222".to_owned();
        let members = [
            ("log", active.as_str()),
            ("log", deleted.as_str()),
            ("hosted", active.as_str()),
            ("hosted", deleted.as_str()),
            ("registry", NIL),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (kind, collection))| Member {
            kind: kind.into(),
            collection: collection.into(),
            namespace: if kind == "hosted" {
                "bb".repeat(16)
            } else {
                "aa".repeat(16)
            },
            object: format!("{:064x}", i + 1),
        })
        .collect();
        Binding {
            run: RUN.into(),
            active,
            deleted,
            code_config_sha256: "cc".repeat(32),
            members,
        }
    }

    #[test]
    fn exact_five_actor_declarations_are_not_owner_accounts() {
        let binding = fixture();
        assert!(binding_valid(&binding));
        assert_eq!(
            binding.members.iter().filter(|m| m.kind == "log").count(),
            2
        );
        assert_eq!(
            binding
                .members
                .iter()
                .filter(|m| m.kind == "registry" && m.collection == NIL)
                .count(),
            1
        );
    }

    #[test]
    fn profile_refuses_replacements_duplicates_and_namespace_aliases() {
        let mut binding = fixture();
        binding.members[1].collection = binding.active.clone();
        assert!(!binding_valid(&binding));
        let mut binding = fixture();
        binding.members[4].kind = "log".into();
        assert!(!binding_valid(&binding));
        let mut binding = fixture();
        binding.members[4].namespace = "bb".repeat(16);
        assert!(!binding_valid(&binding));
        let mut binding = fixture();
        binding.members[2].object = binding.members[3].object.clone();
        assert!(!binding_valid(&binding));
        let mut binding = fixture();
        binding.deleted = binding.active.clone();
        assert!(!binding_valid(&binding));
        let mut binding = fixture();
        binding.members.pop();
        assert!(!binding_valid(&binding));
    }
}
