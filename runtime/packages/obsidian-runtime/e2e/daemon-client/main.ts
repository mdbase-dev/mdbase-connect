// LAB harness only. Real SDK + TaskNotes backend; never a fake transport or vault writer.
import { Plugin, parseYaml } from "obsidian";
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { connect, toPlain, revisionOf } from "@mdbase-lab/sdk";
import { connectDaemonLocalhost } from "@mdbase-lab/sdk/node";
import { SdkWriteClient, obsidianIndexed } from "@mdbase-lab/write-client";
import { MdbaseMutationBackend } from "@mdbase-lab/tasknotes-backend";

declare const LAB_FIXTURE_FILE: string;
declare const LAB_STATUS_FILE: string;

type Outcome = {
  environment: "lab"; result: "running" | "passed" | "blocked";
  stage: string; opened: boolean; queried: boolean; backendCreated: boolean;
  backendUpdated: boolean; indexed: boolean; readBack: boolean;
  publication: string; errorCode?: string; createdFixtures: string[];
  cleanup: "externally-owned-daemon" | "retained-safe-fixture";
};

export default class LabDaemonClient extends Plugin {
  result: Outcome = { environment: "lab", result: "running", stage: "preflight", opened: false,
    queried: false, backendCreated: false, backendUpdated: false, indexed: false,
    readBack: false, publication: "absent", createdFixtures: [], cleanup: "externally-owned-daemon" };
  private client: any;
  private running = false;
  async onload() {
    this.addCommand({ id: "lab-daemon-acceptance", name: "Run isolated LAB daemon acceptance", callback: () => void this.run() });
    // Explicit LAB build starts a bounded scenario; only this fixture root can arm it.
    void this.run();
  }
  onunload() { this.client?.close(); }
  async run(): Promise<Outcome> {
    if (this.running || this.result.stage === "complete") return this.result;
    this.running = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.scenario(), new Promise((_, reject) => {
        timer = setTimeout(() => { this.client?.close(); reject(new Error("scenario_timeout")); }, 60_000);
      })]);
      this.result.result = "passed";
      this.result.stage = "complete";
    } catch (e) {
      this.result.result = "blocked";
      // Never export raw errors: SDK failures may contain private paths or frame data.
      const code = (e as { code?: unknown }).code;
      this.result.errorCode = typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "acceptance_blocked";
    } finally {
      if (timer) clearTimeout(timer);
      this.client?.close();
      this.running = false;
    }
    return structuredClone(this.result);
  }
  private async scenario() {
    const status = JSON.parse(await readFile(LAB_STATUS_FILE, "utf8"));
    if (status.environment !== "lab" || status.identity !== "verified"
      || status.connect_origin !== "https://connect-lab.mdbase.dev" || status.daemon?.running !== true) throw new Error("lab_preflight");
    const fixture = JSON.parse(await readFile(LAB_FIXTURE_FILE, "utf8"));
    if (fixture.environment !== "lab" || fixture.labOwnsFixture !== true || !fixture.label?.startsWith("[test]")
      || !/^[0-9a-f-]{36}$/.test(fixture.collection)) throw new Error("fixture_scope");
    const parent = await realpath(`${dirname(LAB_FIXTURE_FILE)}/integration-fixtures`);
    const root = await realpath(fixture.root);
    const child = relative(parent, root);
    if (!child || child.startsWith(`..${sep}`) || child === ".." || child.startsWith(sep) || !child.startsWith("[test]")) throw new Error("fixture_root");
    const base = (this.app.vault.adapter as any).getBasePath?.();
    if (!base || await realpath(base) !== root) throw new Error("wrong_vault");
    this.result.stage = "connect";
    this.client = await connect({ app: { name: "obsidian-lab-tasknotes-backend", version: "0.0.0" }, reconnect: false,
      signal: AbortSignal.timeout(20_000), connector: connectDaemonLocalhost({ collection: fixture.collection, stateDir: fixture.stateDir, localOnly: true }) });
    this.result.opened = true;
    this.result.stage = "query";
    await this.client.query({ limit: 1 });
    this.result.queried = true;

    const path = `[test] obsidian-tasknotes-${crypto.randomUUID()}.md`;
    const title = "[test] Actual TaskNotes backend via localhost";
    const document = `---\ntitle: "${title}"\nstatus: todo\n---\n\n[test] Client-only acceptance.\n`;
    const delegate = this.client;
    const observe = (write: any) => {
      this.result.publication = write.receipt.published ?? "absent";
      return write;
    };
    // Actual SDK API. No custom conversion, frame encoding, confirmation fallback or direct vault write.
    const port = {
      find: (ref: any, include: any) => delegate.find(ref, include),
      create: async (input: any, options: any) => observe(await delegate.create(input, options)),
      update: async (target: any, changes: any, options: any) => observe(await delegate.update(target, changes, options)),
      replaceDocument: async (target: any, doc: any, options: any) => observe(await delegate.replaceDocument(target, doc, options)),
      submit: async (ops: any, options: any) => (await delegate.submit(ops, options)).map(observe),
    };
    const adapter = new SdkWriteClient(port, { root: "", toPlain, revisionOf, includeDocument: { document: true },
      indexed: obsidianIndexed(this.app.vault, 15_000), isRecordPath: (p: string) => p === path, isResourcePath: () => false });
    const backend = new MdbaseMutationBackend(adapter);
    this.result.stage = "tasknotes_published_create";
    this.result.createdFixtures.push(path); // attempted mutation may survive a lost response
    this.result.cleanup = "retained-safe-fixture";
    const created = await backend.create(path, document);
    if (!created.handled) throw new Error("backend_did_not_claim");
    this.result.backendCreated = true;
    this.result.indexed = !!this.app.vault.getAbstractFileByPath(path);
    if (!this.result.indexed) throw new Error("not_indexed");
    this.result.stage = "tasknotes_published_update";
    const updated = await backend.processFrontMatter(path, (fm: Record<string, unknown>) => { fm.status = "done"; });
    if (!updated.handled) throw new Error("backend_did_not_update");
    this.result.backendUpdated = true;
    this.result.stage = "sdk_and_vault_readback";
    const record = await delegate.get({ path }, { body: true });
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !("extension" in file)) throw new Error("file_missing");
    const disk = await this.app.vault.read(file as any);
    const fm = parseYaml(disk.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "");
    this.result.readBack = record.path === path && toPlain(record.frontmatter.get("status")) === "done" && fm.status === "done";
    if (!this.result.readBack) throw new Error("readback_mismatch");
  }
}
