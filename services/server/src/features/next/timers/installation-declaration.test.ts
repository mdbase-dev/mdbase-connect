import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";
import type { RegisteredApplication } from "../../applications/store.js";
import { installationTimerDeclaration, readInstallationTimerDeclaration, type InstallationTimerBinding } from "./installation-declaration.js";

const binding: InstallationTimerBinding = { environment: "lab", app_origin: "https://reminders.example.test", kind: "app-runtime" };
function application(): Pick<RegisteredApplication, "id" | "requirements" | "notifications"> {
  return { id: randomUUID(), requirements: { contracts: [], access: "full_collection",
    capabilities: { contract_version: 2, required: ["collection.read"], optional: ["background.schedule"] } },
  notifications: { criteria: [{ id: "synthetic.reminder", event: MDBASE_TIMER_FIRED_CONTRACT, presentation: { title: "Reminder" } }],
    native_delivery: { mode: "managed_fcm", firebase_project_id: "synthetic-project" } } };
}

describe("installation timer declaration metadata (not consent or authority)", () => {
  it("expands only the original declared timer operations and exact timer event criteria", () => {
    const app = application();
    const result = installationTimerDeclaration(app, binding)!;
    expect(result.operations).toEqual(["list_timers", "put_timer", "cancel_timer", "reconcile_timers"]);
    expect(result.notifications).toEqual(app.notifications);
    expect(readInstallationTimerDeclaration(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it("does not infer timer authority from criteria or absent/historical capabilities", () => {
    const app = application();
    delete app.requirements.capabilities;
    expect(installationTimerDeclaration(app, binding)).toBeNull();
    app.requirements.capabilities = { contract_version: 2, required: ["collection.read"] };
    expect(installationTimerDeclaration(app, binding)).toBeNull();
  });
  it("keeps a versioned declared subset rather than adding undeclared operations", () => {
    const app = application();
    app.requirements.capabilities = { contract_version: 1, required: ["timers.list"], optional: ["timers.reconcile"] };
    expect(installationTimerDeclaration(app, binding)!.operations).toEqual(["list_timers", "reconcile_timers"]);
  });
  it("does not treat another event version or digest as the timer contract", () => {
    const app = application();
    app.notifications.criteria[0].event = { ...MDBASE_TIMER_FIRED_CONTRACT, version: "2.0.0" };
    expect(installationTimerDeclaration(app, binding)).toBeNull();
    app.notifications.criteria[0].event = { ...MDBASE_TIMER_FIRED_CONTRACT, digest: `sha256:${"0".repeat(64)}` };
    expect(installationTimerDeclaration(app, binding)).toBeNull();
  });
  it.each([
    { environment: "production" }, { kind: "mobile" }, { app_origin: "https://different.example.test" },
  ] satisfies Partial<InstallationTimerBinding>[])("binds the exact original application context %j", change => {
    const app = application();
    expect(installationTimerDeclaration(app, { ...binding, ...change })!.digest).not.toBe(installationTimerDeclaration(app, binding)!.digest);
  });
  it("detects criterion, static copy and delivery declaration drift while retaining the original snapshot", () => {
    const app = application(), original = installationTimerDeclaration(app, binding)!;
    app.notifications.criteria[0].presentation.title = "Changed reminder";
    app.notifications.native_delivery = { mode: "webhook", url: "https://hooks.example.test/signals" };
    const current = installationTimerDeclaration(app, binding)!;
    expect(current.digest).not.toBe(original.digest);
    expect(original.notifications.criteria[0].presentation.title).toBe("Reminder");
    expect(original.notifications.native_delivery?.mode).toBe("managed_fcm");
    expect(readInstallationTimerDeclaration(original)).toEqual(original);
  });
  it("does not mutate its input or lend mutable aliases through stored snapshot reads", () => {
    const app = application(), original = installationTimerDeclaration(app, binding)!;
    const copy = readInstallationTimerDeclaration(original);
    copy.notifications.criteria[0].presentation.title = "Mutation";
    expect(original.notifications.criteria[0].presentation.title).toBe("Reminder");
    expect(app.notifications.criteria[0].presentation.title).toBe("Reminder");
  });
  it("distinguishes corrupt registry/snapshot invariants from an app declaring no reminders", () => {
    const app = application();
    app.requirements.capabilities = { contract_version: 2, required: ["invalid" as never] };
    expect(() => installationTimerDeclaration(app, binding)).toThrow("Invalid registered installation timer declaration");
    const declaration = installationTimerDeclaration(application(), binding)!;
    expect(() => readInstallationTimerDeclaration({ ...declaration, operations: ["read"] })).toThrow(/Invalid/);
    expect(() => readInstallationTimerDeclaration({ ...declaration, application_id: randomUUID() })).toThrow(/Invalid/);
    expect(() => readInstallationTimerDeclaration({ ...declaration, unexpected: true })).toThrow(/Invalid/);
    expect(() => readInstallationTimerDeclaration(null)).toThrow(/Invalid/);
  });
});
