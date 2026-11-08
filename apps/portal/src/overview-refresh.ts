import type { ManagementOverview } from "@mdbase/connect-management";
import { useEffect } from "react";

/** `storageAgeMs`: include storage when the last successful storage read is at least this old. */
type Refresh = (signal?: AbortSignal, animate?: boolean, storageAgeMs?: number) => Promise<void>;

/**
 * Each native storage read wakes every held collection's log, so reads are
 * rationed: at most every 5 minutes in the background, and not again within
 * 30 seconds on focus. A read that omits storage keeps the last figure.
 */
export class NativeStorageReads {
  private readAt = -Infinity;
  private bytes: number | null | undefined;

  due(storageAgeMs = 5 * 60_000): boolean {
    return Date.now() - this.readAt >= storageAgeMs;
  }

  /** Records a successful read's figure (null included), or restores the last one into a read that omitted it. */
  received(overview: ManagementOverview, includedStorage: boolean): void {
    if (includedStorage) {
      this.readAt = Date.now();
      this.bytes = overview.subscription?.native_storage_bytes;
    } else if (overview.subscription) {
      overview.subscription.native_storage_bytes = this.bytes;
    }
  }
}

/** Refreshes on load, every 15 seconds and on focus, visibility or reconnection while visible, and when the account page opens. */
export function useOverviewRefresh(refresh: Refresh, accountOpen: boolean): void {
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal, false, 0);
    const whenVisible = (storageAgeMs?: number) => () => {
      if (document.visibilityState === "visible") void refresh(controller.signal, false, storageAgeMs);
    };
    const refreshWhenVisible = whenVisible();
    const refreshStorageWhenVisible = whenVisible(30_000);
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener("visibilitychange", refreshStorageWhenVisible);
    window.addEventListener("focus", refreshStorageWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", refreshStorageWhenVisible);
      window.removeEventListener("focus", refreshStorageWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (accountOpen) void refresh(undefined, false, 0);
  }, [accountOpen, refresh]);
}
