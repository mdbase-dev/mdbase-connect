//! Diagnostic: a named-pipe client opens while its server closes at once, as the
//! CLI's stop loop pings a daemon being ended. mio schedules the client's first
//! read on registration, so the read is submitted as the pipe breaks.
#[cfg(windows)]
#[tokio::main(worker_threads = 4)]
async fn main() {
    use tokio::io::AsyncReadExt;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
    let iterations: usize = std::env::args()
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(20_000);
    let name = format!(r"\\.\pipe\pipe-uaf-repro-{}", std::process::id());
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&name)
        .unwrap();
    for i in 0..iterations {
        let client = {
            let name = name.clone();
            tokio::spawn(async move {
                if let Ok(mut pipe) = ClientOptions::new().open(&name) {
                    let mut buf = [0u8; 16];
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        pipe.read(&mut buf),
                    )
                    .await;
                }
            })
        };
        let _ = server.connect().await;
        // Spin a varying few microseconds, then close: the client's read races the break.
        let spin = (i * 7919) % 2000;
        for _ in 0..spin {
            std::hint::spin_loop();
        }
        let next = ServerOptions::new().create(&name).unwrap();
        drop(std::mem::replace(&mut server, next));
        let _ = client.await;
        if i % 5000 == 0 {
            println!("{i}");
        }
    }
    println!("ok {iterations}");
}

#[cfg(not(windows))]
fn main() {}
