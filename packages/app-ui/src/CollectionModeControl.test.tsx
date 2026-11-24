// @vitest-environment jsdom
import "../test/dialog.js";
import { mkdir, writeFile } from "node:fs/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "./i18n.js";
import { CollectionModeControl, type CollectionModeStatus } from "./CollectionModeControl.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;

const state = (mode: "private" | "cloud_copy" = "cloud_copy", change: CollectionModeStatus["change"] = null): CollectionModeStatus => ({
  execution_available: true,
  current_mode: mode,
  change
});

async function mount(options: {
  load: () => Promise<unknown>;
  change?: (target: "private" | "cloud_copy", requestId: string) => Promise<unknown>;
  cancel?: (target: "private" | "cloud_copy", requestId: string) => Promise<unknown>;
  abandon?: (requestId: string) => Promise<unknown>;
  native?: boolean;
  id?: string;
  deviceNames?: Readonly<Record<string, string>>;
  initialStatus?: unknown;
  onModeChange?: (mode: "private" | "cloud_copy") => void;
}) {
  const change = options.change ?? vi.fn(async () => ({}));
  host ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(host);
  await act(async () => root!.render(
    <I18nProvider i18n={i18n}>
      <CollectionModeControl
        collectionId={options.id ?? "one"}
        load={options.load}
        change={change}
        cancel={options.cancel}
        abandon={options.abandon}
        native={options.native ?? false}
        deviceNames={options.deviceNames}
        initialStatus={options.initialStatus}
        onModeChange={options.onModeChange}
      />
    </I18nProvider>
  ));
  return change;
}

const click = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  await act(async () => button!.click());
};

afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  host = undefined!;
  sessionStorage.clear();
});

it("hides controls for older/unregistered executors, malformed status and non-owners", async () => {
  for (const load of [
    async () => ({ ...state(), execution_available: false }),
    async () => ({ current_mode: "cloud_copy", change: null }),
    async () => ({ execution_available: true, current_mode: "wrong" }),
    async () => { throw Error("forbidden"); }
  ]) {
    await mount({ load });
    expect(host.textContent).toBe("");
    act(() => root!.unmount());
    root = undefined;
  }
});

it("describes the current mode and warns before confirming in both directions without showing Refresh status", async () => {
  await mount({ load: async () => state("cloud_copy") });
  expect(host.querySelector(".mdbase-collection-mode-current strong")?.textContent).toBe("Cloud copy");
  expect(host.querySelector(".mdbase-collection-mode-current")?.textContent).toContain("mdbase keeps a copy it can read");
  expect(host.querySelector(".mdbase-collection-mode-note")?.textContent).toContain("Switching to Private:");
  expect(host.textContent).toContain("Apps connected to this collection will need to be reconnected afterwards.");
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Make private"]);
  act(() => root!.unmount());
  root = undefined;
  await mount({ load: async () => state("private") });
  expect(host.querySelector(".mdbase-collection-mode-current strong")?.textContent).toBe("Private");
  expect(host.querySelector(".mdbase-collection-mode-current")?.textContent).toContain("Only your devices can read it.");
  expect(host.querySelector(".mdbase-collection-mode-note")?.textContent).toContain("Switching to Cloud copy:");
  expect(host.textContent).toContain("Apps connected to this collection will need to be reconnected afterwards.");
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Turn on Cloud copy"]);
});

it("records portal intent without claiming completion, hides idle note and Refresh status, and does not offer native consent", async () => {
  let value = state();
  const load = vi.fn(async () => value);
  const change = vi.fn(async () => {
    value = state("cloud_copy", { source_mode: "cloud_copy", target_mode: "private", phase: "waiting_for_device" });
    return value;
  });
  await mount({ load, change });
  await click("Make private");
  expect(change).toHaveBeenCalledWith("private", expect.any(String));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Switching to Private — open mdbase connect on one of your computers");
  expect(host.textContent).not.toContain("Apps connected to this collection will need to be reconnected afterwards.");
  expect(host.textContent).not.toContain("Continue on this device");
  expect(host.textContent).not.toContain("Refresh status");
  expect(host.querySelector(".mdbase-collection-mode-current strong")?.textContent).toBe("Cloud copy");
});

it("distinguishes declined confirmation, keyed_owner_required, mode_abandoned, mode_switch_unavailable and unknown errors", async () => {
  // User declined native confirmation dialog -> no error, stays idle.
  const declined = vi.fn(async () => {
    throw new Error("Error invoking remote method 'connect:collections:mode-change': DaemonControlError: not confirmed on this computer's screen");
  });
  await mount({ load: async () => state(), change: declined, native: true });
  await click("Make private");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Make private");

  // keyed_owner_required -> plain explanation, not "interrupted switch".
  const unkeyed = vi.fn(async () => {
    throw Object.assign(new Error("forbidden"), { details: { code: "keyed_owner_required" } });
  });
  await mount({ load: async () => state(), change: unkeyed, native: true, id: "two" });
  await click("Make private");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("holds this collection’s key");
  expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("interrupted switch");

  // mode_abandoned -> explains recovery and refreshes to abandoned state.
  let abandonedStatus = state("private");
  const abandonedErr = vi.fn(async () => {
    abandonedStatus = state("private", { request_id: "r1", source_mode: "cloud_copy", target_mode: "private", phase: "abandoned" });
    throw Object.assign(new Error("conflict"), { details: { code: "mode_abandoned" } });
  });
  await mount({ load: async () => abandonedStatus, change: abandonedErr, id: "three" });
  await click("Turn on Cloud copy");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("stopped switch to Private");
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Revoke the device that started the switch");

  // mode_switch_unavailable -> hides control.
  const unavailable = vi.fn(async () => {
    throw new Error("Error invoking remote method 'connect:collections:mode-change': DaemonControlError: Switching this collection isn't available yet.");
  });
  await mount({ load: async () => state(), change: unavailable, native: true, id: "four" });
  await click("Make private");
  expect(host.textContent).toBe("");

  // Unknown/network error -> keeps "interrupted switch" copy, preserves request ID, and offers Refresh status retry.
  const lost = vi.fn(async () => { throw Error("lost response"); });
  const reload = vi.fn(async () => state());
  await mount({ load: reload, change: lost, id: "five" });
  expect(host.textContent).not.toContain("Refresh status");
  await click("Make private");
  await click("Make private");
  expect(lost.mock.calls[0]).toEqual(lost.mock.calls[1]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("An interrupted switch may already have started.");
  expect(host.textContent).toContain("Refresh status");
  await click("Refresh status");
  expect(reload).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("Refresh status");

  // Status load error with seeded status -> offers Refresh status as retry and clears once load succeeds.
  let failLoad = true;
  const flakyLoad = vi.fn(async () => {
    if (failLoad) throw Error("network down");
    return state("private");
  });
  await mount({ load: flakyLoad, initialStatus: state("cloud_copy"), id: "six" });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("couldn’t confirm progress");
  expect(host.textContent).toContain("Refresh status");
  failLoad = false;
  await click("Refresh status");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("Refresh status");
  expect(host.querySelector(".mdbase-collection-mode-current strong")?.textContent).toBe("Private");
});

it("uses a fresh request on the next direction, not a completed operation", async () => {
  let value = state();
  const change = vi.fn(async (target: "private" | "cloud_copy", _requestId: string) => {
    value = state(target);
    return {};
  });
  await mount({ load: async () => value, change });
  await click("Make private");
  await click("Turn on Cloud copy");
  expect(change.mock.calls[0]?.[1]).not.toEqual(change.mock.calls[1]?.[1]);
});

it("resolves older-device names with short-ID fallback and keeps them visible across polling and remount until next attempt", async () => {
  vi.useFakeTimers();
  const namedId = "11111111-1111-4111-8111-111111111111";
  const unknownId = "22222222-2222-4222-8222-222222222222";
  let value = state("cloud_copy", { request_id: "req-1", source_mode: "cloud_copy", target_mode: "private", phase: "waiting_for_device" });
  const load = vi.fn(async () => value);
  const change = vi.fn(async () => ({ phase: "waiting_for_devices", devices: [namedId, unknownId] }));
  await mount({
    load,
    change,
    native: true,
    deviceNames: { [namedId]: "Work laptop" }
  });
  await click("Continue on this device");
  expect(host.textContent).toContain("Update mdbase on these devices or remove them");
  expect(host.textContent).toContain("Work laptop");
  expect(host.textContent).toContain("Device 22222222");
  expect(host.textContent).not.toContain(namedId);
  expect(host.textContent).not.toContain(unknownId);
  expect(host.textContent).not.toContain("Refresh status");

  // Content-only fixture for batched real-browser light/dark/mobile layout checks.
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/mode-control.html", host.innerHTML);

  // Survives background status poll.
  const callsBeforePoll = load.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(load.mock.calls.length).toBeGreaterThan(callsBeforePoll);
  expect(host.textContent).toContain("Work laptop");
  expect(host.textContent).toContain("Device 22222222");

  // Survives unmount + remount (e.g. closing and reopening panel or page reload).
  act(() => root!.unmount());
  root = undefined;
  const nextAttempt = vi.fn(async () => {
    value = state("cloud_copy", { request_id: "req-1", source_mode: "cloud_copy", target_mode: "private", phase: "waiting_for_token_expiry", retry_at: "2099-01-01T00:00:00Z" });
    return { phase: "waiting_for_token_expiry", retry_at: "2099-01-01T00:00:00Z" };
  });
  await mount({
    load: async () => value,
    change: nextAttempt,
    native: true,
    deviceNames: { [namedId]: "Work laptop" }
  });
  expect(host.textContent).toContain("Work laptop");

  // Cleared on next attempt.
  await click("Continue on this device");
  expect(host.textContent).not.toContain("Work laptop");
  expect(host.querySelector("time")?.dateTime).toBe("2099-01-01T00:00:00Z");
});

it("shows source mode during finishing, hides idle note and buttons on daemon-driven phases, polls, and calls onModeChange on completion", async () => {
  vi.useFakeTimers();
  // Simulate server flipping current_mode to cloud_copy at Private->Cloud /prepare while phase is still finishing.
  let value: CollectionModeStatus = state("cloud_copy", {
    request_id: "req-cloud",
    source_mode: "private",
    target_mode: "cloud_copy",
    phase: "finishing"
  });
  const load = vi.fn(async () => value);
  const onModeChange = vi.fn();
  await mount({ load, native: true, onModeChange });

  expect(host.querySelector(".mdbase-collection-mode-current strong")?.textContent).toBe("Private");
  expect(host.querySelector(".mdbase-collection-mode-current")?.textContent).toContain("Only your devices can read it.");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Switching to Cloud copy — finishing. This usually takes a few seconds.");
  expect(host.textContent).not.toContain("Apps connected to this collection will need to be reconnected afterwards.");
  expect([...host.querySelectorAll("button")]).toEqual([]);
  expect(load).toHaveBeenCalledTimes(1);

  // Advance 3s -> finishing poll triggers and completes.
  value = state("cloud_copy", null);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".mdbase-collection-mode-current strong")?.textContent).toBe("Cloud copy");
  expect(host.textContent).toContain("Apps connected to this collection will need to be reconnected afterwards.");
  expect(onModeChange).toHaveBeenCalledWith("cloud_copy");

  // Once terminal, polling stops.
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(load).toHaveBeenCalledTimes(2);
});

it("shows expected finish countdown as a caption during waiting_for_token_expiry without Continue or Refresh status", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
  const retryAt = "2026-11-24T12:12:00Z";
  const value = state("cloud_copy", {
    request_id: "req-priv",
    source_mode: "cloud_copy",
    target_mode: "private",
    phase: "waiting_for_token_expiry",
    retry_at: retryAt
  });
  const cancel = vi.fn(async () => ({ phase: "cancelled" }));
  await mount({ load: async () => value, native: true, cancel });

  expect(host.querySelector('[role="status"]')?.textContent).toBe("Switching to Private — waiting for older app connections to expire.");
  expect(host.querySelector(".mdbase-collection-mode-note time")?.getAttribute("datetime")).toBe(retryAt);
  expect(host.querySelector("time")?.textContent).toContain("12 minutes");
  expect(host.textContent).not.toContain("Apps connected to this collection will need to be reconnected afterwards.");
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Cancel switch"]);
});

it("offers confirmed Stop this switch during Cloud->Private finishing and displays abandoned state calmly", async () => {
  let value: CollectionModeStatus = state("cloud_copy", {
    request_id: "req-stuck",
    source_mode: "cloud_copy",
    target_mode: "private",
    phase: "finishing"
  });
  const abandon = vi.fn(async () => {
    value = state("private", {
      request_id: "req-stuck",
      source_mode: "cloud_copy",
      target_mode: "private",
      phase: "abandoned"
    });
    return { request_id: "req-stuck", phase: "abandoned" };
  });
  const onModeChange = vi.fn();
  await mount({ load: async () => value, abandon, onModeChange });

  // Open ConfirmDialog via Stop this switch button.
  await click("Stop this switch");
  const dialog = document.querySelector("dialog");
  expect(dialog).toBeTruthy();
  expect(dialog?.textContent).toContain("Stop this switch to Private?");
  expect(dialog?.textContent).toContain("stays Private on its current key");
  expect(dialog?.textContent).toContain("revoke the lost device");

  // Confirm inside dialog.
  const confirmButtons = [...dialog!.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Stop this switch");
  expect(confirmButtons).toHaveLength(1);
  await act(async () => confirmButtons[0]!.click());

  expect(abandon).toHaveBeenCalledWith("req-stuck");
  expect(onModeChange).toHaveBeenCalledWith("private");
  expect(host.querySelector('[role="status"]')?.textContent).toContain("The switch to Private was stopped");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect([...host.querySelectorAll("button")]).toEqual([]);
});

it("cancels pending intent without an optimistic mode change and restores a fresh retry", async () => {
  let value = state("cloud_copy", { request_id: "request", source_mode: "cloud_copy", target_mode: "private", phase: "waiting_for_token_expiry" });
  const cancel = vi.fn(async () => { value = state(); return { phase: "cancelled" }; });
  await mount({ load: async () => value, cancel });
  await click("Cancel switch");
  expect(cancel).toHaveBeenCalledWith("private", "request");
  expect(host.textContent).toContain("Make private");
});

it("ignores a stale response after switching collection", async () => {
  let resolve!: (value: unknown) => void;
  const old = new Promise<unknown>((r) => { resolve = r; });
  await mount({ load: () => old });
  await mount({ load: async () => state("private"), id: "two" });
  await act(async () => resolve(state("cloud_copy")));
  expect(host.textContent).toContain("Turn on Cloud copy");
  expect(host.textContent).not.toContain("Make private");
});
