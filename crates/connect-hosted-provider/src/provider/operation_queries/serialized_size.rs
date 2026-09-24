/// Count exactly the JSON bytes without allocating a temporary encoded document.
/// Serialization errors remain errors; callers must not interpret them as zero bytes.
fn serialized_bytes<T: serde::Serialize + ?Sized>(value: &T) -> Result<u64, serde_json::Error> {
    #[derive(Default)]
    struct Counter(u64);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.checked_add(bytes.len() as u64).ok_or_else(|| {
                std::io::Error::other("serialized JSON length overflow")
            })?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let mut counter = Counter::default();
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

#[cfg(test)]
mod serialized_size_tests {
    use super::*;
    #[test]
    fn counts_exact_utf8_escapes_nested_values_and_large_bodies() {
        for value in [
            json!(null), json!({"quoted\"key": "雪\n\t\\\"\u{0000}", "n": -123.125}),
            json!([true, false, {"a": [1, 2, 3]}]), json!({"body": "α\n".repeat(65536)}),
        ] {
            assert_eq!(serialized_bytes(&value).unwrap(), serde_json::to_vec(&value).unwrap().len() as u64);
        }
    }
    #[test]
    fn propagates_serializer_failures() {
        struct Invalid;
        impl serde::Serialize for Invalid {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("deliberate failure"))
            }
        }
        assert!(serialized_bytes(&Invalid).is_err());
    }
}
