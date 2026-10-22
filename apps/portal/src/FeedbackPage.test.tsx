import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackButton, FeedbackProvider, feedbackApplication, useFeedback } from "@mdbase-dev/ui/feedback";
import { FeedbackPage } from "./FeedbackPage";

const application = feedbackApplication("mdbase reader", "library", "abc123", "development");
function FailureControls() {
  const { reportError } = useFeedback();
  return <><button onClick={() => reportError({ code: "save_failed" })}>Fail visibly</button><button onClick={() => reportError({ code: "cancelled" })}>Cancel operation</button></>;
}
function fixture({ endpoint = "https://feedback-api.mdbase.dev/v1/feedback", siteKey = null }: { endpoint?: string | null; siteKey?: string | null } = {}) {
  return render(<FeedbackProvider endpoint={endpoint} application={application} collectionName="Private collection" turnstileSiteKey={siteKey}><FeedbackButton /><FailureControls /></FeedbackProvider>);
}
async function open() {
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  return screen.getByRole("dialog", { name: "Send feedback" });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Reflect.deleteProperty(window, "turnstile"); });

describe("shared feedback", () => {
  it("opens form-first, focuses the description, and sends nothing until explicit submission", async () => {
    fixture();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const dialog = await open();
    const description = within(dialog).getByRole("textbox", { name: /What happened/ });
    expect(description).toHaveFocus();
    expect(dialog.querySelectorAll("details")).toHaveLength(1);
    expect(dialog.querySelector("details")).not.toHaveAttribute("open");
    expect(within(dialog).queryByText("HELP US MAKE IT BETTER")).not.toBeInTheDocument();
    expect(dialog.querySelector(".mdbase-feedback-context")).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Send feedback"]);
    await userEvent.click(within(dialog).getByText("What gets sent"));
    expect(within(dialog).getByRole("checkbox", { name: /Include technical diagnostics/ })).not.toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /Include collection name/ })).not.toBeChecked();
    await userEvent.click(within(dialog).getByText("What gets sent"));
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.type(description, "Something went wrong.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByText("Thanks for the report.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Thanks for the report." })).toHaveFocus();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://feedback-api.mdbase.dev/v1/feedback");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(JSON.parse(String(init?.body))).toEqual({ schema_version: 2, request_id: expect.any(String), application, topic: "problem", message: "Something went wrong." });
  });

  it("keeps drafts and request IDs on failure, while a successful close clears the draft", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("a private infrastructure error"));
    fixture(); const dialog = await open();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /What happened/ }), "Please help.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection");
    expect(screen.queryByText("a private infrastructure error")).not.toBeInTheDocument();
    const requestId = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).request_id;
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await open();
    expect(screen.getByRole("textbox", { name: /What happened/ })).toHaveValue("Please help.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByText("Thanks for the report.")).toBeInTheDocument();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).request_id).toBe(requestId);
    await userEvent.click(screen.getByRole("button", { name: "Back to your work" }));
    await open(); expect(screen.getByRole("textbox", { name: /What happened/ })).toHaveValue("");
  });

  it.each(["Suggest an improvement", "Share something you like"])("supports %s without including problem diagnostics", async (label) => {
    fixture(); await userEvent.click(screen.getByRole("button", { name: "Fail visibly" }));
    const dialog = await open();
    await userEvent.click(within(dialog).getByText("What gets sent"));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Include technical diagnostics/ }));
    await userEvent.click(within(dialog).getByRole("radio", { name: label }));
    await userEvent.type(within(dialog).getAllByRole("textbox")[0], "Thank you.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(sent.topic).toBe(label === "Suggest an improvement" ? "idea" : "appreciation");
    expect(sent.diagnostics).toBeUndefined();
  });

  it("wiggles only for meaningful, rate-limited failures and includes only opted-in bounded diagnostics", async () => {
    fixture();
    await userEvent.click(screen.getByRole("button", { name: "Cancel operation" }));
    expect(document.querySelector(".is-wiggling")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Fail visibly" }));
    const bug = document.querySelector(".is-wiggling"); expect(bug).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Fail visibly" }));
    expect(document.querySelector(".is-wiggling")).toBe(bug);
    expect(fetch).not.toHaveBeenCalled();
    const dialog = await open();
    await userEvent.click(within(dialog).getByText("What gets sent"));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Include technical diagnostics/ }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Include collection name/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /What happened/ }), "Save failed.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(sent.context).toEqual({ collection_name: "Private collection" });
    expect(sent.diagnostics.events).toEqual([{ at: expect.any(String), code: "save_failed" }, { at: expect.any(String), code: "save_failed" }]);
    expect(Object.keys(sent.diagnostics)).toEqual(["schema_version", "browser", "operating_system", "viewport", "events"]);
  });

  it("closes the native dialog before the picker and restores the draft after cancellation", async () => {
    const picker = vi.fn(async () => {
      expect(document.querySelector<HTMLDialogElement>(".mdbase-feedback-dialog")?.open).toBe(false);
      expect(document.querySelector<HTMLElement>(".mdbase-feedback-app")?.inert).toBe(true);
      throw new DOMException("The person cancelled", "NotAllowedError");
    });
    vi.stubGlobal("navigator", { userAgent: "", maxTouchPoints: 0, mediaDevices: { getDisplayMedia: picker } });
    fixture(); const dialog = await open();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /What happened/ }), "Preserve this draft.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach screenshot" }));
    expect(await screen.findByText(/No screenshot taken/)).toBeInTheDocument();
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("textbox", { name: /What happened/ })).toHaveValue("Preserve this draft.");
    expect(document.querySelector<HTMLElement>(".mdbase-feedback-app")?.inert).toBe(false);
    expect(picker).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });

  it("stops media returned after the provider unmounts", async () => {
    let resolve!: (stream: MediaStream) => void;
    const picker = vi.fn(() => new Promise<MediaStream>((done) => { resolve = done; }));
    const stop = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.stubGlobal("navigator", { userAgent: "", mediaDevices: { getDisplayMedia: picker } });
    const view = fixture(); const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach screenshot" }));
    await waitFor(() => expect(picker).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => { resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream); });
    expect(stop).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves screenshots optional in browsers without capture", async () => {
    vi.stubGlobal("navigator", { userAgent: "", mediaDevices: undefined });
    fixture(); const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach screenshot" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can attach an image instead");
    expect(within(dialog).getByLabelText("Choose an image")).toBeInTheDocument();
  });

  it("requires verification and resets consumed tokens on retry", async () => {
    let verify!: (token: string) => void;
    const remove = vi.fn();
    Object.defineProperty(window, "turnstile", { configurable: true, value: { render: vi.fn((_element, options) => { verify = options.callback; return "widget"; }), remove } });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    fixture({ siteKey: "configured-key" }); const dialog = await open();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /What happened/ }), "A problem.");
    const send = within(dialog).getByRole("button", { name: "Send feedback" }); expect(send).toBeDisabled();
    act(() => verify("one-use-token")); expect(send).toBeEnabled();
    await userEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection");
    expect(send).toBeDisabled(); expect(remove).toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).turnstile_token).toBe("one-use-token");
  });

  it("preserves /connect/feedback bookmarks through the same component", async () => {
    render(<FeedbackProvider endpoint="https://feedback-api.mdbase.dev/v1/feedback" application={application}><FeedbackPage onDone={() => {}} /></FeedbackProvider>);
    expect(await screen.findByRole("dialog", { name: "Send feedback" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /What happened/ })).toHaveFocus();
  });

  it("hides entry points when a deployment does not configure feedback", () => {
    fixture({ endpoint: null });
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["http://feedback.example", "ftp://localhost", "https://secret@feedback.example"])("hides invalid feedback destinations: %s", (endpoint) => {
    fixture({ endpoint });
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resets collection-name consent when the collection changes", async () => {
    const shell = (name: string) => <FeedbackProvider endpoint="https://feedback-api.mdbase.dev/v1/feedback" application={application} collectionName={name}><FeedbackButton /></FeedbackProvider>;
    const view = render(shell("First collection")); await open();
    await userEvent.click(screen.getByText("What gets sent"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Include collection name: First collection" }));
    view.rerender(shell("Another collection"));
    expect(screen.getByRole("checkbox", { name: "Include collection name: Another collection" })).not.toBeChecked();
  });

  it("retains drafts when Escape dismisses the form", async () => {
    fixture(); const dialog = await open();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /What happened/ }), { target: { value: "Still here." } });
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(dialog).not.toHaveAttribute("open"); await open();
    expect(screen.getByRole("textbox", { name: /What happened/ })).toHaveValue("Still here.");
  });
});
