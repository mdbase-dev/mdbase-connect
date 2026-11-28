use mdbn_replica::{ClientApi, HostedAdmission, SessionAuth, Store};
use mdbn_wire::client::{HelloParams, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, Text, Uuid, Version};
use mdbn_wire::entry::Status;
use mdbn_wire::intent::{ConflictMode, Create, Op, ResourcePut};

use super::Engine;

const METADATA_README: &str = include_str!("../../../../../templates/mdbase/README.md");
const README_PATH: &str = "_mdbase/README.md";

#[repr(u32)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Initialization {
    Pending,
    Confirmed,
    Refused,
}

fn initialization_id(collection: Uuid, request: Uuid, purpose: &[u8]) -> Uuid {
    let mut scope = b"mdbase:portal-cloud-copy-initialization:v1:".to_vec();
    scope.extend_from_slice(purpose);
    scope.extend_from_slice(&collection.0);
    scope.extend_from_slice(&request.0);
    let mut id: [u8; 16] = mdbn_wire::hash::sha256(&scope).0[..16].try_into().unwrap();
    id[6] = (id[6] & 0x0f) | 0x70;
    id[8] = (id[8] & 0x3f) | 0x80;
    B16(id)
}

impl<S: Store> Engine<S> {
    pub(crate) fn initialize_collection(
        &mut self,
        request: Uuid,
        timezone: Option<&str>,
        start: bool,
    ) -> Initialization {
        use Initialization::{Confirmed, Pending, Refused};

        if request.0 == [0; 16] {
            return Refused;
        }
        if !matches!(self.admission(), HostedAdmission::Verified(_)) {
            return Pending;
        }
        let mutation = initialization_id(self.collection, request, b"mutation");
        match self.replica.store().local_receipt(&mutation) {
            Ok(Some(receipt)) => {
                return match receipt.state {
                    ReceiptState::Confirmed
                        if receipt.seq.is_some()
                            && receipt.status == Some(Status::Applied)
                            && receipt.grant.is_none() =>
                    {
                        Confirmed
                    }
                    ReceiptState::Pending | ReceiptState::Unknown => Pending,
                    _ => Refused,
                };
            }
            Ok(None) => {}
            Err(_) => return Pending,
        }
        if !start {
            return Pending;
        }
        match self.replica.store().receipt(&mutation) {
            Ok(Some(_)) => return Refused,
            Err(_) => return Pending,
            Ok(None) => {}
        }
        let Ok((session, _)) = self.replica.hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 4 }],
                client_name: "portal-cloud-copy-initialization".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        ) else {
            return Pending;
        };
        let mut config = String::from(
            "spec_version: \"0.3.0\"\nsettings:\n  types_folder: _mdbase/types\n  contracts_folder: _mdbase/contracts\n",
        );
        if let Some(zone) = timezone
            .filter(|zone| mdbn_core::types::is_plausible_iana_zone(zone))
            .and_then(|zone| mdbn_core::cel::time::tzdb::NamedZone::get(zone).ok())
        {
            config.push_str(&format!("  timezone: \"{}\"\n", zone.name()));
        }
        let _ = self.replica.submit_logged(
            session,
            SubmitParams {
                ops: vec![
                    Op::ResourcePut(ResourcePut {
                        path: mdbn_core::types::CONFIG_PATH.into(),
                        doc: Text::Inline(config),
                        base_revision: None,
                        must_not_exist: Some(true),
                    }),
                    Op::Create(Create {
                        id: initialization_id(self.collection, request, b"readme"),
                        path: Some(README_PATH.into()),
                        type_name: None,
                        frontmatter: None,
                        body: None,
                        document: Some(Text::Inline(METADATA_README.into())),
                    }),
                ],
                mutation_id: Some(mutation),
                conflict_mode: Some(ConflictMode::Reject),
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: None,
            },
        );
        self.replica.close(session);
        Pending
    }
}
