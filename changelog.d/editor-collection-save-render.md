## Changed

- A save in the Editor rebuilds the whole-collection lists once, not twice: when the watch rereads a note this Editor just saved, the note list keeps the summary it already shows. Typing in a large collection no longer rebuilds a date formatter for every visible row or scans every note on each render. At 10,000 notes and four times CPU slowdown, a save blocks for 374 ms instead of 755 ms, and typing goes from 48 ms to 32 ms per key with no long tasks.
