## Changed

- Live preview finds code blocks, callouts, footnotes and math once per document change and keeps them in editor state, so moving the caret only re-checks what is revealed. Caret moves in a 1 MB note go from about 29 ms to under 1 ms, and a keystroke in a 136 KB note goes from about 4 ms to 1.5 ms.
