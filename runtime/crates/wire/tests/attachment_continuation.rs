//! Op18 whole-critical compatibility, not continuation activation.
use mdbn_wire::{
    Wire,
    attachment::AttachmentContentV1,
    attachment_runtime_v1 as r,
    common::{Hash, Uuid},
    fixtures,
};
mdbn_wire::wire_struct! {
    /// Exact historical Op13 body, for compatibility qualification.
    pub struct OldAttach {
        /// File ID.
        1 req id: Uuid,
        /// File path.
        2 req path: String,
        /// Attachment descriptor.
        3 req content: AttachmentContentV1,
        /// Prior whole hash.
        4 opt if_revision: Hash,
        /// External whole hash base.
        5 opt base: Hash,
    }
}
mdbn_wire::wire_union! {
    /// Historical attachment-only operation union.
    pub enum OldOp {
        /// Only critical13 was known.
        13 => FileAttach(OldAttach),
    }
}
#[test]
fn critical_op18_is_unknown_to_old13_and_original_op13_bytes_do_not_change() {
    for (name, continuation) in [
        ("runtime-v1-mixed", false),
        ("runtime-v1-ordinary-continuation", true),
    ] {
        let f = fixtures::all()
            .into_iter()
            .find(|f| f.format == "mutation" && f.name == name)
            .unwrap();
        let m = r::Mutation::from_bytes(&f.bytes).unwrap();
        assert_eq!(m.to_bytes().unwrap(), f.bytes);
        let bytes = m.ops[1].to_bytes().unwrap();
        if continuation {
            assert!(matches!(m.ops[1], r::Op::OrdinaryAttachmentContinuation(_)));
            assert!(OldOp::from_bytes(&bytes).unwrap_err().is_unknown());
        } else {
            let old = OldOp::from_bytes(&bytes).unwrap();
            assert_eq!(old.to_bytes().unwrap(), bytes);
        }
    }
    let bad = fixtures::negative()
        .into_iter()
        .find(|f| f.format == "mutation" && f.name == "runtime-v1-short-continuation-prior")
        .unwrap();
    assert!(
        !r::Mutation::from_bytes(&bad.bytes)
            .unwrap_err()
            .is_unknown()
    );
}
