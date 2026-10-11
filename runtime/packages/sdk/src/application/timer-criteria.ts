import { MDBASE_TIMER_FIRED_CONTRACT, type ApplicationNotifications } from "@mdbase-dev/connect-protocol";

/** The manifest criteria a fired timer delivers: those on the exact standard
 * timer-fired event. The CP builds the installation timer declaration from the
 * same rule, so these are the criteria a timer consent can cover. */
export function declaredTimerCriteria(declaration: Readonly<ApplicationNotifications> | null | undefined): readonly string[] {
  if (!declaration || !Array.isArray(declaration.criteria)) return Object.freeze([]);
  const ids = declaration.criteria
    .filter(criterion => criterion?.event?.id === MDBASE_TIMER_FIRED_CONTRACT.id
      && criterion.event.version === MDBASE_TIMER_FIRED_CONTRACT.version
      && criterion.event.digest === MDBASE_TIMER_FIRED_CONTRACT.digest)
    .map(criterion => criterion.id);
  return Object.freeze([...new Set(ids)]);
}
