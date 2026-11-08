import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { Authorization } from "./authorization-view";
import { render, screen } from "./test/render";

vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), api: vi.fn() }));

const requestId = "11111111-1111-4111-8111-111111111111";
const callback = "https://app.example/auth/mdbase/callback?code=code_1&state=state_1";
const replace = vi.fn();
const statusCalls = () => vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("/status")).length;

/** A Private approval completes on the pairing page, so this page first loads a
 * request that is no longer pending: its detail is gone and only status knows. */
function answered(status: { status: "approved" | "denied"; redirect_uri?: string }, order: { detailFirst: boolean }) {
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(api).mockImplementation(async path => {
    if (path.endsWith("/status")) {
      if (order.detailFirst) await first;
      setTimeout(() => release());
      return status;
    }
    if (!order.detailFirst) await first;
    setTimeout(() => release());
    throw new ApiError(404, "Authorization request not found.");
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  replace.mockReset();
  vi.mocked(api).mockReset();
  vi.stubGlobal("location", { ...location, replace });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("expires a pending request locally and a stale pending poll cannot reopen it", async () => {
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  vi.mocked(api).mockImplementation(async path => path.endsWith("/status") ? { status: "pending" } : {
    authorization: { id: requestId, application_name: "Reader", expires_at: "2026-11-07T00:00:02Z", requested_operations: [], requirements: { contracts: [], access: "full_collection" }, provisions: { type_packs: [] } },
    collections: [], unavailable_connectors: []
  });
  render(<Authorization requestId={requestId} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByText("This request has expired or was already answered.")).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(screen.getByText("This request has expired or was already answered.")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(screen.getByText("This request has expired or was already answered.")).toBeInTheDocument();
  expect(screen.queryByText(/expires.*ago/)).not.toBeInTheDocument();
});

for (const detailFirst of [true, false]) it(`hands an already approved request back to the app (detail 404 ${detailFirst ? "first" : "last"})`, async () => {
  answered({ status: "approved", redirect_uri: callback }, { detailFirst });
  render(<Authorization requestId={requestId} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.queryByText("This request has expired or was already answered.")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Access approved" })).toBeInTheDocument();
  expect(screen.getByText(/Returning to/)).toBeInTheDocument();
  expect(screen.queryByText("Your approved collection and permissions will follow you back.")).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(replace).toHaveBeenCalledExactlyOnceWith(callback);
});

it("stops asking for new authorization codes once it holds the return", async () => {
  answered({ status: "approved", redirect_uri: callback }, { detailFirst: false });
  render(<Authorization requestId={requestId} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  const calls = statusCalls();
  await act(() => vi.advanceTimersByTimeAsync(2_500));
  expect(statusCalls()).toBe(calls);
});

it("returns a request denied elsewhere without a countdown", async () => {
  answered({ status: "denied", redirect_uri: callback }, { detailFirst: true });
  render(<Authorization requestId={requestId} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(replace).toHaveBeenCalledExactlyOnceWith(callback);
});

it("keeps an expired request expired", async () => {
  vi.mocked(api).mockRejectedValue(new ApiError(404, "Authorization request expired or was not found."));
  render(<Authorization requestId={requestId} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.getByText("This request has expired or was already answered.")).toBeInTheDocument();
  expect(replace).not.toHaveBeenCalled();
});
