interface BootGateOptions {
  initialize(): Promise<void>;
  start(): Promise<void>;
  blockedReason(): string | null;
}

/** One owner for update recovery, startup and daemon-backed IPC admission. */
export class BootGate {
  private initialization: Promise<void> | undefined;
  private startup: Promise<void> | undefined;
  private installing = false;

  constructor(private readonly options: BootGateOptions) {}

  private initialize(): Promise<void> {
    // A failed boot stays failed until the application restarts. Ordinary IPC
    // must not silently bypass a failed persisted update recovery.
    return this.initialization ??= this.options.initialize();
  }

  private assertAdmission(): void {
    const reason = this.installing
      ? "The application update is in progress."
      : this.options.blockedReason();
    if (reason) throw new Error(reason);
  }

  async ready(): Promise<void> {
    await this.initialize();
    this.assertAdmission();
    this.startup ??= this.options.start().finally(() => { this.startup = undefined; });
    await this.startup;
    this.assertAdmission();
  }

  async request<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready();
    this.assertAdmission();
    return operation();
  }

  async check<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    this.assertAdmission();
    return operation();
  }

  async install<T>(operation: () => Promise<T>): Promise<T> {
    if (this.installing) throw new Error("The application update is in progress.");
    this.installing = true;
    try {
      await this.initialize();
      // Never race the CLI startup already admitted before installation began.
      await this.startup;
      const reason = this.options.blockedReason();
      if (reason) throw new Error(reason);
      return await operation();
    } finally {
      this.installing = false;
    }
  }
}
