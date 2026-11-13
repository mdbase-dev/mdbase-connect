## Fixed

- The source-built SDK and workspace npm publishers now share a `v0.1.0-beta.N` reservation at the same production commit. A coordinator that loses the tag race to the other line, or finds that line's tag already there, publishes from that tag instead of failing with "Reference already exists". A tag at any other commit still refuses.
