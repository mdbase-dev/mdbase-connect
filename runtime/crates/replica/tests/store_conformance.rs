//! The reference store passes the conformance suite.

#[test]
fn mem_store_conforms() {
    mdbn_replica::conformance::run(mdbn_replica::mem::MemStore::new);
}

#[test]
fn mem_store_tail_conforms() {
    mdbn_replica::conformance::run_tail(mdbn_replica::mem::MemStore::new);
}
