//! The `access` commands: list, approve, deny, acknowledge and revoke app grants.

use super::*;

pub(super) async fn access_command(
    profile: &Profile,
    out: &Output,
    cmd: AccessCmd,
) -> Result<ExitCode, ClientError> {
    use crate::access::{AccessEntry, AccessState};
    let print = |e: &AccessEntry| {
        let state = match e.state {
            AccessState::Active if !e.acknowledged => "active (new)",
            AccessState::Active => "active",
            AccessState::PendingApproval => "waiting for approval",
            AccessState::Denied => "declined",
            AccessState::RevokedLocally => "revoked on this computer",
        };
        println!("  {}  {}  [{state}]", e.grant.grant, e.grant.app_name);
        println!(
            "      collection {}  {}  key {}",
            e.grant.collection,
            e.grant.capabilities.join(", "),
            e.grant.fingerprint()
        );
    };
    let (method, grant) = match cmd {
        AccessCmd::List { collection } => {
            let c = match collection {
                Some(c) => Some(resolve(profile, &c).await?),
                None => None,
            };
            let v = call(profile, Method::ACCESS_LIST, json!({ "collection": c })).await?;
            if out.json {
                out.value(&v);
            } else {
                let list: Vec<AccessEntry> =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                if list.is_empty() {
                    println!("No apps use your local collections through this computer.");
                }
                list.iter().for_each(print);
            }
            return Ok(ExitCode::SUCCESS);
        }
        AccessCmd::Revoke { grant } => (Method::ACCESS_REVOKE, grant),
        AccessCmd::Approve { grant } => {
            if !confirm(
                out,
                "Approve this app? Check that its key matches the one the app showed you.",
            ) {
                return Ok(ExitCode::from(1));
            }
            (Method::ACCESS_APPROVE, grant)
        }
        AccessCmd::Deny { grant } => (Method::ACCESS_DENY, grant),
        AccessCmd::Ack { grant } => (Method::ACCESS_ACK, grant),
    };
    let v = call(profile, method, json!({ "grant": grant })).await?;
    if out.json {
        out.value(&v);
    } else {
        let e: AccessEntry =
            serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
        print(&e);
    }
    Ok(ExitCode::SUCCESS)
}
