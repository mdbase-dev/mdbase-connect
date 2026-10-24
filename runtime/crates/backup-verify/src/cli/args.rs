//! Pure CLI option admission. No input file is opened here.
use crate::Refusal;
use std::ffi::OsString;
use std::path::PathBuf;

pub(super) struct Arguments {
    pub(super) cut_dir: PathBuf,
    pub(super) completion: PathBuf,
    pub(super) trust: PathBuf,
}

pub(super) fn parse(mut args: impl Iterator<Item = OsString>) -> Result<Arguments, Refusal> {
    let mut cut_dir = None;
    let mut completion = None;
    let mut trust = None;
    while let Some(flag) = args.next() {
        let target = match flag.to_str() {
            Some("--cut-dir") => &mut cut_dir,
            Some("--completion") => &mut completion,
            Some("--trust") => &mut trust,
            _ => return Err(Refusal::Invocation),
        };
        if target.is_some() {
            return Err(Refusal::Invocation);
        }
        let value = args.next().ok_or(Refusal::Invocation)?;
        if value.is_empty() || value.to_str().is_some_and(|value| value.starts_with("--")) {
            return Err(Refusal::Invocation);
        }
        *target = Some(PathBuf::from(value));
    }
    Ok(Arguments {
        cut_dir: cut_dir.ok_or(Refusal::Invocation)?,
        completion: completion.ok_or(Refusal::Invocation)?,
        trust: trust.ok_or(Refusal::Invocation)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Result<Arguments, Refusal> {
        parse(values.iter().map(OsString::from))
    }
    #[test]
    fn required_flags_accept_any_order_without_reading_paths() {
        let paths = args(&[
            "--trust",
            "not-opened-trust",
            "--cut-dir",
            "not-opened-cut",
            "--completion",
            "not-opened-completion",
        ])
        .unwrap();
        assert_eq!(paths.cut_dir, PathBuf::from("not-opened-cut"));
        assert_eq!(paths.completion, PathBuf::from("not-opened-completion"));
        assert_eq!(paths.trust, PathBuf::from("not-opened-trust"));
    }
    #[test]
    fn missing_duplicate_unknown_malformed_options_refuse_content_free() {
        for values in [
            vec![],
            vec!["--cut-dir"],
            vec!["--help"],
            vec!["--cut-dir=cut"],
            vec!["--cut-dir", ""],
            vec!["--cut-dir", "--trust"],
            vec![
                "--trust",
                "private-input",
                "--trust",
                "second-private-input",
            ],
            vec![
                "--cut-dir",
                "cut",
                "--trust",
                "trust",
                "--completion",
                "completion",
                "extra",
            ],
        ] {
            let error = match args(&values) {
                Err(error) => error,
                Ok(_) => panic!("unexpected admission"),
            };
            assert_eq!(error, Refusal::Invocation);
            assert_eq!(
                error.json_line(),
                "{\"verified\":false,\"code\":\"invocation\"}\n"
            );
        }
    }
    #[test]
    fn duplicate_refuses_before_consuming_its_value_or_later_options() {
        let mut args = ["--trust", "private-input", "--trust"]
            .into_iter()
            .map(OsString::from)
            .chain(std::iter::from_fn(|| {
                panic!("must refuse without later argument admission")
            }));
        assert!(matches!(parse(&mut args), Err(Refusal::Invocation)));
    }
}
