/** This installation's original device custody (its key encryption key, device
 * keys or Noise vault in IndexedDB) could not be opened, or did not hold what
 * the installation needs. One typed refusal for all three stores, so the app
 * can describe it instead of a generic open failure. The message is a
 * diagnostic only. */
export class AppDeviceCustodyError extends Error {
  readonly reason = "device_keys_unavailable" as const;
  constructor(message: string) { super(message); this.name = "AppDeviceCustodyError"; }
}
