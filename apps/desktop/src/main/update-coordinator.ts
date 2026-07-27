import { randomUUID } from "node:crypto";
import {
  compareVersions,
  decideUpdate,
  type UpdateChannel,
  type UpdateManifest,
  type UpdateTarget
} from "./update-policy";
import { UpdateStateStore, type UpdateTransaction } from "./update-state";

export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "deferred"
  | "downloading"
  | "ready"
  | "external"
  | "installing"
  | "recovery"
  | "failed";

export interface DesktopUpdateStatus {
  phase: UpdatePhase;
  current_version: string;
  channel: UpdateChannel;
  target_version?: string;
  checked_at?: string;
  progress?: number;
  message: string;
  release_url?: string;
  can_check: boolean;
  can_install: boolean;
}

export interface PreparedDaemonHandoff {
  serviceInstalled: boolean;
  previousRuntime: string | null;
}

export interface RecoveryResult {
  healthy: boolean;
  rolledBack: boolean;
  message: string;
}

export interface UpdateBackend {
  currentVersion: string;
  channel: UpdateChannel;
  platformKey: string;
  packaged: boolean;
  reconcileInstalledRuntime(): Promise<string | null>;
  findLatest(): Promise<{ manifest: UpdateManifest } | null>;
  stageAutomatic(
    manifest: UpdateManifest,
    target: UpdateTarget,
    onProgress: (progress: number) => void
  ): Promise<void>;
  prepareDaemonHandoff(previousVersion: string): Promise<PreparedDaemonHandoff>;
  stopDaemon(): Promise<void>;
  installAutomatic(): void;
  openExternal(url: string): Promise<void>;
  recover(transaction: UpdateTransaction): Promise<RecoveryResult>;
}

export class UpdateCoordinator {
  private readonly store: UpdateStateStore;
  private readonly backend: UpdateBackend;
  private readonly listeners = new Set<(status: DesktopUpdateStatus) => void>();
  private statusValue: DesktopUpdateStatus;
  private candidate: { manifest: UpdateManifest; target: UpdateTarget } | null = null;
  private operation: Promise<DesktopUpdateStatus> | null = null;

  constructor(store: UpdateStateStore, backend: UpdateBackend) {
    this.store = store;
    this.backend = backend;
    this.statusValue = {
      phase: backend.packaged ? "idle" : "unavailable",
      current_version: backend.currentVersion,
      channel: backend.channel,
      message: backend.packaged
        ? "Updates have not been checked yet."
        : "Updates are available in installed builds.",
      can_check: backend.packaged,
      can_install: false
    };
  }

  status(): DesktopUpdateStatus {
    return structuredClone(this.statusValue);
  }

  subscribe(listener: (status: DesktopUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<DesktopUpdateStatus> {
    const persisted = await this.store.load();
    if (persisted.last_checked_at) {
      this.statusValue.checked_at = persisted.last_checked_at;
    }
    if (!persisted.transaction) {
      try {
        const message = await this.backend.reconcileInstalledRuntime();
        if (message) {
          this.setStatus({
            phase: "idle",
            message,
            can_check: this.backend.packaged,
            can_install: false
          });
        }
      } catch (error) {
        this.setStatus({
          phase: "failed",
          message: `Could not reconcile the installed connector runtime: ${message(error)}`,
          can_check: false,
          can_install: false
        });
      }
      return this.status();
    }
    this.setStatus({
      phase: "recovery",
      target_version: persisted.transaction.target_version,
      message: "Finishing the application and connector upgrade.",
      can_check: false,
      can_install: false
    });
    await this.store.update((state) => {
      if (state.transaction) state.transaction.phase = "recovering";
    });
    try {
      const result = await this.backend.recover(persisted.transaction);
      await this.store.update((state) => {
        if (result.healthy && !result.rolledBack) {
          state.highest_trusted_version = maxVersion(
            state.highest_trusted_version,
            persisted.transaction?.target_version
          );
          if (persisted.transaction?.previous_runtime) {
            state.last_known_good_runtime = {
              version: persisted.transaction.previous_version,
              path: persisted.transaction.previous_runtime
            };
          }
        }
        delete state.transaction;
      });
      this.setStatus({
        phase: result.healthy && !result.rolledBack ? "idle" : "recovery",
        message: result.message,
        can_check: this.backend.packaged,
        can_install: false
      });
    } catch (error) {
      await this.store.update((state) => {
        if (state.transaction) state.transaction.error = message(error);
      });
      this.setStatus({
        phase: "failed",
        target_version: persisted.transaction.target_version,
        message: `Update recovery needs attention: ${message(error)}`,
        can_check: false,
        can_install: false
      });
    }
    return this.status();
  }

  check(manual = false): Promise<DesktopUpdateStatus> {
    if (this.operation) return this.operation;
    if (
      ["ready", "installing"].includes(this.statusValue.phase) ||
      !this.statusValue.can_check
    ) {
      return Promise.resolve(this.status());
    }
    this.operation = this.checkExclusive(manual).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  async install(): Promise<DesktopUpdateStatus> {
    if (!this.candidate) throw new Error("No update is ready to install.");
    if (this.candidate.target.mode !== "automatic") {
      if (this.statusValue.phase !== "external" || !this.statusValue.can_install) {
        throw new Error("The external update is not ready to open.");
      }
      await this.backend.openExternal(this.candidate.target.action_url);
      return this.status();
    }
    if (this.statusValue.phase !== "ready") throw new Error("The update has not finished downloading.");
    const persisted = await this.store.load();
    const transaction = persisted.transaction;
    if (
      !transaction ||
      transaction.phase !== "prepared" ||
      transaction.target_version !== this.candidate.manifest.version ||
      transaction.previous_version !== this.backend.currentVersion
    ) {
      throw new Error("The prepared app and daemon update transaction is missing.");
    }
    this.setStatus({
      phase: "installing",
      target_version: transaction.target_version,
      message: "Stopping the connector and installing the update.",
      can_check: false,
      can_install: false
    });
    try {
      await this.backend.stopDaemon();
      await this.store.update((state) => {
        if (state.transaction?.id === transaction.id) state.transaction.phase = "installing";
      });
      this.backend.installAutomatic();
    } catch (error) {
      const recovered = await this.backend.recover(transaction).catch(() => null);
      await this.store.update((state) => {
        delete state.transaction;
      });
      this.candidate = null;
      this.setStatus({
        phase: "failed",
        target_version: transaction.target_version,
        message: recovered?.healthy
          ? `The update was not installed; the connector was restored. ${message(error)}`
          : `The update was not installed and connector recovery failed: ${message(error)}`,
        can_check: this.backend.packaged,
        can_install: false
      });
      throw error;
    }
    return this.status();
  }

  private async checkExclusive(manual: boolean): Promise<DesktopUpdateStatus> {
    if (!this.backend.packaged) return this.status();
    this.setStatus({
      phase: "checking",
      message: "Checking the signed release channel…",
      can_check: false,
      can_install: false
    });
    try {
      const persisted = await this.store.load();
      const release = await this.backend.findLatest();
      const checkedAt = new Date().toISOString();
      if (!release) {
        await this.store.update((state) => {
          state.last_checked_at = checkedAt;
        });
        this.candidate = null;
        this.setStatus({
          phase: "idle",
          checked_at: checkedAt,
          message: "This is the newest release on the selected channel.",
          can_check: true,
          can_install: false
        });
        return this.status();
      }
      const decision = decideUpdate({
        manifest: release.manifest,
        currentVersion: this.backend.currentVersion,
        channel: this.backend.channel,
        platformKey: this.backend.platformKey,
        installationId: persisted.installation_id,
        highestTrustedVersion: persisted.highest_trusted_version,
        manual
      });
      await this.store.update((state) => {
        state.last_checked_at = checkedAt;
        state.highest_trusted_version = maxVersion(
          state.highest_trusted_version,
          release.manifest.version
        );
      });
      if (decision.kind === "blocked") {
        this.candidate = null;
        this.setStatus({
          phase: "failed",
          checked_at: checkedAt,
          target_version: release.manifest.version,
          release_url: release.manifest.release_url,
          message: decision.reason,
          can_check: true,
          can_install: false
        });
      } else if (decision.kind === "current") {
        this.candidate = null;
        this.setStatus({
          phase: "idle",
          checked_at: checkedAt,
          message: "This is the newest release on the selected channel.",
          can_check: true,
          can_install: false
        });
      } else if (decision.kind === "deferred") {
        this.candidate = null;
        this.setStatus({
          phase: "deferred",
          checked_at: checkedAt,
          target_version: release.manifest.version,
          release_url: release.manifest.release_url,
          message: `Version ${release.manifest.version} is rolling out to ${decision.percentage}% of installations.`,
          can_check: true,
          can_install: false
        });
      } else {
        this.candidate = { manifest: release.manifest, target: decision.target };
        if (decision.target.mode === "automatic") {
          this.setStatus({
            phase: "downloading",
            checked_at: checkedAt,
            target_version: release.manifest.version,
            release_url: release.manifest.release_url,
            progress: 0,
            message: `Downloading verified version ${release.manifest.version}…`,
            can_check: false,
            can_install: false
          });
          const handoff = await this.backend.prepareDaemonHandoff(this.backend.currentVersion);
          const transaction: UpdateTransaction = {
            id: randomUUID(),
            phase: "prepared",
            target_version: release.manifest.version,
            previous_version: this.backend.currentVersion,
            service_installed: handoff.serviceInstalled,
            previous_runtime: handoff.previousRuntime,
            started_at: new Date().toISOString()
          };
          await this.store.update((state) => {
            state.transaction = transaction;
          });
          try {
            await this.backend.stageAutomatic(release.manifest, decision.target, (progress) => {
              this.setStatus({
                phase: "downloading",
                progress,
                message: `Downloading verified version ${release.manifest.version}…`,
                can_check: false,
                can_install: false
              });
            });
          } catch (error) {
            await this.store.update((state) => {
              if (state.transaction?.id === transaction.id) delete state.transaction;
            });
            throw error;
          }
          this.setStatus({
            phase: "ready",
            checked_at: checkedAt,
            target_version: release.manifest.version,
            release_url: release.manifest.release_url,
            progress: 100,
            message: `Version ${release.manifest.version} is verified and ready to install.`,
            can_check: true,
            can_install: true
          });
        } else {
          this.setStatus({
            phase: "external",
            checked_at: checkedAt,
            target_version: release.manifest.version,
            release_url: release.manifest.release_url,
            message:
              decision.target.mode === "store"
                ? `Version ${release.manifest.version} is available through the Microsoft Store.`
                : `Version ${release.manifest.version} is available through the signed package channel.`,
            can_check: true,
            can_install: true
          });
        }
      }
      return this.status();
    } catch (error) {
      this.setStatus({
        phase: "failed",
        message: `Could not verify updates: ${message(error)}`,
        can_check: true,
        can_install: false
      });
      return this.status();
    }
  }

  private setStatus(patch: Partial<DesktopUpdateStatus> & Pick<DesktopUpdateStatus, "phase" | "message">): void {
    const base =
      patch.phase === this.statusValue.phase
        ? this.statusValue
        : {
            phase: patch.phase,
            current_version: this.backend.currentVersion,
            channel: this.backend.channel,
            checked_at: this.statusValue.checked_at,
            message: patch.message,
            can_check: false,
            can_install: false
          };
    this.statusValue = {
      ...base,
      ...patch,
      current_version: this.backend.currentVersion,
      channel: this.backend.channel
    };
    for (const listener of this.listeners) listener(this.status());
  }
}

function maxVersion(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return compareVersions(left, right) >= 0 ? left : right;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
