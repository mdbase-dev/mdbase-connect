// Playwright serializes this self-contained function into the proven-owned
// renderer. Keep scheduling time live; only no-argument Date construction is
// frozen. Native now()/today() probes still gate every observation.
export function installOwnedClock(instant) {
  if (!Number.isSafeInteger(instant)) throw new Error("invalid owned clock");
  const RealDate = window.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [instant]));
    }
    static now() {
      return RealDate.now();
    }
  }
  window.Date = FrozenDate;
}
