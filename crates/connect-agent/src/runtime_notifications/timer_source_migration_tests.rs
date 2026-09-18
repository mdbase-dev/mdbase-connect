use super::migrate_timer_source as migrate;
use mdbase_connect_runtime::TIMER_EVENT_DIGEST;
use mdbase_runtime::SqliteRuntimeStore;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

fn timer(collection: Uuid, id: &str, status: &str, version: &str) -> Value {
    json!({
        "id":id,"generation":7,"status":status,"fire_at":"2026-09-17T00:00:00Z",
        "event_contract":{"id":"mdbase.runtime.timer.fired","version":"1.0.0","digest":TIMER_EVENT_DIGEST},
        "event_source":{"application":"mdbase.connect","implementation":"notification-timer",
            "version":version,"instance_id":collection.to_string()},
        "source_uri":format!("urn:mdbase:connect:local:{collection}"),"subject":collection.to_string(),
        "data":{"synthetic":"unchanged"},"created_at":"2026-09-01T00:00:00Z",
        "updated_at":"2026-09-01T00:00:00Z",
        "fired_at":if status == "fired" { json!("2026-09-17T00:00:01Z") } else { Value::Null }
    })
}

fn insert(connection: &Connection, timer: &Value) {
    connection
        .execute(
            "INSERT INTO runtime_timers(id,generation,status,fire_at,record_json)
        VALUES(?1,7,?2,'2026-09-17T00:00:00.000Z',?3)",
            params![
                timer["id"].as_str().unwrap(),
                timer["status"].as_str().unwrap(),
                timer.to_string()
            ],
        )
        .unwrap();
}

fn rows(connection: &Connection) -> Vec<(String, i64, String, String, Value)> {
    connection
        .prepare("SELECT id,generation,status,fire_at,record_json FROM runtime_timers ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                serde_json::from_str(&row.get::<_, String>(4)?).unwrap(),
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn migration_preserves_everything_except_the_exact_legacy_source_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runtime.db");
    drop(SqliteRuntimeStore::open(&path).unwrap());
    let connection = Connection::open(&path).unwrap();
    let collection = Uuid::new_v4();
    for status in ["scheduled", "firing", "fired", "cancelled"] {
        insert(
            &connection,
            &timer(collection, status, status, "0.1.0-beta.103"),
        );
    }
    for version in [
        "0.1.0-beta.26",
        "0.1.0-beta.105",
        "0.1.0-beta.0103",
        "untrusted",
        "1.0.0",
    ] {
        insert(
            &connection,
            &timer(collection, version, "scheduled", version),
        );
    }
    let mut wrong_contract = timer(collection, "wrong-contract", "scheduled", "0.1.0-beta.104");
    wrong_contract["event_contract"]["digest"] = json!("sha256:unknown");
    insert(&connection, &wrong_contract);
    let other = timer(
        Uuid::new_v4(),
        "other-collection",
        "scheduled",
        "0.1.0-beta.104",
    );
    insert(&connection, &other);
    let mut wrong_source = timer(collection, "wrong-source", "scheduled", "0.1.0-beta.104");
    wrong_source["event_source"]["implementation"] = json!("untrusted");
    insert(&connection, &wrong_source);
    let before = rows(&connection);
    migrate(&path, collection).unwrap();
    let after = rows(&connection);
    let mut expected = before;
    for row in &mut expected {
        if ["scheduled", "firing", "fired", "cancelled"].contains(&row.0.as_str()) {
            row.4["event_source"]["version"] = json!("1.0.0");
        }
    }
    assert_eq!(after, expected);
    migrate(&path, collection).unwrap();
    assert_eq!(rows(&connection), after);
    drop(SqliteRuntimeStore::open(&path).unwrap()); // real persisted-record validation
}

#[test]
fn active_claim_blocks_the_whole_migration_without_rewriting_any_row() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runtime.db");
    drop(SqliteRuntimeStore::open(&path).unwrap());
    let connection = Connection::open(&path).unwrap();
    let collection = Uuid::new_v4();
    insert(
        &connection,
        &timer(collection, "first", "scheduled", "0.1.0-beta.104"),
    );
    insert(
        &connection,
        &timer(collection, "claimed", "firing", "0.1.0-beta.104"),
    );
    connection
        .execute(
            "UPDATE runtime_timers SET lease_token='synthetic',lease_worker='worker',
        lease_expires_at='2999-01-01T00:00:00.000Z' WHERE id='claimed'",
            [],
        )
        .unwrap();
    let before = rows(&connection);
    assert_eq!(
        migrate(&path, collection).unwrap_err().code(),
        "notification_timer_source_migration_busy"
    );
    assert_eq!(rows(&connection), before);
    connection.execute("UPDATE runtime_timers SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='claimed'",[]).unwrap();
    migrate(&path, collection).unwrap();
    let lease: Option<String> = connection
        .query_row(
            "SELECT lease_token FROM runtime_timers WHERE id='claimed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(lease, None); // an expired worker can no longer pass token fencing
    let late_commit = connection.execute(
        "UPDATE runtime_timers SET status='fired' WHERE id='claimed' AND lease_token='synthetic'",
        [],
    ).unwrap();
    assert_eq!(late_commit, 0);
}
