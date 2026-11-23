// @vitest-environment-options {"url":"https://direct.example/"}
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectEditor } from "../direct/DirectEditor";

const { read, save, forget, pair, connect } = vi.hoisted(() => ({
  read: vi.fn(), save: vi.fn(), forget: vi.fn(), pair: vi.fn(), connect: vi.fn(),
}));
vi.mock("@mdbase-dev/sdk-self-hosted/direct", async importOriginal => ({
  ...await importOriginal<typeof import("@mdbase-dev/sdk-self-hosted/direct")>(),
  createDirectGrantStore: () => ({ read, save, forget }), pairDirect: pair, connectDirect: connect,
}));
vi.mock("../direct/RecordWorkspace", () => ({ RecordWorkspace: () => <p>Workspace open</p> }));

const descriptor = "https://192.168.1.40:8443#sha256=" + "a".repeat(64);
const link = (origin: string) => origin + "/#mdbase-pair=" + encodeURIComponent(descriptor);
const saved = { server: descriptor, token: "saved", receipt: "receipt" };
function mount(invitation?: string) {
  render(<DirectEditor allowed={async () => true} signal={new AbortController().signal} invitation={invitation} />);
}
const code = () => screen.findByRole("textbox", { name: /pairing code/i });
async function submit() {
  fireEvent.change(await code(), { target: { value: "01234567" } });
  fireEvent.click(screen.getByRole("button", { name: /pair and open/i }));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("WebTransport", class { createBidirectionalStream() { throw Error("unexpected network access"); } });
  read.mockResolvedValue(undefined);
  pair.mockResolvedValue("new");
  save.mockResolvedValue("new receipt");
  connect.mockResolvedValue({ link: "open", onLink: () => () => {}, close: vi.fn() });
});

describe("direct editor pairing", () => {
  it("shows the pasted invitation's host and waits for consent", async () => {
    mount();
    const address = await screen.findByLabelText(/server address/i);
    expect(address).toHaveFocus();
    fireEvent.change(address, { target: { value: link(location.origin) } });
    expect(screen.queryByDisplayValue(descriptor)).toBeNull();
    expect(screen.getByText("192.168.1.40:8443")).toBeVisible();
    expect(await code()).toHaveFocus();
    expect(await code()).toHaveAttribute("autocomplete", "one-time-code");
    expect(screen.getByLabelText(/remember this browser/i)).not.toBeChecked();
    expect(pair).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    await submit();
    await screen.findByText("Workspace open");
    expect(pair).toHaveBeenCalledExactlyOnceWith({ server: descriptor, code: "01234567", signal: expect.any(AbortSignal) });
    expect(save).not.toHaveBeenCalled();
  });

  it.each([link("https://foreign.example"), "https://connect.mdbase.dev", link(location.origin).replace("/#", "/other#")])(
    "rejects an invalid address locally", async address => {
      mount(descriptor);
      fireEvent.change(await code(), { target: { value: "01234567" } });
      fireEvent.click(screen.getByRole("button", { name: /change server/i }));
      expect(await code()).toHaveValue("");
      fireEvent.change(screen.getByLabelText(/server address/i), { target: { value: address } });
      await submit();
      expect(screen.getByRole("alert")).toHaveTextContent("invitation for this editor");
      expect(pair).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });

  it.each([["unauthenticated", /code was refused/i], ["unavailable", /could not be confirmed/i]])(
    "explains %s, clears the code and keeps Remember", async (reason, message) => {
      pair.mockRejectedValue({ code: reason });
      mount(descriptor);
      fireEvent.click(await screen.findByLabelText(/remember this browser/i));
      await submit();
      await screen.findByText(message);
      expect(await code()).toHaveValue("");
      expect(await code()).toHaveFocus();
      expect(screen.getByLabelText(/remember this browser/i)).toBeChecked();
      expect(forget).not.toHaveBeenCalled();
    });

  it("detects unsupported pinned transport before collecting a code", async () => {
    vi.stubGlobal("WebTransport", undefined);
    mount(descriptor);
    await screen.findByText(/browser cannot connect/i);
    expect(screen.queryByLabelText(/pairing code/i)).toBeNull();
    expect(pair).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("stops asking for codes if the browser ignores certificate pins", async () => {
    pair.mockRejectedValue({ code: "unavailable", reason: "browser_unsupported" });
    mount(descriptor);
    await submit();
    await screen.findByText(/browser cannot connect/i);
    expect(screen.queryByLabelText(/pairing code/i)).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it("reuses a remembered credential only for the exact descriptor", async () => {
    read.mockResolvedValue(saved);
    mount(descriptor);
    await screen.findByText("Workspace open");
    expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ server: descriptor, token: saved.token }));
    expect(pair).not.toHaveBeenCalled();
  });

  it("leaves the live workspace alone when its invitation opens again", async () => {
    read.mockResolvedValue(saved);
    const confirm = vi.spyOn(window, "confirm");
    mount(descriptor);
    await screen.findByText("Workspace open");
    history.replaceState(null, "", link(location.origin));
    fireEvent(window, new Event("hashchange"));
    expect(location.hash).toBe("");
    expect(screen.getByText("Workspace open")).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("retains a valid tab grant when remembering loses a storage race", async () => {
    save.mockRejectedValue(new Error("grant already saved"));
    mount(descriptor);
    fireEvent.click(await screen.findByLabelText(/remember this browser/i));
    await submit();
    await screen.findByText(/paired for this tab only/i);
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
    expect(forget).not.toHaveBeenCalled();
  });

  it("a refused old receipt cannot erase or reconnect to its replacement", async () => {
    read.mockResolvedValueOnce(saved).mockResolvedValue({ ...saved, token: "replacement", receipt: "new" });
    connect.mockRejectedValueOnce({ code: "unauthenticated" });
    mount(descriptor);
    await screen.findByText(/different connection is saved/i);
    expect(forget).toHaveBeenCalledExactlyOnceWith(saved.receipt);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(pair).not.toHaveBeenCalled();
  });

  it("requires another choice if a different pin or a replacement receipt is encountered", async () => {
    read.mockResolvedValueOnce(saved).mockResolvedValue({ ...saved, token: "replacement", receipt: "new" });
    mount(descriptor.replace("sha256=a", "sha256=b"));
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(connect).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await screen.findByText("Workspace open");
    expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ token: "replacement" }));
  });

  it("confirms forget and erases only the selected receipt", async () => {
    read.mockResolvedValueOnce(saved);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount(descriptor.replace("sha256=a", "sha256=b"));
    const button = await screen.findByRole("button", { name: "Forget this browser" });
    fireEvent.click(button);
    expect(forget).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(await code()).toHaveValue("");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(forget).toHaveBeenCalledExactlyOnceWith(saved.receipt);
    expect(connect).not.toHaveBeenCalled();
    expect(pair).not.toHaveBeenCalled();
  });
});
