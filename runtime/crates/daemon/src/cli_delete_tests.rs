//! The CLI forwards explicit shared-name confirmation and renders daemon results.
use super::*;
use crate::{
    control::{Request, Response},
    ipc,
};

const COLLECTION: &str = "44444444-4444-4444-8444-444444444444";

#[test]
fn collection_delete_requires_confirmation_even_with_yes() {
    let error =
        Cli::try_parse_from(["mdbase", "--yes", "collection", "delete", "Research"]).unwrap_err();
    assert_eq!(
        error.kind(),
        clap::error::ErrorKind::MissingRequiredArgument
    );
    assert!(error.to_string().contains("--confirm <NAME>"));
}

#[tokio::test]
async fn collection_delete_cli_success_and_refusals() {
    // Relative to this test crate, so even a long checkout path fits a Unix socket.
    let root = PathBuf::from("../../target/t").join(format!("cd{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let profile = Profile::isolated(&root).unwrap();
    for (confirm, error) in [
        (
            "Wrong name",
            Some(ControlError::invalid(
                "collection_name_mismatch",
                "The name you typed does not match this collection's name.",
            )),
        ),
        (
            "Research",
            Some(ControlError::new(
                "not_authorized",
                "device_not_enrolled",
                "Join this collection on this computer first, then try again.",
            )),
        ),
        ("Research", None),
    ] {
        let expected_error = error.as_ref().map(|e| e.reason.clone());
        let mut listener = ipc::Listener::bind(&profile.control).unwrap();
        let fixture = tokio::spawn(async move {
            let mut stream = listener.accept().await.unwrap();
            let bytes = ipc::read_frame(&mut stream, ipc::MAX_CONTROL_FRAME)
                .await
                .unwrap()
                .unwrap();
            let request: Request = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request.method, Method::COLLECTION_DELETE);
            assert_eq!(
                request.params,
                json!({"collection":COLLECTION,"confirm_name":confirm})
            );
            let response = match error {
                Some(error) => Response::err(request.id, error),
                None => Response::ok(
                    request.id,
                    json!({"collection_id":COLLECTION,"deleted":true}),
                ),
            };
            ipc::write_frame(&mut stream, &serde_json::to_vec(&response).unwrap())
                .await
                .unwrap();
            listener.cleanup();
        });
        let result = run_command(
            Command::Collection(CollectionCmd::Delete {
                collection: COLLECTION.into(),
                confirm: confirm.into(),
            }),
            &profile,
            &Output {
                json: false,
                yes: true,
            },
        )
        .await;
        fixture.await.unwrap();
        match expected_error.flatten().as_deref() {
            Some(reason) => {
                let ClientError::Remote(error) = result.unwrap_err() else {
                    panic!("expected a daemon refusal");
                };
                assert_eq!(error.reason.as_deref(), Some(reason));
                if reason == "device_not_enrolled" {
                    assert_eq!(
                        error.message,
                        "Join this collection on this computer first, then try again."
                    );
                }
                assert_eq!(
                    Output {
                        json: false,
                        yes: true
                    }
                    .error(&ClientError::Remote(error)),
                    ExitCode::from(1)
                );
            }
            None => assert_eq!(result.unwrap(), ExitCode::SUCCESS),
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}
