## Changed

- Answer queries the index cannot serve, such as a title search or a list with no limit, by reading each note once. The scan used to read every candidate note a second time to evaluate it and every matching note twice more to return it; in a 1,000-note collection, listing all 292 tasks took 884 database statements and now takes 8. Results, order, limits and refusals are unchanged.
