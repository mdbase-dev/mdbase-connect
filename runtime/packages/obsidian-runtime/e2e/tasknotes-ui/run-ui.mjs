// Attaches ONLY to LAB's explicitly owned isolated CDP9372. Never launches/stops apps.
// LAB orchestrator owns preflight, fixture/install, metadata snapshots and tree cleanup.
import { connect, waitPlugin } from "../cdp.mjs";
const port = Number(process.env.LAB_UI_CDP_PORT);
if (port !== 9372 || process.env.LAB_UI_INSTANCE_OWNED !== "yes") throw new Error("explicit isolated LAB CDP9372 ownership required");
const cdp = await connect({ port });
let result = { environment: "lab", result: "blocked", stage: "runner" };
try {
  await waitPlugin(cdp, "tasknotes");
  for (let i = 0; i < 240; i++) {
    const state = await cdp.evaluate('app.plugins.plugins.tasknotes.result');
    if (!state?.fullPlugin || state.environment !== "lab") throw new Error("not the isolated full-plugin harness");
    if (state.result === "blocked") { result = state; break; }
    if (state.stage === "awaiting_ui_runner") {
      await cdp.evaluate('void app.plugins.plugins.tasknotes.run()');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  for (let i = 0; i < 150; i++) {
    const state = await cdp.evaluate('app.plugins.plugins.tasknotes.result');
    if (state?.result !== "running") { result = state; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} catch { result = { environment: "lab", result: "blocked", stage: "runner" }; }
finally { cdp.close(); }
console.log(JSON.stringify(result));
if (result.result !== "passed") process.exitCode = 1;
