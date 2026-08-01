import { _electron as electron } from "playwright-core";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const executable = resolve(
  repoRoot,
  `target/debug/mdbase${process.platform === "win32" ? ".exe" : ""}`
);
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-file-settings-"));
const run = promisify(execFile);

const electronApp = await electron.launch({
  cwd: desktopRoot,
  args: [".", `--user-data-dir=${scratch}`],
  timeout: 15_000,
  env: {
    ...process.env,
    MDBASE_CONNECT_BIN: executable,
    MDBASE_CONNECT_HOME: resolve(scratch, "connect-home"),
    MDBASE_CONNECT_LOOPBACK_PORT: "0",
    MDBASE_CONNECT_USER_DATA_DIR: scratch
  }
});

try {
  const window = await electronApp.firstWindow({ timeout: 15_000 });
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("connect:hosted:snapshot");
    ipcMain.handle("connect:hosted:snapshot", () => ({
      online: true,
      hosted_collections_available: true,
      hosted_collections: [{
        id: "01900000-0000-7000-8000-000000000001",
        display_name: "Field notebook",
        template: "mdbase",
        sync_url: "https://connect.example/v1/authorities/01900000-0000-7000-8000-000000000001/sync",
        spec_version: "0.3.0",
        contracts: [],
        types: [],
        authority_state: "active",
        authority_epoch: 1,
        transferred_collection_id: null,
        created_at: "2026-08-01T00:00:00Z",
        replicas: []
      }],
      grants: [],
      pending_authorizations: []
    }));
    ipcMain.removeHandler("connect:mirrors:list");
    ipcMain.handle("connect:mirrors:list", () => []);
  });
  await window.reload();
  await window.getByRole("button", { name: /Collections/ }).click();
  await window.getByText("Field notebook", { exact: true }).waitFor();
  await window.getByRole("button", { name: "Details" }).click();
  const settings = window.getByRole("group", {
    name: "File types kept on this computer"
  });
  await window.locator("details.mirror-file-settings-setup > summary").click();
  await settings.waitFor();
  await settings.getByRole("checkbox", { name: /Images/ }).check();
  await settings.getByRole("checkbox", { name: /PDFs/ }).check();
  await window.getByLabel("Folders excluded from this computer").fill("Archive/large-media");
  await window.getByRole("button", { name: "Exclude" }).click();
  await window
    .locator("details.mirror-file-settings-setup > summary")
    .getByText("Markdown + images, pdfs · 1 folder excluded", { exact: true })
    .waitFor();
  await window.getByText("Archive/large-media", { exact: true }).waitFor();
  const screenshot = process.env.MDBASE_CONNECT_FILE_SETTINGS_SCREENSHOT;
  if (screenshot) await window.screenshot({ path: screenshot, animations: "disabled" });
  process.stdout.write("Selective sync Electron smoke test passed\n");
} finally {
  await run(executable, [
    "--state-dir",
    resolve(scratch, "connect-home"),
    "connect",
    "daemon",
    "stop"
  ], { timeout: 5_000 }).catch(() => {});
  await electronApp.close();
  await rm(scratch, { recursive: true, force: true });
}
