import { t, msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "@mdbase-dev/ui/i18n";
import {
  compareVersions,
  decideUpdate,
  type UpdateChannel,
  type UpdateManifest,
  type UpdateTarget
} from "./update-policy";
import { UpdateStateStore } from "./update-state";

/**
 * Updating the app through its existing release channel: the signed GitHub release
 * manifest (sigstore provenance), staged by Squirrel.Mac on macOS, opened in the
 * Microsoft Store or the package download elsewhere.
 *
 * The app update is also the daemon update: the new app bundles its mdbase daemon and
 * installs it at the next launch (`next-daemon.ts`). Nothing here starts, stops or
 * rolls back a daemon, and an app update never waits for one.
 */

export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "deferred"
  | "downloading"
  | "ready"
  | "external"
  | "installing"
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
  /** This version is no longer supported: the update must be installed. */
  required?: true;
  /** The bundled daemon was rolled back to the previous version; why. */
  daemon_notice?: string;
}

export interface UpdateBackend {
  currentVersion: string;
  channel: UpdateChannel;
  platformKey: string;
  packaged: boolean;
  findLatest(): Promise<{ manifest: UpdateManifest } | null>;
  stageAutomatic(
    manifest: UpdateManifest,
    target: UpdateTarget,
    onProgress: (progress: number) => void
  ): Promise<void>;
  installAutomatic(): void;
  openExternal(url: string): Promise<void>;
}

const NEWEST = msg({ message: "This is the newest release on the selected channel.", context: "Desktop application" });
type UpdateCopy = string | MessageDescriptor;
type UpdateState = Omit<DesktopUpdateStatus, "message" | "daemon_notice"> & {
  message: UpdateCopy;
  daemon_notice?: UpdateCopy;
};

export class UpdateCoordinator {
  private readonly listeners = new Set<(status: DesktopUpdateStatus) => void>();
  private statusValue: UpdateState;
  private candidate: { manifest: UpdateManifest; target: UpdateTarget } | null = null;
  private operation: Promise<DesktopUpdateStatus> | null = null;
  private daemonNotice: UpdateCopy | null = null;

  constructor(private readonly store: UpdateStateStore, private readonly backend: UpdateBackend) {
    this.statusValue = {
      phase: backend.packaged ? "idle" : "unavailable",
      current_version: backend.currentVersion,
      channel: backend.channel,
      message: backend.packaged
        ? msg({ message: "Updates have not been checked yet.", context: "Desktop application" })
        : msg({ message: "Updates are available in installed builds.", context: "Desktop application" }),
      can_check: backend.packaged,
      can_install: false
    };
  }

  status(): DesktopUpdateStatus {
    const { message, daemon_notice, ...state } = structuredClone(this.statusValue);
    return {
      ...state,
      message: typeof message === "string" ? message : i18n._(message),
      ...(daemon_notice === undefined ? {} : { daemon_notice: typeof daemon_notice === "string" ? daemon_notice : i18n._(daemon_notice) }),
    };
  }

  subscribe(listener: (status: DesktopUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<DesktopUpdateStatus> {
    const persisted = await this.store.load();
    if (persisted.last_checked_at) this.statusValue.checked_at = persisted.last_checked_at;
    return this.status();
  }

  /** Shown with the update status while a rolled-back daemon version is held back. */
  setDaemonNotice(notice: UpdateCopy | null): void {
    this.daemonNotice = notice;
    this.setStatus({ phase: this.statusValue.phase, message: this.statusValue.message });
  }

  check(manual = false): Promise<DesktopUpdateStatus> {
    if (this.operation) return this.operation;
    if (["ready", "installing"].includes(this.statusValue.phase) || !this.statusValue.can_check) {
      return Promise.resolve(this.status());
    }
    this.operation = this.checkExclusive(manual).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  async install(): Promise<DesktopUpdateStatus> {
    if (!this.candidate) throw new Error(t(i18n)({ message: "No update is ready to install.", context: "Desktop application" }));
    if (this.candidate.target.mode !== "automatic") {
      if (this.statusValue.phase !== "external" || !this.statusValue.can_install) {
        throw new Error(t(i18n)({ message: "The external update is not ready to open.", context: "Desktop application" }));
      }
      await this.backend.openExternal(this.candidate.target.action_url);
      return this.status();
    }
    if (this.statusValue.phase !== "ready") throw new Error(t(i18n)({ message: "The update has not finished downloading.", context: "Desktop application" }));
    const target = this.candidate.manifest.version;
    this.setStatus({
      phase: "installing",
      target_version: target,
      message: msg`Installing version ${target}. mdbase keeps syncing while the app restarts.`,
      can_check: false,
      can_install: false
    });
    try {
      this.backend.installAutomatic();
    } catch (error) {
      this.candidate = null;
      this.setStatus({
        phase: "failed",
        target_version: target,
        message: msg`The update was not installed: ${message(error)}`,
        can_check: true,
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
      message: msg({ message: "Checking the signed release channel…", context: "Desktop application" }),
      can_check: false,
      can_install: false
    });
    try {
      const persisted = await this.store.load();
      const release = await this.backend.findLatest();
      const checkedAt = new Date().toISOString();
      await this.store.update((state) => {
        state.last_checked_at = checkedAt;
        if (release) {
          state.highest_trusted_version = maxVersion(state.highest_trusted_version, release.manifest.version);
        }
      });
      this.candidate = null;
      if (!release) {
        this.setStatus({ phase: "idle", checked_at: checkedAt, message: NEWEST, can_check: true, can_install: false });
        return this.status();
      }
      const manifest = release.manifest;
      const found = {
        checked_at: checkedAt,
        target_version: manifest.version,
        release_url: manifest.release_url
      };
      const decision = decideUpdate({
        manifest,
        currentVersion: this.backend.currentVersion,
        channel: this.backend.channel,
        platformKey: this.backend.platformKey,
        installationId: persisted.installation_id,
        highestTrustedVersion: persisted.highest_trusted_version,
        manual
      });
      if (decision.kind === "blocked") {
        this.setStatus({ phase: "failed", ...found, message: decision.reason, can_check: true, can_install: false });
      } else if (decision.kind === "current") {
        this.setStatus({ phase: "idle", checked_at: checkedAt, message: NEWEST, can_check: true, can_install: false });
      } else if (decision.kind === "deferred") {
        this.setStatus({
          phase: "deferred",
          ...found,
          message: msg`Version ${manifest.version} is rolling out to ${decision.percentage}% of installations.`,
          can_check: true,
          can_install: false
        });
      } else if (decision.target.mode === "automatic") {
        const required = decision.required ? { required: true as const } : {};
        const downloading = msg`Downloading verified version ${manifest.version}…`;
        this.setStatus({ phase: "downloading", ...found, progress: 0, message: downloading, can_check: false, can_install: false });
        await this.backend.stageAutomatic(manifest, decision.target, (progress) => {
          this.setStatus({ phase: "downloading", progress, message: downloading, can_check: false, can_install: false });
        });
        this.candidate = { manifest, target: decision.target };
        this.setStatus({
          phase: "ready",
          ...found,
          progress: 100,
          ...required,
          message: decision.required
            ? msg`This version of mdbase is no longer supported. Version ${manifest.version} is verified; install it now.`
            : msg`Version ${manifest.version} is verified and ready to install.`,
          can_check: true,
          can_install: true
        });
      } else {
        this.candidate = { manifest, target: decision.target };
        this.setStatus({
          phase: "external",
          ...found,
          ...(decision.required ? { required: true as const } : {}),
          message: decision.required
            ? decision.target.mode === "store"
              ? msg`This version of mdbase is no longer supported. Version ${manifest.version} is available through the Microsoft Store.`
              : msg`This version of mdbase is no longer supported. Version ${manifest.version} is available through the signed package channel.`
            : decision.target.mode === "store"
              ? msg`Version ${manifest.version} is available through the Microsoft Store.`
              : msg`Version ${manifest.version} is available through the signed package channel.`,
          can_check: true,
          can_install: true
        });
      }
      return this.status();
    } catch (error) {
      this.candidate = null;
      this.setStatus({
        phase: "failed",
        message: msg`Could not verify updates: ${message(error)}`,
        can_check: true,
        can_install: false
      });
      return this.status();
    }
  }

  private setStatus(patch: Partial<UpdateState> & Pick<UpdateState, "phase" | "message">): void {
    const base = patch.phase === this.statusValue.phase
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
    const next: UpdateState = {
      ...base,
      ...patch,
      current_version: this.backend.currentVersion,
      channel: this.backend.channel
    };
    if (this.daemonNotice) next.daemon_notice = this.daemonNotice;
    else delete next.daemon_notice;
    this.statusValue = next;
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
