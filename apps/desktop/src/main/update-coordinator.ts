import { t, msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "@mdbase-dev/ui/i18n";
import { isUpdateServiceUnavailable, UpdateServiceUnavailable } from "./update-service-error";
import {
  compareVersions,
  decideUpdate,
  type RolloutDocument,
  type UpdateChannel,
  type UpdateDecision,
  type UpdateManifest,
  type UpdateTarget
} from "./update-policy";
import { UpdateStateStore, type PersistedUpdateState } from "./update-state";

/**
 * Updating the app through its existing release channel: the signed GitHub release
 * manifest (sigstore provenance), staged by Squirrel.Mac on macOS or into a Linux
 * app folder the user owns, opened in the Microsoft Store or the package download
 * elsewhere.
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
  /** The user opted in to taking each release at its first rollout stage. */
  early_access: boolean;
}

export interface UpdateBackend {
  currentVersion: string;
  channel: UpdateChannel;
  platformKey: string;
  packaged: boolean;
  findLatest(signal: AbortSignal): Promise<{ manifest: UpdateManifest } | null>;
  /**
   * Every verified release, newest first. When present it replaces `findLatest`,
   * so an older release still rolling out to this installation can be taken
   * while the newest is not yet.
   */
  findReleases?(signal: AbortSignal): AsyncIterable<{ manifest: UpdateManifest }>;
  /** The release's verified rollout document, or null when it has none. */
  fetchRollout?(manifest: UpdateManifest, signal: AbortSignal): Promise<RolloutDocument | null>;
  /** Whether this installation downloads and installs the target itself. */
  installsAutomatically(target: UpdateTarget): boolean;
  stageAutomatic(
    manifest: UpdateManifest,
    target: UpdateTarget,
    onProgress: (progress: number) => void,
    signal: AbortSignal
  ): Promise<void>;
  installAutomatic(): Promise<void>;
  openExternal(url: string): Promise<void>;
}

const NEWEST = msg({ message: "This is the newest release on the selected channel.", context: "Desktop application" });
// Releases rolling out in stages can leave the newest few unavailable to this
// installation; older ones are considered down to this many. Desktop releases
// as changes merge, so several can be rolling out at once. Matches the release
// coordinator's wideningLimit.
const MAX_RELEASES_CONSIDERED = 16;
const CHECK_TIMEOUT_MS = 60_000;
// Finding and verifying a release is bounded tightly; downloading and staging a
// full release on a slow link legitimately takes longer, so it gets its own deadline.
const STAGE_TIMEOUT_MS = 15 * 60_000;
type UpdateCopy = string | MessageDescriptor;
type UpdateState = Omit<DesktopUpdateStatus, "message" | "daemon_notice" | "early_access"> & {
  message: UpdateCopy;
  daemon_notice?: UpdateCopy;
};

export class UpdateCoordinator {
  private readonly listeners = new Set<(status: DesktopUpdateStatus) => void>();
  private statusValue: UpdateState;
  private candidate: { manifest: UpdateManifest; target: UpdateTarget } | null = null;
  private operation: Promise<DesktopUpdateStatus> | null = null;
  private daemonNotice: UpdateCopy | null = null;
  private earlyAccess = false;

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
      early_access: this.earlyAccess,
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
    this.earlyAccess = persisted.early_access === true;
    return this.status();
  }

  /**
   * Early access: take each release as soon as it starts rolling out, and every
   * release rather than at most one optional update a day. Turning it off never
   * downgrades; the installation waits for the general rollout to pass it.
   */
  async setEarlyAccess(enabled: boolean): Promise<DesktopUpdateStatus> {
    await this.store.update((state) => {
      if (enabled) state.early_access = true;
      else delete state.early_access;
    });
    this.earlyAccess = enabled;
    this.setStatus({ phase: this.statusValue.phase, message: this.statusValue.message });
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
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = (ms: number, reason: Error) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(reason), ms);
    };
    deadline(CHECK_TIMEOUT_MS, new UpdateServiceUnavailable("Update check timed out after 60 seconds."));
    this.operation = this.checkExclusive(manual, controller.signal, deadline).finally(() => {
      clearTimeout(timeout);
      this.operation = null;
    });
    return this.operation;
  }

  async install(): Promise<DesktopUpdateStatus> {
    if (!this.candidate) throw new Error(t(i18n)({ message: "No update is ready to install.", context: "Desktop application" }));
    if (!this.backend.installsAutomatically(this.candidate.target)) {
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
      await this.backend.installAutomatic();
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

  private async checkExclusive(
    manual: boolean,
    signal: AbortSignal,
    deadline: (ms: number, reason: Error) => void
  ): Promise<DesktopUpdateStatus> {
    if (!this.backend.packaged) return this.status();
    this.setStatus({
      phase: "checking",
      message: msg({ message: "Checking the signed release channel…", context: "Desktop application" }),
      can_check: false,
      can_install: false
    });
    try {
      const now = Date.now();
      const loaded = await this.duringCheck(this.store.load(), signal);
      const persisted = { ...loaded, current_version: runningVersion(loaded.current_version, this.backend.currentVersion, now) };
      this.earlyAccess = persisted.early_access === true;
      const found = await this.duringCheck(this.chooseRelease(persisted, manual, now, signal), signal);
      const checkedAt = new Date().toISOString();
      await this.duringCheck(this.store.update((state) => {
        signal.throwIfAborted();
        state.last_checked_at = checkedAt;
        state.current_version = runningVersion(state.current_version, this.backend.currentVersion, now);
        if (found) {
          state.highest_trusted_version = maxVersion(state.highest_trusted_version, found.newest.version);
          for (const [tag, issuedAt] of Object.entries(found.rolloutSeen)) {
            const previous = state.rollout_seen?.[tag];
            if (!previous || Date.parse(issuedAt) > Date.parse(previous)) {
              state.rollout_seen = { ...state.rollout_seen, [tag]: issuedAt };
            }
          }
        }
      }), signal);
      this.candidate = null;
      if (!found) {
        this.setStatus({ phase: "idle", checked_at: checkedAt, message: NEWEST, can_check: true, can_install: false });
        return this.status();
      }
      const { manifest, decision } = found;
      const shown = {
        checked_at: checkedAt,
        target_version: manifest.version,
        release_url: manifest.release_url
      };
      if (decision.kind === "blocked") {
        this.setStatus({ phase: "failed", ...shown, message: decision.reason, can_check: true, can_install: false });
      } else if (decision.kind === "current") {
        this.setStatus({ phase: "idle", checked_at: checkedAt, message: NEWEST, can_check: true, can_install: false });
      } else if (decision.kind === "deferred") {
        this.setStatus({
          phase: "deferred",
          ...shown,
          message: deferredCopy(manifest.version, decision),
          can_check: true,
          can_install: false
        });
      } else if (this.backend.installsAutomatically(decision.target)) {
        const required = decision.required ? { required: true as const } : {};
        const downloading = msg`Downloading verified version ${manifest.version}…`;
        this.setStatus({ phase: "downloading", ...shown, progress: 0, message: downloading, can_check: false, can_install: false });
        signal.throwIfAborted();
        deadline(STAGE_TIMEOUT_MS, new Error("Update download timed out after 15 minutes."));
        await this.duringCheck(this.backend.stageAutomatic(manifest, decision.target, (progress) => {
          if (signal.aborted) return;
          this.setStatus({ phase: "downloading", progress, message: downloading, can_check: false, can_install: false });
        }, signal), signal);
        this.candidate = { manifest, target: decision.target };
        this.setStatus({
          phase: "ready",
          ...shown,
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
          ...shown,
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
        message: isUpdateServiceUnavailable(error)
          ? msg`Could not reach the update service. Check your connection and try again.`
          : msg`Could not verify updates: ${message(error)}`,
        can_check: true,
        can_install: false
      });
      return this.status();
    }
  }

  /**
   * The release to act on: the newest one this installation may take now, or,
   * when it may take none, the newest one with why not. A newer release that is
   * still held back for this installation does not hide an older one that has
   * reached it. Versions withdrawn by the newest release are never taken.
   */
  private async chooseRelease(
    persisted: PersistedUpdateState,
    manual: boolean,
    now: number,
    signal: AbortSignal
  ): Promise<{
    manifest: UpdateManifest;
    decision: UpdateDecision;
    newest: UpdateManifest;
    rolloutSeen: Record<string, string>;
  } | null> {
    const releases = this.backend.findReleases
      ? this.backend.findReleases(signal)
      : latestOnly(this.backend.findLatest(signal));
    const rolloutSeen: Record<string, string> = {};
    let newest: UpdateManifest | null = null;
    let first: { manifest: UpdateManifest; decision: UpdateDecision } | null = null;
    let considered = 0;
    for await (const { manifest } of releases) {
      signal.throwIfAborted();
      newest ??= manifest;
      const rollout = await this.rolloutFor(manifest, persisted, signal);
      if (rollout && rollout !== "unavailable") rolloutSeen[manifest.tag] = rollout.issued_at;
      const decision = decideUpdate({
        manifest,
        currentVersion: this.backend.currentVersion,
        channel: this.backend.channel,
        platformKey: this.backend.platformKey,
        installationId: persisted.installation_id,
        highestTrustedVersion: persisted.highest_trusted_version,
        manual,
        rollout,
        earlyAccess: persisted.early_access === true,
        currentVersionSince: persisted.current_version?.since,
        withdrawn: newest.blocked_versions,
        now
      });
      first ??= { manifest, decision };
      if (decision.kind === "available") return { manifest, decision, newest, rolloutSeen };
      considered += 1;
      // Only a release that has not reached this installation yet sends the search
      // further back; spacing applies to every release alike.
      if (
        decision.kind !== "deferred" ||
        decision.reason === "spacing" ||
        considered >= MAX_RELEASES_CONSIDERED
      ) {
        break;
      }
    }
    return first && newest ? { ...first, newest, rolloutSeen } : null;
  }

  private async rolloutFor(
    manifest: UpdateManifest,
    persisted: PersistedUpdateState,
    signal: AbortSignal
  ): Promise<RolloutDocument | null | "unavailable"> {
    if (!this.backend.fetchRollout) return null;
    if (compareVersions(manifest.version, this.backend.currentVersion) <= 0) return null;
    try {
      const rollout = await this.backend.fetchRollout(manifest, signal);
      const seen = rollout && persisted.rollout_seen?.[manifest.tag];
      if (rollout && seen && Date.parse(rollout.issued_at) < Date.parse(seen)) {
        throw new Error("The rollout document is older than one already seen.");
      }
      return rollout;
    } catch (error) {
      signal.throwIfAborted();
      console.warn(`[mdbase-connect] rollout for ${manifest.tag} not verified: ${message(error)}`);
      return "unavailable";
    }
  }

  private async duringCheck<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort: () => void = () => {};
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        })
      ]);
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
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

/**
 * When this installation started running `version`. Spacing counts from the
 * update that installed it. With no earlier record (a new install, or the first
 * check after this field was added) that time is unknown, so it does not delay
 * an update.
 */
function runningVersion(
  recorded: PersistedUpdateState["current_version"],
  version: string,
  now: number
): NonNullable<PersistedUpdateState["current_version"]> {
  if (recorded?.version === version) return recorded;
  return { version, since: new Date(recorded ? now : 0).toISOString() };
}

async function* latestOnly(
  latest: Promise<{ manifest: UpdateManifest } | null>
): AsyncGenerator<{ manifest: UpdateManifest }> {
  const release = await latest;
  if (release) yield release;
}

function deferredCopy(version: string, decision: Extract<UpdateDecision, { kind: "deferred" }>): MessageDescriptor {
  switch (decision.reason) {
    case "rollout": {
      const percentage = decision.percentage;
      return msg`Version ${version} is rolling out to ${percentage}% of installations.`;
    }
    case "early_access":
      return msg`Version ${version} is available to early-access installations first.`;
    case "held":
      return msg`Version ${version} is not rolling out yet.`;
    case "spacing": {
      const after = decision.until ? new Date(decision.until).toLocaleString() : "";
      return msg`Version ${version} is available. mdbase updates at most once a day, so it will update after ${after}.`;
    }
    case "rollout_unavailable":
      return msg`Version ${version} is published, but its rollout could not be verified. mdbase will check again later.`;
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
