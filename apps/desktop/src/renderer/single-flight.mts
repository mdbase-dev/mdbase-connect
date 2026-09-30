/**
 * Coalesce overlapping refresh requests onto one in-flight operation. The next
 * interval tick will refresh again after settlement, so callers do not need an
 * unbounded queue of stale polling work.
 */
export function singleFlight<Arguments extends unknown[], Result>(
  operation: (...arguments_: Arguments) => Promise<Result>
): (...arguments_: Arguments) => Promise<Result> {
  let active: Promise<Result> | null = null;
  return (...arguments_: Arguments) => {
    if (active) return active;
    let current: Promise<Result>;
    current = Promise.resolve()
      .then(() => operation(...arguments_))
      .finally(() => {
        if (active === current) active = null;
      });
    active = current;
    return current;
  };
}

/**
 * Coalesce each request independently. A slow request keeps its one in-flight
 * operation without holding back the others' next refresh.
 */
export function singleFlightEach<Requests extends Record<string, () => Promise<unknown>>>(
  requests: Requests
): Requests {
  return Object.fromEntries(
    Object.entries(requests).map(([name, request]) => [name, singleFlight(request)])
  ) as Requests;
}
