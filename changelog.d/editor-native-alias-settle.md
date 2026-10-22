## Fixed

- Native Editor publication now re-verifies the custom domain for up to five minutes after the immutable deployment passes, so a Pages alias that briefly keeps serving the previous deployment no longer fails an otherwise good publish. Failures on the immutable deployment remain terminal.
