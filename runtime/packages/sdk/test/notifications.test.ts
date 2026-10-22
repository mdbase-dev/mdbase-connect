import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleMdbaseNotificationClick, handleMdbasePush, parseMdbaseNativeNotification, parseMdbasePush,
  showMdbaseNotification, type MdbaseNotificationClients,
} from "../src/notifications.js";

// The exact bytes Connect's notification service sends today (notifications.ts / fcm.ts).
const signal = "tmr_0123456789abcdefghijABCDEFGHIJ-_";
const webPush = { type: "mdbase.notification", version: 1, signal_id: signal, criterion_id: "task.reminder",
  cursor: signal, presentation: { title: "Task reminder", body: "Open TaskNotes", tag: "task-reminder" } };
const fcmData = { type: "mdbase.notification", version: "1", signal_id: signal, criterion_id: "task.reminder", cursor: signal };
const parsed = { version: 1, signalId: signal, criterionId: "task.reminder", cursor: signal,
  presentation: { title: "Task reminder", body: "Open TaskNotes", tag: "task-reminder" } };

function pushEvent(body: unknown) {
  const waits: Promise<unknown>[] = [];
  return { waits, event: { data: body === null ? null : { text: () => typeof body === "string" ? body : JSON.stringify(body) },
    waitUntil: (p: Promise<unknown>) => { waits.push(p); } } };
}

describe("mdbase push envelope v1", () => {
  it("parses today's Web Push and FCM bytes, ignoring fields v1 may gain", () => {
    expect(parseMdbasePush({ ...webPush, added_later: true })).toEqual(parsed);
    expect(parseMdbasePush(JSON.stringify(webPush))).toEqual(parsed);
    expect(parseMdbaseNativeNotification(fcmData)).toEqual({ ...parsed, presentation: null });
  });

  it("refuses malformed envelopes and reports newer versions as an upgrade", () => {
    for (const bad of [{ ...webPush, presentation: undefined }, { ...webPush, presentation: { title: "" } },
      { ...webPush, criterion_id: "Task Reminder" }, { ...webPush, signal_id: "has space" }, { ...webPush, type: "other" }]) {
      expect(() => parseMdbasePush(bad)).toThrow(expect.objectContaining({ code: "invalid_request", reason: "invalid_push_payload" }));
    }
    expect(() => parseMdbasePush({ ...webPush, version: 2 })).toThrow(expect.objectContaining({ code: "upgrade_required" }));
    expect(() => parseMdbaseNativeNotification({ ...fcmData, version: "2" })).toThrow(expect.objectContaining({ code: "upgrade_required" }));
  });
});

describe("service-worker helpers", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("shows an mdbase push with the prod data shape and leaves other pushes to the app", async () => {
    const registration = { scope: "https://app.example/", showNotification: vi.fn(async () => {}) };
    const other = pushEvent({ kind: "app-own" });
    expect(handleMdbasePush(other.event, { registration })).toBe(false);
    expect(other.waits).toHaveLength(0);

    const mine = pushEvent(webPush);
    expect(handleMdbasePush(mine.event, { registration, icon: "/icon.png" })).toBe(true);
    await Promise.all(mine.waits);
    expect(registration.showNotification).toHaveBeenCalledWith("Task reminder", { body: "Open TaskNotes",
      tag: "task-reminder", icon: "/icon.png", data: { ...fcmData, version: 1 } });

    // A newer envelope still shows its presentation instead of a generic browser notice.
    const newer = pushEvent({ ...webPush, version: 2 });
    expect(handleMdbasePush(newer.event, { registration })).toBe(true);
    await Promise.all(newer.waits);
    expect(registration.showNotification).toHaveBeenLastCalledWith("Task reminder", { body: "Open TaskNotes", tag: "task-reminder" });
  });

  it("keeps malformed v1 and display failures rejected instead of falling back", async () => {
    const registration = { showNotification: vi.fn(async () => {}) };
    const malformed = pushEvent({ ...webPush, signal_id: "has space" });
    expect(handleMdbasePush(malformed.event, { registration })).toBe(true);
    await expect(malformed.waits[0]).rejects.toMatchObject({ reason: "invalid_push_payload" });
    expect(registration.showNotification).not.toHaveBeenCalled();

    const failing = { showNotification: vi.fn(async () => { throw new Error("display failed"); }) };
    const valid = pushEvent(webPush);
    handleMdbasePush(valid.event, { registration: failing });
    await expect(valid.waits[0]).rejects.toThrow("display failed");
    expect(failing.showNotification).toHaveBeenCalledOnce();
  });

  it("only opens click targets on the app's own origin", () => {
    vi.stubGlobal("location", new URL("https://app.example/sw.js"));
    const clients: MdbaseNotificationClients = { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => null) };
    const tap = { notification: { data: fcmData, close: vi.fn() }, waitUntil: () => {} };
    for (const bad of [{ url: "https://evil.example/" }, { url: "//evil.example/" }, { scope: "https://evil.example/" }]) {
      expect(() => handleMdbaseNotificationClick(tap, { clients, ...bad })).toThrow(expect.objectContaining({ reason: "click_target_cross_origin" }));
    }
    vi.unstubAllGlobals();
    expect(() => handleMdbaseNotificationClick(tap, { clients, url: "https://app.example/" })).toThrow(expect.objectContaining({ reason: "click_target_cross_origin" }));
    expect(handleMdbaseNotificationClick(tap, { clients, url: "/today" })).toBe(true);
  });

  it("focuses an open app window on a tap, or opens the app", async () => {
    vi.stubGlobal("location", new URL("https://app.example/sw.js"));
    const registration = { showNotification: vi.fn(async () => {}) };
    await showMdbaseNotification(registration, webPush);
    const data = (registration.showNotification.mock.calls[0] as unknown as [string, { data: unknown }])[1].data;
    const window = { url: "https://app.example/tasks", focus: vi.fn(async () => {}), postMessage: vi.fn() };
    const clients: MdbaseNotificationClients = { matchAll: vi.fn(async () => [window]), openWindow: vi.fn(async () => null) };
    const waits: Promise<unknown>[] = [];
    const close = vi.fn();
    const tap = (d: unknown) => ({ notification: { data: d, close }, waitUntil: (p: Promise<unknown>) => { waits.push(p); } });

    expect(handleMdbaseNotificationClick(tap({ other: true }), { clients })).toBe(false);
    expect(handleMdbaseNotificationClick(tap(data), { clients, scope: "https://app.example/" })).toBe(true);
    await Promise.all(waits);
    expect(close).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalled();
    expect(window.postMessage).toHaveBeenCalledWith({ type: "mdbase.notification.click", notification: { ...parsed, presentation: null } });

    vi.mocked(clients.matchAll).mockResolvedValue([]);
    handleMdbaseNotificationClick(tap(data), { clients, url: "https://app.example/today" });
    await Promise.all(waits);
    expect(clients.openWindow).toHaveBeenCalledWith("https://app.example/today");
  });
});
