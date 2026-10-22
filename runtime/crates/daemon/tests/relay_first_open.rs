//! First-open lifecycle controls: real Noise and the production pipe carrier.
//! The synthetic handler isolates delivery/close, not native grant publication.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::result_large_err
)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use mdbn_daemon::noise::{self, Initiator, Transport};
use mdbn_daemon::pipes::{self, PipeCarrier, PipeOut};
use mdbn_daemon::session::{
    self, Auth, BoxFuture, Handler, Opened, Origin, Prologue, SessionChannels,
};
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{ClientFrame, ClientRequest, ClientResponse};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

const PIPE: [u8; 16] = [3; 16];
const COLLECTION: [u8; 16] = [1; 16];
const GRANT: [u8; 16] = [5; 16];
const DEVICE: [u8; 16] = [4; 16];
const SERVER_SECRET: [u8; 32] = [11; 32];
const CLIENT_SECRET: [u8; 32] = [12; 32];

#[derive(Clone, Copy)]
enum Mode {
    DeadInbound,
    Echo,
    Refused,
}

struct Host {
    mode: Mode,
    // Keep the outbound side live so EOF cannot race the dead-inbound branch.
    retained_outbound: Mutex<Option<mpsc::Sender<ClientFrame>>>,
}

impl Handler for Host {
    fn open<'a>(&'a self, p: Prologue, auth: Auth, hello: ClientRequest) -> BoxFuture<'a, Opened> {
        Box::pin(async move {
            assert_eq!(p.collection, COLLECTION);
            assert_eq!(p.target, DEVICE);
            assert_eq!(
                auth,
                Auth::Grant {
                    grant: GRANT,
                    client_pk: noise::public_key(&CLIENT_SECRET),
                }
            );
            if matches!(self.mode, Mode::Refused) {
                return Opened {
                    response: session::problem_response(
                        hello.id,
                        "forbidden",
                        "fixture_refused",
                        "synthetic admission refused",
                    ),
                    session: None,
                };
            }
            let (inbound, mut input) = mpsc::channel::<ClientFrame>(8);
            let (output, outbound) = mpsc::channel::<ClientFrame>(8);
            match self.mode {
                Mode::DeadInbound => {
                    drop(input);
                    *self.retained_outbound.lock().unwrap() = Some(output);
                }
                Mode::Echo => {
                    tokio::spawn(async move {
                        while let Some(ClientFrame::Request(r)) = input.recv().await {
                            if output
                                .send(ClientFrame::Response(ClientResponse {
                                    id: r.id,
                                    result: Some(r.params),
                                    problem: None,
                                }))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    });
                }
                Mode::Refused => unreachable!(),
            }
            Opened {
                response: ClientResponse {
                    id: hello.id,
                    result: Some(Cbor::Null),
                    problem: None,
                },
                session: Some(SessionChannels { inbound, outbound }),
            }
        })
    }
}

struct Client {
    input: mpsc::Sender<Vec<u8>>,
    output: mpsc::Receiver<PipeOut>,
    transport: Transport,
    task: JoinHandle<Result<(), session::SessionError>>,
    host: Arc<Host>,
}

fn request(id: u64, method: &str, params: Cbor) -> ClientFrame {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
}

fn framed(message: &[u8]) -> Vec<u8> {
    let mut bytes = (message.len() as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(message);
    bytes
}

async fn next(output: &mut mpsc::Receiver<PipeOut>) -> PipeOut {
    tokio::time::timeout(Duration::from_secs(2), output.recv())
        .await
        .expect("bounded protocol progress")
        .expect("pipe output")
}

async fn connect(mode: Mode) -> (Client, ClientResponse) {
    let host = Arc::new(Host {
        mode,
        retained_outbound: Mutex::new(None),
    });
    let (input, incoming) = mpsc::channel(8);
    let (outgoing, mut output) = mpsc::channel(8);
    let h = host.clone();
    let prologue = pipes::prologue(&COLLECTION, &GRANT, &DEVICE);
    let task = tokio::spawn(async move {
        let mut carrier = PipeCarrier::new(PIPE, incoming, outgoing);
        session::serve_session(
            &mut carrier,
            &prologue,
            Origin::RelayPipe,
            &SERVER_SECRET,
            DEVICE,
            h.as_ref(),
        )
        .await
    });
    let mut initiator = Initiator::new(
        &CLIENT_SECRET,
        &noise::public_key(&SERVER_SECRET),
        &prologue,
    );
    let m1 = initiator
        .write_message_1(
            &[13; 32],
            &request(0, "hello", Cbor::Null).to_bytes().unwrap(),
        )
        .unwrap();
    input.send(framed(&m1)).await.unwrap();
    let PipeOut::Frame(m2) = next(&mut output).await else {
        panic!("expected authenticated hello before any close");
    };
    let (id, payload) = pipes::parse_frame(&m2).unwrap();
    assert_eq!(id, PIPE);
    let (hello, transport) = initiator.read_message_2(&payload[4..]).unwrap();
    let ClientFrame::Response(hello) = ClientFrame::from_bytes(&hello).unwrap() else {
        panic!("expected hello response");
    };
    (
        Client {
            input,
            output,
            transport,
            task,
            host,
        },
        hello,
    )
}

async fn send(client: &mut Client, frame: ClientFrame) {
    let sealed = client
        .transport
        .seal(&framed(&frame.to_bytes().unwrap()))
        .unwrap();
    client.input.send(framed(&sealed)).await.unwrap();
}

#[tokio::test]
async fn dead_actor_inbound_closes_exactly_once_after_authenticated_hello() {
    let (mut client, hello) = connect(Mode::DeadInbound).await;
    assert!(hello.problem.is_none());
    assert!(client.host.retained_outbound.lock().unwrap().is_some());
    send(&mut client, request(1, "echo", Cbor::Null)).await;
    // Completion is the observation barrier, not a sleep or inferred readiness.
    tokio::time::timeout(Duration::from_secs(2), client.task)
        .await
        .expect("session must observe dead actor input")
        .unwrap()
        .unwrap();
    assert_eq!(
        client.output.try_recv().ok(),
        Some(PipeOut::Close(PIPE, "closed".into())),
        "accepted session termination must notify the relay"
    );
    assert!(client.output.try_recv().is_err(), "exactly one close");
}

#[tokio::test]
async fn healthy_new_session_delivers_a_frame_and_then_one_close() {
    let (mut client, hello) = connect(Mode::Echo).await;
    assert!(hello.problem.is_none());
    send(&mut client, request(1, "echo", Cbor::Text("alive".into()))).await;
    let PipeOut::Frame(bytes) = next(&mut client.output).await else {
        panic!("healthy session must answer");
    };
    let (_, payload) = pipes::parse_frame(&bytes).unwrap();
    let plain = client.transport.open(&payload[4..]).unwrap();
    let ClientFrame::Response(response) = ClientFrame::from_bytes(&plain[4..]).unwrap() else {
        panic!("expected response");
    };
    assert_eq!(
        (response.id, response.result),
        (1, Some(Cbor::Text("alive".into())))
    );
    drop(client.input);
    tokio::time::timeout(Duration::from_secs(2), client.task)
        .await
        .expect("carrier EOF closes session")
        .unwrap()
        .unwrap();
    assert_eq!(
        client.output.try_recv().ok(),
        Some(PipeOut::Close(PIPE, "closed".into()))
    );
    assert!(client.output.try_recv().is_err());
}

#[tokio::test]
async fn refused_session_returns_authenticated_problem_before_one_close() {
    let (mut client, hello) = connect(Mode::Refused).await;
    assert_eq!(
        hello.problem.unwrap().reason.as_deref(),
        Some("fixture_refused")
    );
    tokio::time::timeout(Duration::from_secs(2), client.task)
        .await
        .expect("refusal completes")
        .unwrap()
        .unwrap();
    assert_eq!(
        client.output.try_recv().ok(),
        Some(PipeOut::Close(PIPE, "closed".into()))
    );
    assert!(client.output.try_recv().is_err());
}
