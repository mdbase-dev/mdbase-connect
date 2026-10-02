import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { availableAttachmentPath, useAttachmentUpload } from "./AttachmentUpload";
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
