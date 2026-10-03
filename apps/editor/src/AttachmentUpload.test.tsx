import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { attachmentUploadFailure, availableAttachmentPath, useAttachmentUpload } from "./AttachmentUpload";
import { MdbaseConnectError } from "@mdbase-dev/connect";
import { connectProblem } from "@mdbase-dev/connect/advanced";
import { CollectionMutationScope } from "./collection-mutation-scope";
import { DemoCollectionGateway } from "./demo-gateway";
import { FileInventoryController } from "./file-inventory-controller";
import { NoteSession, noteRecordAdapter } from "./note-session";

function harness() {
  const gateway = new DemoCollectionGateway(10);
  const inventory = new FileInventoryController(gateway);
  const scope = new CollectionMutationScope();
  scope.changeOwner("demo");
  let active: NoteSession | undefined = new NoteSession({ path: "Notes/note.md", revision: "1", body: "# Note\n\nBody",
    types: [], frontmatter: {}, effectiveFrontmatter: {}, file: { path: "Notes/note.md" } }, () => [], noteRecordAdapter(gateway));
  const setNotice = vi.fn();
  const hook = renderHook(() => useAttachmentUpload({ gateway, inventory, scope,
    activeSession: () => active, setNotice }));
  return { gateway, inventory, scope, setNotice, ...hook, changeNote: () => { active = undefined; } };
}

describe("attachment failure copy and recovery", () => {
  it.each([
    [new Error("The gateway file exceeds this hosted collection’s per-file limit."), "scan.pdf is too large to upload."],
    [new Error("Gateway file exceeds the 25 MB limit."), "scan.pdf is larger than the 25 MB limit."],
    [new Error("File exceeds limit: 26214400 bytes."), "scan.pdf is larger than the 26214400 bytes limit."],
    [new Error("Unsupported media type in gateway validation"), "scan.pdf is a file type that can’t be uploaded."],
    [new MdbaseConnectError(connectProblem("not_authorized", "Relay grant does not authorize add"), { status: 403 }), "You don’t have permission to upload scan.pdf."],
    [new Error("Object upload failed with HTTP 403."), "You don’t have permission to upload scan.pdf."],
    [new Error("Object upload failed with HTTP 415."), "scan.pdf is a file type that can’t be uploaded."],
    [new Error("Object upload failed with HTTP 413."), "scan.pdf is too large to upload."],
    [new Error("The note is no longer editable."), "Couldn’t upload scan.pdf."],
    [new Error("Gateway invariant failed at private/storage/key"), "Couldn’t upload scan.pdf."]
  ])("permanent errors are plain language and never retryable (%s)", (error, message) => {
    expect(attachmentUploadFailure("scan.pdf", error)).toEqual({ message, retryable: false });
    expect(message).not.toMatch(/gateway|relay|private\/storage/iu);
  });

  it.each([
    new TypeError("Failed to fetch"),
    new Error("Network request failed at gateway"),
    new DOMException("Request timed out at gateway", "TimeoutError"),
    new Error("Object upload failed with HTTP 503."),
    new MdbaseConnectError(connectProblem("timeout", "Relay deadline exceeded")),
    new MdbaseConnectError(connectProblem("temporarily_unavailable", "The file transfer could not be completed."), { cause: new TypeError("Failed to fetch") }),
    new MdbaseConnectError(connectProblem("hosted_provider_unavailable", "Provider response failed"), { status: 502 })
  ])("offers Retry for transient errors (%s)", (error) => {
    const failure = attachmentUploadFailure("scan.pdf", error);
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("scan.pdf");
    expect(failure.message).not.toMatch(/gateway|relay|provider|HTTP|deadline/iu);
  });

  it("never retries an ambiguous write even with a 5xx status", () => {
    const error = new MdbaseConnectError(connectProblem("temporarily_unavailable", "Commit interrupted", { operationOutcome: "unknown" }), { status: 503 });
    expect(attachmentUploadFailure("scan.pdf", error)).toEqual({
      message: "Couldn’t confirm whether scan.pdf was uploaded. Check the collection’s files before uploading again.", retryable: false
    });
  });
});

describe("shared attachment pipeline", () => {
  it("uses the existing note-relative Attachments convention, sanitizes names and dedupes normalized paths", () => {
    expect(availableAttachmentPath("Notes/note.md", "Screenshot.png", new Set(["notes/attachments/screenshot.png"])))
      .toBe("Notes/Attachments/Screenshot (2).png");
    expect(availableAttachmentPath("note.md", "../bad<>[name].png", new Set())).toBe("Attachments/-bad-name-.png");
    expect(availableAttachmentPath("note.md", "", new Set())).toBe("Attachments/attachment");
    expect(availableAttachmentPath("note.md", "cafe\u0301.png", new Set(["attachments/café.png"])))
      .toBe("Attachments/café (2).png");
  });

  it("shares path reservations with the menu and publishes every committed file to the inventory", async () => {
    const { result, inventory, gateway } = harness();
    const upload = vi.spyOn(gateway, "uploadFile");
    const screenshot = new File(["pixels"], "Screenshot.png", { type: "image/png" });
    let reference!: string;
    await act(async () => {
      const menu = result.current.attach([screenshot]);
      const paste = result.current.uploadReference(screenshot);
      await menu;
      reference = await paste;
    });
    expect(upload.mock.calls.map(([path]) => path)).toEqual([
      "Notes/Attachments/Screenshot.png", "Notes/Attachments/Screenshot (2).png"
    ]);
    expect(result.current.insertion?.text).toBe("![Screenshot.png](<Notes/Attachments/Screenshot.png>)");
    expect(reference).toBe("![Screenshot (2).png](<Notes/Attachments/Screenshot (2).png>)");
    expect(inventory.getSnapshot().files).toHaveLength(2);
  });

  it("leaves file size/type validation to the gateway, reports errors, and reuses a failed reservation on retry", async () => {
    const { result, gateway, inventory } = harness();
    const upload = vi.spyOn(gateway, "uploadFile");
    upload.mockRejectedValueOnce(new Error("Unsupported media type or file too large."));
    const source = new File(["content"], "paper.pdf", { type: "application/pdf" });
    await act(async () => {
      await expect(result.current.uploadReference(source)).rejects.toThrow("Unsupported media type or file too large.");
      expect(await result.current.uploadReference(source)).toBe("![[Notes/Attachments/paper.pdf]]");
    });
    expect(upload.mock.calls.map(([path]) => path)).toEqual(["Notes/Attachments/paper.pdf", "Notes/Attachments/paper.pdf"]);
    expect(upload.mock.calls[0]?.[1]).toBe(source);
    expect(inventory.getSnapshot().files).toHaveLength(1);
  });

  it("drains a transfer while frozen without publishing it to another collection or blocking the switch", async () => {
    const { result, gateway, scope, inventory } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = gateway.uploadFile.bind(gateway);
    vi.spyOn(gateway, "uploadFile").mockImplementation(async (...args) => { await gate; return original(...args); });
    let upload!: Promise<string>;
    act(() => { upload = result.current.uploadReference(new File(["pixels"], "image.png", { type: "image/png" })); });
    const failure = expect(upload).rejects.toThrow("collection changed");
    scope.freeze();
    await act(async () => { release(); await scope.drain(); await failure; });
    expect(inventory.getSnapshot().files).toEqual([]);
    scope.changeOwner("other");
    act(() => result.current.reset());
    expect(result.current.insertion).toBeUndefined();
  });

  it("uses the same plain-language error copy for menu uploads", async () => {
    const { result, gateway, setNotice } = harness();
    vi.spyOn(gateway, "uploadFile").mockRejectedValue(new Error("The file exceeds this gateway’s per-file limit."));
    await act(async () => result.current.attach([new File(["pdf"], "scan.pdf", { type: "application/pdf" })]));
    expect(setNotice).toHaveBeenLastCalledWith("scan.pdf is too large to upload.");
  });

  it("does not insert into a different note after an in-flight upload", async () => {
    const { result, gateway, changeNote, inventory } = harness();
    const original = gateway.uploadFile.bind(gateway);
    vi.spyOn(gateway, "uploadFile").mockImplementation(async (...args) => { changeNote(); return original(...args); });
    await act(async () => {
      await expect(result.current.uploadReference(new File(["hi"], "document.txt")))
        .rejects.toThrow("The file was uploaded, but the note changed");
    });
    expect(inventory.getSnapshot().files).toHaveLength(1); // a committed attachment survives independently
    expect(result.current.insertion).toBeUndefined();
  });
});
