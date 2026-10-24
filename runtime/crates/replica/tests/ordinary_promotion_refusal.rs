//! Legacy codecs still refuse promotion; the activated runtime uses Effect11.
use mdbn_core::{ids::Uuid, plan::Effect};
use mdbn_replica::convert::{self, ConvertError};

#[test]
fn ordinary_promotion_never_degrades_to_a_legacy_record_effect() {
    let effect = Effect::ReindexOrdinaryFile {
        id: Uuid([1; 16]),
        path: "views/default.base".into(),
        doc: "views: []\r\n".into(),
    };
    assert!(matches!(
        convert::weffect(&effect),
        Err(ConvertError::OrdinaryFilePromotionUnsupported)
    ));
    assert!(matches!(
        convert::wruntime_effect(&effect),
        Ok(mdbn_wire::attachment_runtime_v1::Effect::ReindexOrdinaryFile(row))
            if row.id == mdbn_wire::common::B16([1; 16])
                && row.path == "views/default.base"
                && row.doc == mdbn_wire::common::Text::Inline("views: []\r\n".into())
    ));
}
