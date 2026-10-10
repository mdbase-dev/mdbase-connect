//! A small Postgres connection pool with per-connection statement caches.
//!
//! In-house rather than `deadpool-postgres`, which pulls getrandom's `wasm_js`
//! backend into the wasm32 dependency graph that `cargo deny` checks.

use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::{Client, Config, Error, NoTls, Statement};

use crate::pg::{tls_connector, tls_required};

/// One connection and its prepared statements.
pub struct Conn {
    client: Client,
    stmts: tokio::sync::Mutex<BTreeMap<String, Statement>>,
}

impl Conn {
    /// Prepare once per connection.
    pub async fn prepare_cached(&self, sql: &str) -> Result<Statement, Error> {
        let mut m = self.stmts.lock().await;
        if let Some(s) = m.get(sql) {
            return Ok(s.clone());
        }
        let s = self.client.prepare(sql).await?;
        m.insert(sql.to_string(), s.clone());
        Ok(s)
    }
}

impl Deref for Conn {
    type Target = Client;
    fn deref(&self) -> &Client {
        &self.client
    }
}
impl DerefMut for Conn {
    fn deref_mut(&mut self) -> &mut Client {
        &mut self.client
    }
}

struct Inner {
    cfg: Config,
    tls: bool,
    idle: Mutex<Vec<Conn>>,
    sem: Arc<Semaphore>,
}

/// A bounded pool.
#[derive(Clone)]
pub struct Pool(Arc<Inner>);

/// A checked-out connection; returned to the pool on drop unless it is closed.
pub struct Object {
    conn: Option<Conn>,
    pool: Arc<Inner>,
    _permit: OwnedSemaphorePermit,
}

impl Deref for Object {
    type Target = Conn;
    fn deref(&self) -> &Conn {
        self.conn.as_ref().expect("live connection")
    }
}
impl DerefMut for Object {
    fn deref_mut(&mut self) -> &mut Conn {
        self.conn.as_mut().expect("live connection")
    }
}
impl Drop for Object {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take()
            && !c.client.is_closed()
        {
            self.pool.idle.lock().unwrap().push(c);
        }
    }
}

/// Open one client, spawning its connection task. TLS when the URL requires it;
/// plaintext is refused off loopback (`tls_required`).
pub async fn connect_client(cfg: &Config) -> Result<Client, String> {
    if tls_required(cfg).map_err(|e| e.to_string())? {
        let (client, conn) = cfg
            .connect(tls_connector().map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())?;
        tokio::spawn(conn);
        Ok(client)
    } else {
        let (client, conn) = cfg.connect(NoTls).await.map_err(|e| e.to_string())?;
        tokio::spawn(conn);
        Ok(client)
    }
}

impl Pool {
    /// A pool of at most `max` connections. Validates TLS settings up front.
    pub fn new(cfg: Config, max: usize) -> Result<Pool, String> {
        let tls = tls_required(&cfg).map_err(|e| e.to_string())?;
        Ok(Pool(Arc::new(Inner {
            cfg,
            tls,
            idle: Mutex::new(Vec::new()),
            sem: Arc::new(Semaphore::new(max.max(1))),
        })))
    }

    /// Whether connections use TLS.
    pub fn tls(&self) -> bool {
        self.0.tls
    }

    /// Check out a connection, opening one if none is idle.
    pub async fn get(&self) -> Result<Object, String> {
        let permit = self
            .0
            .sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        loop {
            let idle = self.0.idle.lock().unwrap().pop();
            match idle {
                Some(c) if c.client.is_closed() => continue,
                Some(c) => {
                    return Ok(Object {
                        conn: Some(c),
                        pool: self.0.clone(),
                        _permit: permit,
                    });
                }
                None => break,
            }
        }
        let client = connect_client(&self.0.cfg).await?;
        Ok(Object {
            conn: Some(Conn {
                client,
                stmts: tokio::sync::Mutex::new(BTreeMap::new()),
            }),
            pool: self.0.clone(),
            _permit: permit,
        })
    }
}
