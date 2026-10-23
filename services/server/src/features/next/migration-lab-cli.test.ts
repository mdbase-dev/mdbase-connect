import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise the real entry module and pure origin/TLS gates. Only effects are
// substituted: no database, provider, Worker or cloud endpoint is contacted.
const effects = vi.hoisted(() => ({
  controlEnd: vi.fn(), sourceEnd: vi.fn(), createDatabase: vi.fn(), openDatabase: vi.fn(),
  connect: vi.fn(), worker: vi.fn(), run: vi.fn(), resume: vi.fn(), routeBack: vi.fn(), status: vi.fn(),
  providerConfig: vi.fn()
}));
vi.mock("../../db.js", () => ({ createDatabase: effects.createDatabase, openDatabase: effects.openDatabase }));
vi.mock("../../runtime-config.js", () => ({ hostedProviderConfigFromEnv: effects.providerConfig }));
vi.mock("./migration-lab.js", () => ({
  postgresLabConnect: effects.connect, labWorkerClient: effects.worker, labRun: effects.run,
  resumeLab: effects.resume, routeBack: effects.routeBack, labStatus: effects.status
}));
const account = "10000000-0000-4000-8000-000000000001", hold = "20000000-0000-4000-8000-000000000002";
const sourceUrl = "postgres://synthetic:synthetic@source.invalid/source?sslmode=verify-full";
const origins = { lab: "https://connect-lab.mdbase.dev", staging: "https://connect-staging.mdbase.dev", production: "https://connect.mdbase.dev" };
const commands = ["lab-run", "resume", "route-back", "status"];
const argv = process.argv, exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv; process.exitCode = exitCode;
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

async function invoke(environment: keyof typeof origins, command: string, overrides: Record<string, string | undefined> = {}, flags: string[] = []) {
  vi.resetModules(); vi.resetAllMocks();
  effects.createDatabase.mockResolvedValue({ end: effects.controlEnd });
  effects.openDatabase.mockResolvedValue({ end: effects.sourceEnd });
  effects.connect.mockReturnValue({}); effects.worker.mockReturnValue({});
  effects.providerConfig.mockReturnValue({ url: "https://provider.invalid", internalToken: "p".repeat(40) });
  for (const method of [effects.run, effects.resume]) method.mockResolvedValue({ done: { account_id: account, collection_ids: [hold], backend: "next", migration_complete: true } });
  effects.routeBack.mockResolvedValue({ done: { account_id: account, collection_ids: [hold], refenced: true } });
  effects.status.mockResolvedValue({ status: "observed" });
  for (const [key, value] of Object.entries({
    MDBASE_CONNECT_ENVIRONMENT: environment, PUBLIC_URL: origins[environment], DATABASE_URL: "postgres://synthetic@control.invalid/control",
    MDBASE_LEGACY_PROVIDER_DATABASE_URL: sourceUrl, MDBASE_OPERATOR: "migration-operator", MDBASE_NEXT_TIMERS: "1",
    MDBASE_NEXT_HOSTED_SERVICE_URL: "https://worker.invalid", MDBASE_NEXT_HOSTED_SERVICE_TOKEN: "w".repeat(40),
    MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN: "m".repeat(40), MDBASE_LEGACY_PROVIDER_LAB_OWNER_READONLY_ROLE: undefined,
    ...overrides
  })) vi.stubEnv(key, value);
  process.argv = ["node", "next-migration-lab", command, account, ...(command === "lab-run" ? [hold] : []), ...flags];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./migration-lab-cli.js");
  await vi.waitFor(() => expect(error.mock.calls.length + effects.controlEnd.mock.calls.length).toBe(1));
  return { error, log };
}

function noIO() {
  expect(effects.createDatabase).not.toHaveBeenCalled(); expect(effects.openDatabase).not.toHaveBeenCalled();
  expect(effects.worker).not.toHaveBeenCalled(); expect(effects.connect).not.toHaveBeenCalled();
  for (const method of [effects.run, effects.resume, effects.routeBack, effects.status]) expect(method).not.toHaveBeenCalled();
}

describe("LAB owner-readonly CLI override", () => {
  const source = "postgresql://synthetic_lab_owner:synthetic@dpg-dabpdaon74is7380br1g-a:5432/mdbase_lab_beta94_202609020323211110102?options=-cdefault_transaction_read_only%3Don";
  const overrides = { MDBASE_LEGACY_PROVIDER_DATABASE_URL: source, MDBASE_LEGACY_PROVIDER_LAB_OWNER_READONLY_ROLE: "synthetic_lab_owner" };
  it.each([
    ["lab-run", []], ["lab-run", ["--stop-before-flip"]], ["resume", []], ["status", []], ["route-back", []],
  ] as const)("allows %s %j with the same readonly source", async (command, extra) => {
    const { error } = await invoke("lab", command, overrides, [...extra]);
    expect(error).not.toHaveBeenCalled();
    expect(effects.openDatabase).toHaveBeenCalledExactlyOnceWith(source, { rejectUnauthorized: false });
    const selected = { "lab-run": effects.run, resume: effects.resume, status: effects.status, "route-back": effects.routeBack }[command];
    expect(selected).toHaveBeenCalledOnce();
    expect(effects.sourceEnd).toHaveBeenCalledOnce(); expect(effects.controlEnd).toHaveBeenCalledOnce();
  });
});

describe.each(["staging", "production"] as const)("%s product CLI entry composition", environment => {
  it.each(commands)("uses the SAME ordinary %s implementation with the exact deployment environment", async command => {
    const { error, log } = await invoke(environment, command);
    expect(error).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledOnce();
    expect(effects.createDatabase).toHaveBeenCalledExactlyOnceWith("postgres://synthetic@control.invalid/control");
    expect(effects.openDatabase).toHaveBeenCalledExactlyOnceWith(sourceUrl, undefined);
    expect(effects.connect).toHaveBeenCalledWith(expect.objectContaining({ environment, actor: "migration-operator", timers: true,
      ...(["lab-run", "resume"].includes(command) ? { prepareTarget: expect.any(Function) } : {}) }));
    expect(effects.worker).toHaveBeenCalledWith(expect.objectContaining({ environment }));
    const selected = command === "lab-run" ? effects.run : command === "resume" ? effects.resume : command === "route-back" ? effects.routeBack : effects.status;
    expect(selected).toHaveBeenCalledOnce();
    if (["lab-run", "resume"].includes(command)) expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ done: { account_id: account, collection_ids: [hold], backend: "next", migration_complete: true } }));
    if (command !== "status") expect(selected.mock.calls[0]![command === "lab-run" ? 2 : 1]).toMatchObject({ environment });
    expect(effects.sourceEnd).toHaveBeenCalledOnce(); expect(effects.controlEnd).toHaveBeenCalledOnce();
  });
  it.each(commands)("refuses missing/foreign/arbitrary CP identity before any %s I/O", async command => {
    for (const url of [undefined, "", "invalid", "https://arbitrary.invalid", "https://connect-lab.mdbase.dev",
      origins[environment === "production" ? "staging" : "production"], origins[environment] + "/path"]) {
      const { error } = await invoke(environment, command, { PUBLIC_URL: url });
      expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ error: "migration_target_unavailable" }));
      noIO(); expect(effects.providerConfig).not.toHaveBeenCalled();
      error.mockRestore();
    }
  });
  it.each(commands)("refuses LAB-only role override before %s I/O", async command => {
    const { error } = await invoke(environment, command, { MDBASE_LEGACY_PROVIDER_LAB_OWNER_READONLY_ROLE: "synthetic_lab_owner" });
    expect(error).toHaveBeenCalledOnce();
    expect(effects.createDatabase).not.toHaveBeenCalled(); expect(effects.openDatabase).not.toHaveBeenCalled();
    for (const method of [effects.run, effects.resume, effects.routeBack, effects.status]) expect(method).not.toHaveBeenCalled();
  });
});
