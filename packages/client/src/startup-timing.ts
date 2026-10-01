/** Bounded, browser-local timings. Names contain no collection/grant identifiers. */
export async function timeStartupRead<T>(
  stage: "registration" | "setup-assessment" | "contracts",
  operation: () => Promise<T>,
): Promise<T> {
  const clock = typeof window === "undefined" ? undefined : globalThis.performance;
  const start = clock?.now();
  try { return await operation(); }
  finally {
    if (clock && start !== undefined) {
      try {
        const name = `mdbase:startup:${stage}`;
        clock.clearMeasures(name);
        clock.measure(name, { start, end: clock.now() });
      } catch {
        // Optional diagnostics must never replace an authoritative read outcome.
      }
    }
  }
}
