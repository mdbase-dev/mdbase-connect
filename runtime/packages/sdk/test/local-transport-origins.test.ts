import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync(new URL("../src/local-build.ts", import.meta.url), "utf8");
const literal = "export const LOCAL_APPLICATION_BUILD: boolean = false;";
const origins = [
  ["http://127.0.0.1:4100", true, true],
  ["http://localhost:4100", true, true],
  ["http://[::1]:4100", true, true],
  ["http://127.0.0.1:0", false, false],
  ["http://127.0.0.1", false, false],
  ["http://127.0.0.1:80", false, false],
  ["http://remote.test:4100", false, false],
  ["http://localhost.evil.test:4100", false, false],
  ["http://127.1:4100", false, false],
  ["http://user:pass@127.0.0.1:4100", false, false],
  ["http://127.0.0.1:4100/path", false, true],
  ["http://127.0.0.1:4100?query", false, false],
  ["http://127.0.0.1:4100#fragment", false, false],
  ["https://control.test", true, true],
] as const;
const cases = [
  { compiledLocal: true, environment: "local" },
  { compiledLocal: false, environment: "lab" },
  { compiledLocal: false, environment: "production" },
  // A runtime label must not enable local transport in a managed artifact.
  { compiledLocal: false, environment: "local" },
].flatMap(build => origins.map(([origin, localAccepted, localRelayAccepted]) => ({ ...build, origin, localAccepted, localRelayAccepted })));

it.each(cases)("$environment compiledLocal=$compiledLocal: $origin", async ({ compiledLocal, environment, origin, localAccepted, localRelayAccepted }) => {
  vi.resetModules();
  vi.doMock("../src/local-build.js", async () => {
    if (source.split(literal).length !== 2) throw Error("compiled build literal missing");
    const output = transpileModule(compiledLocal ? source.replace(literal, literal.replace("false", "true")) : source,
      { compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 } }).outputText;
    return import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  });
  // Load one graph at a time: concurrent reset/mock imports can observe an
  // in-flight unmocked dependency before Vitest installs its compiled module.
  const { localApplicationHttpOrigin } = await import("../src/local-build.js");
  const { AppProtectedInstallationSignIn } = await import("../src/app-host/installation-sign-in.js");
  const { AppCollectionSetupJournal } = await import("../src/app-host/collection-setup-journal.js");
  const { controlRouteResolver } = await import("../src/transport/control-route.js");
  const { relayPipeCarrier } = await import("../src/transport/relay-pipe.js");
  const accepted = origin.startsWith("https:") || (compiledLocal && localAccepted);
  expect(localApplicationHttpOrigin(origin)).toBe(compiledLocal && origin.startsWith("http:") && localAccepted);
  // Only URL admission is under test; this selected-scope stub is NOT custody,
  // consent, collection readiness or an end-to-end sign-in fixture.
  const flow = { confirmedSelection: () => ({}), state: { environment } } as unknown as typeof AppProtectedInstallationSignIn.prototype;
  const host = () => AppProtectedInstallationSignIn.prototype.confirmedHostSession.call(flow, origin, environment);
  const journal = () => new AppCollectionSetupJournal({ databaseName: "origin-test", applicationNamespace: "test",
    appOrigin: "https://app.test", cpOrigin: origin, scope: { account: "10000000-0000-4000-8000-000000000001",
      installation: "10000000-0000-4000-8000-000000000002", collection: "10000000-0000-4000-8000-000000000003" }, isCurrent: () => true });
  const accessToken = vi.fn(() => "unused");
  const route = () => controlRouteResolver({ server: origin, collection: "unused", accessToken });
  for (const boundary of [host, journal, route]) {
    if (accepted) expect(boundary).not.toThrow(); else expect(boundary).toThrow();
  }
  expect(accessToken).not.toHaveBeenCalled();
  const socket = vi.fn(() => { throw Error("URL gate passed; no socket opened"); });
  await relayPipeCarrier(origin.replace(/^http/, "ws"), { accessToken: "unused", collection: "unused", grant: "unused",
    device: "unused", devicePublicKey: new Uint8Array(32) }, socket).catch(() => {});
  expect(socket).toHaveBeenCalledTimes(origin.startsWith("https:") || (compiledLocal && localRelayAccepted) ? 1 : 0);
  vi.doUnmock("../src/local-build.js");
});
