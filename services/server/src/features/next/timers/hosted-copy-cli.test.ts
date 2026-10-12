import { expect, it, vi } from "vitest";

it("copy-hosted refuses before database use without the source, provider and operator configuration", async () => {
  const createDatabase = vi.fn();
  const openDatabase = vi.fn();
  vi.doMock("../../../db.js", () => ({ createDatabase, openDatabase }));
  const argv = process.argv;
  const exitCode = process.exitCode;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.argv = ["node", "next-timers", "copy-hosted", "10000000-0000-4000-8000-000000000001"];
    await import("./cli.js");
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(String(error.mock.calls[0][0])).toContain("MDBASE_LEGACY_PROVIDER_DATABASE_URL");
    expect(createDatabase).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    error.mockRestore();
    vi.doUnmock("../../../db.js");
  }
});
