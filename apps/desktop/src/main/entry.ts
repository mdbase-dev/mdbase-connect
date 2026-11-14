import { app, dialog } from "electron";
import { resolve } from "node:path";
import { ALLOW_LINE, CONFIRM_TIMEOUT_MS, confirmationArgument, describeConfirmation, parseConfirmation } from "./confirmation";
import { platformArguments, UPDATE_SWITCH } from "./display-platform";
import { runningBackgroundUpdate, waitForExit } from "./background-update";
import { runBackgroundUpdate } from "./headless-update";
import { createNativeLocale } from "./i18n";

// Before Chromium picks its display platform (see display-platform.ts).
const relaunch = platformArguments(process.platform, process.argv, process.env);
if (relaunch) process.execve!(process.execPath, relaunch, process.env);

const userDataOverride = process.env.MDBASE_CONNECT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", resolve(userDataOverride));

// Started by the daemon as its confirmation dialog, by the update timer, or as the app.
const argument = confirmationArgument(process.argv);
if (argument !== null) {
  confirm(argument).then((allowed) => {
    if (allowed) process.stdout.write(ALLOW_LINE, () => app.exit(0));
    else app.exit(1);
  }, () => app.exit(1));
} else if (process.argv.includes(UPDATE_SWITCH)) {
  runBackgroundUpdate().then((code) => app.exit(code), (error) => {
    process.stderr.write(`The update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });
} else {
  const updating = process.platform === "linux" ? runningBackgroundUpdate(app.getPath("userData")) : null;
  if (updating === null) {
    require("./main");
  } else {
    // A background update may be replacing this app's folder: start the app that
    // is there once it has finished.
    void waitForExit(updating).then(() => {
      app.relaunch();
      app.exit(0);
    });
  }
}

/** One dialog, Deny by default; closing it or the timeout means no. */
async function confirm(argument: string): Promise<boolean> {
  const request = parseConfirmation(argument);
  await app.whenReady();
  await createNativeLocale(app.getPath("userData"), app.getPreferredSystemLanguages()).initialize();
  const text = describeConfirmation(request);
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons: [text.deny, text.allow],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS)
  });
  return response === 1;
}
