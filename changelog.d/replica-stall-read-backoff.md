## Fixed

- A replica stalled on an entry it cannot apply (an unknown format, an unpinned policy key, native results this build cannot verify) re-reads it on the same bounded backoff as a missing key, from 1 s up to every 30 s, instead of re-reading and re-applying it without pause.
