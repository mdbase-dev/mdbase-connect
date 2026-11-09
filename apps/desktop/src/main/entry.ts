import { app, dialog } from "electron";
import { ALLOW_LINE, CONFIRM_TIMEOUT_MS, confirmationArgument, describeConfirmation, parseConfirmation } from "./confirmation";
import { createNativeLocale } from "./i18n";

// Started by the daemon as its confirmation dialog, or as the app.
const argument = confirmationArgument(process.argv);
if (argument === null) {
  require("./main");
} else {
  confirm(argument).then((allowed) => {
    if (allowed) process.stdout.write(ALLOW_LINE, () => app.exit(0));
    else app.exit(1);
  }, () => app.exit(1));
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
