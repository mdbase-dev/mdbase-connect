import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pairing } from "./authority-workflows";
import { api, ApiError, type DevicePairing } from "./api";

vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), api: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function pairing(account_upgrade: DevicePairing["account_upgrade"] = null): DevicePairing {
  return { connector_name: "Notes", approved_at: null, installation_device: true,
    account_selection_confirmed: false, signed_in_account_email: "person@example.test",
    app_origin: "https://notes.example", account_upgrade, collections: [] };
}

function inspect(value = pairing()) {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ pairing: value });
  render(<Pairing pairingId="request" />);
}

describe("account readiness before app consent", () => {
  it.each([
    ["not_scheduled", "Account upgrade needed", /support@mdbase\.dev/],
    ["scheduled", "Account upgrade scheduled", /upgraded soon/],
    ["in_progress", "Account upgrade in progress", /few minutes/],
  ] as const)("explains %s before offering to use the account", async (upgrade, heading, detail) => {
    inspect(pairing(upgrade));
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use this account" })).not.toBeInTheDocument();
    expect(screen.queryByText(/You'll choose collection access next/)).not.toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });

  it("can recheck an upgrading account without selecting it or issuing a denial", async () => {
    inspect(pairing("in_progress"));
    const checkAgain = await screen.findByRole("button", { name: "Check again" });
    vi.mocked(api).mockResolvedValue({ pairing: pairing() });
    fireEvent.click(checkAgain);
    expect(await screen.findByRole("button", { name: "Use this account" })).toBeEnabled();
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });

  it("names a policy refusal rather than pretending the person cancelled", async () => {
    inspect();
    await screen.findByRole("button", { name: "Use this account" });
    vi.mocked(api).mockImplementation(async path => {
      if (path.endsWith("/select-account")) throw new ApiError(409, "Upgrade needed", "installation_legacy_backend", { upgrade: "not_scheduled" });
      if (path.endsWith("/deny")) return {};
      return { pairing: pairing() };
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this account" }));
    expect(await screen.findByRole("heading", { name: "Account upgrade needed" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign-in cancelled" })).not.toBeInTheDocument();
    expect(screen.getByText(/support@mdbase\.dev/)).toHaveClass("mdbase-connect-lead");
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("/deny"))).toHaveLength(1);
  });

  it("keeps retryable failures actionable without labelling them cancelled", async () => {
    inspect();
    await screen.findByRole("button", { name: "Use this account" });
    vi.mocked(api).mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Use this account" }));
    expect(await screen.findByRole("heading", { name: "Couldn't finish sign-in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Sign-in cancelled" })).not.toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/deny"))).toBe(false);
  });

  it("shows readiness before a file consent too, and still lets the person decline it", async () => {
    inspect({ ...pairing("not_scheduled"), file_access: {
      collection_id: "notes", collection_name: "Notes", actions: ["read"], reason: "Open an attachment", approved_actions: null,
    } });
    expect(await screen.findByRole("heading", { name: "Account upgrade needed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });

  it("reserves the cancelled heading for an explicit Cancel action", async () => {
    vi.spyOn(window, "close").mockImplementation(() => {});
    inspect();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Sign-in cancelled" })).toBeInTheDocument();
  });
});
