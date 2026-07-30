export class SyncError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
