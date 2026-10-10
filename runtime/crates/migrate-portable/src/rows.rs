//! The metadata of one consistent legacy read, as the conversion rules see it.
//! Documents, object keys and bytes stay with the caller. Canonical-CBOR maps
//! (`mdbn_wire::schema::Wire`), so the same types cross the WASM ABI.

use mdbn_wire::wire_struct;

wire_struct! {
    /// A resource (configuration, type, view, …) by path.
    pub struct ResourceRow {
        /// Collection-relative path, e.g. `mdbase.yaml`.
        1 req path: String,
    }
}

wire_struct! {
    /// A current record by legacy ID and path.
    pub struct RecordRow {
        /// Canonical lowercase UUID.
        1 req record_id: String,
        /// Collection-relative path.
        2 req path: String,
    }
}

wire_struct! {
    /// A live file by legacy ID and path.
    pub struct FileRow {
        /// Canonical lowercase UUID.
        1 req file_id: String,
        /// Collection-relative path.
        2 req path: String,
    }
}

wire_struct! {
    /// One consistent legacy read, metadata only: the input of the preflight ABI.
    pub struct Read {
        /// Resources by path.
        1 req resources: Vec<ResourceRow>,
        /// Records by legacy ID and path.
        2 req records: Vec<RecordRow>,
        /// Live files by legacy ID and path.
        3 req files: Vec<FileRow>,
    }
}
