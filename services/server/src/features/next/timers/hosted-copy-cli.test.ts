import { expect, it, vi } from "vitest";

it("copy-hosted refuses the old lossy importer before database or credential use", async () => {
  const createDatabase = vi.fn();
  vi.doMock("../../../db.js", () => ({ createDatabase }));
  const argv = process.argv;
  const exitCode = process.exitCode;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.argv = ["node", "next-timers", "copy-hosted", "10000000-0000-4000-8000-000000000001"];
    await import("./cli.js");
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ error: "timer_import_requires_strict_importer" });
    expect(createDatabase).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    error.mockRestore();
    vi.doUnmock("../../../db.js");
  }
});
