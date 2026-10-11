//! Diagnostic: a named-pipe server answers and closes at once, as a daemon
//! answers the CLI's ping and is then ended. mio schedules the client's next
//! read as soon as the reply is consumed, so that read is submitted as the pipe
//! breaks. Several pairs run at once to widen the race.
#[cfg(windows)]
#[tokio::main(worker_threads = 4)]
async fn main() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
    let iterations: usize = std::env::args()
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(20_000);
    let mut pairs = Vec::new();
    for pair in 0..8 {
        pairs.push(tokio::spawn(async move {
            let name = format!(r"\\.\pipe\pipe-uaf-repro-{}-{pair}", std::process::id());
            let mut server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&name)
                .unwrap();
            for _ in 0..iterations {
                let client = {
                    let name = name.clone();
                    tokio::spawn(async move {
                        let Ok(mut pipe) = ClientOptions::new().open(&name) else {
                            return;
                        };
                        let mut buf = [0u8; 64];
                        loop {
                            match tokio::time::timeout(
                                std::time::Duration::from_secs(2),
                                pipe.read(&mut buf),
                            )
                            .await
                            {
                                Ok(Ok(n)) if n > 0 => continue,
                                _ => break,
                            }
                        }
                    })
                };
                if server.connect().await.is_ok() {
                    let _ = server.write_all(b"pong\n").await;
                }
                let next = ServerOptions::new().create(&name).unwrap();
                drop(std::mem::replace(&mut server, next));
                let _ = client.await;
            }
        }));
    }
    for pair in pairs {
        pair.await.unwrap();
    }
    println!("ok {}", iterations * 8);
}

#[cfg(not(windows))]
fn main() {}
