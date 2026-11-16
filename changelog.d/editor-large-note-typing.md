## Fixed

- Typing in a very large note is faster: the Editor now uses shared UI beta.224, whose live preview keeps its block and math structure between keystrokes, and finds a note's links and embeds again only in the edited block. In a 50,000-word note with the CPU slowed four times, typing latency fell from about 79 to 63 ms at the median.
