//! Native R2 GET seam: worker 0.8.7's Object.range getter panics on the native
//! plain range object. Use the real binding/receiver directly, preserving the
//! native stream and validating returned range metadata without that cast.
use js_sys::{Function, Object, Promise, Reflect};
use mdbn_log_service::direct::DownloadSpan;
use wasm_bindgen::{JsCast, JsValue};
use worker::{Bucket, Result};

pub async fn get(bucket: &Bucket, key: &str, span: DownloadSpan, etag: &str) -> Result<JsValue> {
    let options = Object::new();
    let condition = Object::new();
    Reflect::set(&condition, &"etagMatches".into(), &etag.into())?;
    Reflect::set(&options, &"onlyIf".into(), &condition)?;
    if span.partial() {
        let range = Object::new();
        Reflect::set(&range, &"offset".into(), &(span.offset() as f64).into())?;
        Reflect::set(&range, &"length".into(), &(span.length() as f64).into())?;
        Reflect::set(&options, &"range".into(), &range)?;
    }
    let binding = bucket.as_ref();
    let get = Reflect::get(binding, &"get".into())?.dyn_into::<Function>()?;
    let promise = get
        .call2(binding, &key.into(), &options)?
        .dyn_into::<Promise>()?;
    Ok(js_sys::futures::JsFuture::from(promise).await?)
}

pub fn field(object: &JsValue, name: &str) -> Result<JsValue> {
    Ok(Reflect::get(object, &name.into())?)
}

pub async fn cancel(object: &JsValue) -> Result<()> {
    let body = field(object, "body")?;
    if body.is_null() || body.is_undefined() {
        return Ok(());
    }
    let cancel = field(&body, "cancel")?.dyn_into::<Function>()?;
    let promise = cancel.call0(&body)?.dyn_into::<Promise>()?;
    js_sys::futures::JsFuture::from(promise).await?;
    Ok(())
}
