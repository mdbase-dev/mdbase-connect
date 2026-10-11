import { describe, expect, it, vi } from "vitest";
import type { AppWebSignInSnapshot } from "@mdbase-dev/sdk/app-host";
import {
  openSignInPortal,
  createSignInPortalUi,
  SignInTabBlocked,
  signInCopy,
  signInPresentation,
  unavailableCollection,
} from "./native-signin-ui";

function snapshot(
  patch: Partial<AppWebSignInSnapshot> = {},
): AppWebSignInSnapshot {
  return {
    status: "signed_out",
    signIn: null,
    collections: [],
    selectedCollectionId: null,
    problem: null,
    timing: null,
    ...patch,
  };
}
const paired: NonNullable<AppWebSignInSnapshot["signIn"]> = {
  requestId: "request",
  installationId: "installation",
  deviceId: "device",
  appId: "app",
  kind: "app-runtime",
  verificationUri: "https://mdbase.test/approve",
  state: "paired",
  accountId: "account",
  accountEmail: "writer@example.test",
  collectionIds: [],
  createCollections: false,
  requestedCreateCollections: false,
};

describe("native sign-in presentation, not an authentication engine", () => {
  it("uses canonical signed-out wording", () => {
    expect(signInPresentation(snapshot(), "TaskNotes Planner").message).toBe(
      "Sign in with your mdbase account to sync TaskNotes Planner across your devices.",
    );
  });
  it("renders SDK authorizing without introducing an app poller", () => {
    const view = signInPresentation(
      snapshot({ status: "authorizing" }),
      "Planner",
    );
    expect(view.message).toBe("Waiting for approval in the mdbase tab…");
    expect(view.waiting).toBe(true);
  });
  it("shows email only from a paired SDK view", () => {
    expect(
      signInPresentation(
        snapshot({ status: "unselected", signIn: paired }),
        "Planner",
      ).message,
    ).toBe("Signed in as writer@example.test");
    expect(
      signInPresentation(
        snapshot({
          status: "authorizing",
          signIn: { ...paired, state: "account_selected" },
        }),
        "Planner",
      ).identity,
    ).toBeNull();
  });
  it("does not invent an email or use account IDs as labels", () => {
    const view = signInPresentation(
      snapshot({
        status: "unselected",
        signIn: { ...paired, accountEmail: null },
      }),
      "Planner",
    );
    expect(view.identity).toBeNull();
    expect(view.message).toBe(signInCopy.unavailable);
    expect(view.message).not.toContain(paired.accountId);
  });
  it("uses actual selected collection metadata for opening", () => {
    const view = signInPresentation(
      snapshot({
        status: "opening",
        signIn: paired,
        selectedCollectionId: "selected",
        collections: [
          { collectionId: "selected", displayName: "Research", role: "owner" },
        ],
      }),
      "Planner",
    );
    expect(view.message).toBe("Signed in. Opening Research…");
  });
  it("refuses to invent a collection name from an identifier", () => {
    const view = signInPresentation(
      snapshot({ status: "opening", selectedCollectionId: "private-id" }),
      "Planner",
    );
    expect(view.message).not.toContain("private-id");
  });
  it("does not mistake a generic refusal for the user declining", () => {
    expect(
      signInPresentation(
        snapshot({ status: "blocked", problem: "refused" }),
        "Planner",
      ).message,
    ).toBe(signInCopy.interrupted);
  });
  it("does not imply saved/sync or reminders capability from authorization", () => {
    const view = signInPresentation(
      snapshot({ status: "unselected", signIn: paired }),
      "Planner",
    );
    expect(JSON.stringify(view)).not.toMatch(
      /saved on this device|reminders|Set up|Continue setup/,
    );
    expect(view.unavailable).toBe(true);
  });
  it("clears visible identity after SDK closure", () => {
    const view = signInPresentation(
      snapshot({ status: "closed", signIn: paired }),
      "Planner",
    );
    expect(view.paired).toBe(false);
    expect(view.identity).toBeNull();
  });
  it("has a distinct blocked-tab action without rendering raw errors", () => {
    const view = signInPresentation(snapshot(), "Planner", "tab_blocked");
    expect(view.message).toBe("Your browser blocked the sign-in tab.");
    expect(view.action).toBe("Open sign-in");
  });
  it("opens the production popup synchronously, keeps its opener and navigates the original handle", () => {
    const opener = {};
    const popup = {
      opener,
      closed: false,
      location: { href: "" },
      close: vi.fn(),
    };
    vi.stubGlobal("window", { open: vi.fn(() => popup) });
    try {
      const portal = openSignInPortal("planner-owned");
      expect(window.open).toHaveBeenCalledWith(
        "",
        "planner-owned",
        "popup,width=620,height=760",
      );
      expect(popup.opener).toBe(opener);
      portal.navigate("https://mdbase.test/approve");
      expect(popup.location.href).toBe("https://mdbase.test/approve");
      portal.close();
      portal.close();
      expect(popup.close).toHaveBeenCalledOnce();
      expect(() => portal.navigate("https://mdbase.test/late")).toThrow(
        "Sign-in window closed.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("falls back to a tab with noopener semantics when popup opening fails", () => {
    const tab = {
      opener: {},
      closed: false,
      location: { href: "" },
      close: vi.fn(),
    };
    vi.stubGlobal("window", {
      open: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("popup blocked");
        })
        .mockReturnValue(tab),
    });
    try {
      const portal = openSignInPortal();
      expect(window.open).toHaveBeenLastCalledWith("", "_blank");
      expect(tab.opener).toBeNull();
      portal.navigate("https://mdbase.test/approve");
      expect(tab.location.href).toBe("https://mdbase.test/approve");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("retains ownership after SDK handoff, reuses reopen and disposes only its original handle", () => {
    const popup = { closed: false, location: { href: "" }, close: vi.fn() };
    vi.stubGlobal("window", { open: vi.fn(() => popup) });
    try {
      const ui = createSignInPortalUi();
      ui.reserve();
      const original = ui.open();
      ui.reserve();
      expect(ui.open()).toBe(original);
      expect(window.open).toHaveBeenCalledOnce();
      ui.cancel();
      ui.cancel();
      expect(popup.close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reopens a manually closed popup and isolates different UI owners' names", () => {
    const first = { closed: false, location: { href: "" }, close: vi.fn() };
    const second = { closed: false, location: { href: "" }, close: vi.fn() };
    const open = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    vi.stubGlobal("window", { open });
    try {
      const ui = createSignInPortalUi();
      ui.reserve();
      const original = ui.open();
      first.closed = true;
      ui.reserve();
      expect(ui.open()).not.toBe(original);
      const other = createSignInPortalUi();
      other.reserve();
      expect(open.mock.calls[0]?.[1]).toBe(open.mock.calls[1]?.[1]);
      expect(open.mock.calls[2]?.[1]).not.toBe(open.mock.calls[0]?.[1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("distinguishes an actually blocked tab", () => {
    vi.stubGlobal("window", { open: () => null });
    try {
      expect(openSignInPortal).toThrow(SignInTabBlocked);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("the unavailable collection callback never manufactures a connection", async () => {
    // Only signal is observed; fake host/scope/collection data is not consumed.
    await expect(
      unavailableCollection({
        signal: new AbortController().signal,
      } as Parameters<typeof unavailableCollection>[0]),
    ).rejects.toThrow(signInCopy.unavailable);
  });
  it("preserves original cancellation before the unavailable boundary", async () => {
    const controller = new AbortController();
    const reason = new Error("original cancelled");
    controller.abort(reason);
    await expect(
      unavailableCollection({ signal: controller.signal } as Parameters<
        typeof unavailableCollection
      >[0]),
    ).rejects.toBe(reason);
  });
});
