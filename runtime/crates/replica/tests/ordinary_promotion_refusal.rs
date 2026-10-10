//! No runtime promotion activation in the pure Core planning slice.
use mdbn_core::{ids::Uuid, plan::Effect};
use mdbn_replica::convert::{self, ConvertError};

#[test]
fn ordinary_promotion_never_degrades_to_a_legacy_record_effect() {
    let effect = Effect::ReindexOrdinaryFile {
        id: Uuid([1; 16]),
        path: "views/default.base".into(),
        doc: "views: []\n".into(),
    };
    assert!(matches!(
        convert::weffect(&effect),
        Err(ConvertError::OrdinaryFilePromotionUnsupported)
    ));
    assert!(matches!(
        convert::wruntime_effect(&effect),
        Err(ConvertError::OrdinaryFilePromotionUnsupported)
    ));
}
