## Changed

- mdbase Editor: typing `(`, `[` or `"` at the caret in a note adds its closing partner after the caret.
  - Typing the closing one steps over it, and Backspace inside an empty pair deletes both.
  - Before a word, or for a `"` that closes a quote, the character types alone.
  - `[[` becomes `[[]]`, and choosing a link suggestion fills it without adding a second `]]`.
  - Apostrophes, backticks and emphasis marks still type alone, so ``` ``` ``` still opens a code fence. With text selected, they all wrap it, as before.
