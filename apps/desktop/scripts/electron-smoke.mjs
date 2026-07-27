import { _electron as electron } from "playwright-core";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const executable = resolve(
  repoRoot,
  `target/debug/mdbase-connect${process.platform === "win32" ? ".exe" : ""}`
);
const userData = process.env.MDBASE_CONNECT_SMOKE_DATA;
if (!userData) throw new Error("MDBASE_CONNECT_SMOKE_DATA is required");
const run = promisify(execFile);

const electronApp = await electron.launch({
  cwd: desktopRoot,
  args: [".", `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    MDBASE_CONNECT_BIN: executable,
    MDBASE_CONNECT_HOME: resolve(userData, "connect-home"),
    MDBASE_CONNECT_LOOPBACK_PORT: "0",
    MDBASE_CONNECT_USER_DATA_DIR: userData
  }
});

try {
  const window = await electronApp.firstWindow();
  await window.getByRole("heading", { name: "Your local connection." }).waitFor();
  await window.getByText("Local only").first().waitFor();
  await window.getByRole("button", { name: /Collections/ }).click();
  await window.getByRole("heading", { name: "Your collections, in one place." }).waitFor();
  await window.getByRole("heading", { name: "On this computer" }).waitFor();
  await window.getByRole("heading", { name: "Hosted by mdbase" }).waitFor();
  await window.getByRole("button", { name: "Create collection" }).click();
  await window.getByRole("heading", { name: "Create an mdbase collection" }).waitFor();
  const hostedAuthority = window.getByRole("radio", { name: "Hosted by mdbase" });
  if (await hostedAuthority.isEnabled()) throw new Error("Hosted authority should require an account connection");
  await window.getByText("Connect this computer to your account first.").waitFor();
  const screenshot = process.env.MDBASE_CONNECT_SMOKE_SCREENSHOT;
  if (screenshot) await window.screenshot({ path: screenshot, animations: "disabled" });
  await window.getByRole("button", { name: "Cancel" }).click();
  await window.getByRole("button", { name: /App access/ }).click();
  await window.getByRole("heading", { name: "Connect this computer." }).waitFor();
  await window.getByRole("button", { name: /Overview/ }).click();
  const title = await window.title();
  if (title !== "mdbase connect") throw new Error(`Unexpected window title: ${title}`);
  process.stdout.write("Electron smoke test passed\n");
} finally {
  await run(executable, [
    "--state-dir",
    resolve(userData, "connect-home"),
    "daemon",
    "stop"
  ]).catch(() => {});
  await electronApp.close();
}
