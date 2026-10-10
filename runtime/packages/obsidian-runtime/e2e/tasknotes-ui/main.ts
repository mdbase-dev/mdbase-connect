// Test-only full TaskNotes source plugin in a LAB-owned fresh vault/profile.
import { parseYaml, TFile } from "obsidian";
import { readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { validateEnvelope, validatePhysicalRoot } from "./guard.mjs";
import { appendDiagnostic, receiptSummary, errorSummary, shouldRunUI, ownedCreationPath, creationDisposition, LabScenarioError } from "./diagnostics.mjs";
import TaskNotesPlugin from "@mdbase-lab/tasknotes-main";
import { TaskCreationModal } from "@mdbase-lab/tasknotes-create-modal";
import { TaskEditModal } from "@mdbase-lab/tasknotes-edit-modal";
import { setMdbaseMutationBackend } from "@mdbase-lab/tasknotes-vault-service";
import { MdbaseMutationBackend } from "@mdbase-lab/tasknotes-backend";
import { connect, toPlain, revisionOf } from "@mdbase-lab/sdk";
import { connectDaemonLocalhost } from "@mdbase-lab/sdk/node";
import { SdkWriteClient, obsidianIndexed } from "@mdbase-lab/write-client";

declare const LAB_FIXTURE_FILE: string;
declare const LAB_STATUS_FILE: string;
declare const LAB_UI_MODE: "full_ui" | "negative_initialization";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export default class LabTaskNotesUI extends TaskNotesPlugin {
  result = { environment: "lab", result: "running", stage: "preflight", fullPlugin: true, scenarioMode: LAB_UI_MODE,
    backendInstalled: false, initialized: false, createModalRendered: false, modalSaved: false,
    serviceUpdated: false, editModalRendered: false, readBack: false,
    attemptedTaskPath: "", creationPathMatched: false, sdkCreateRouted: false, createPublished: false,
    resourcePublished: 0, recordPublished: 0, createdFixtures: [] as string[],
    attemptedResources: [] as string[], diagnostics: [] as any[], errorCode: "", cleanup: "retained-safe-fixture",
    scope: LAB_UI_MODE === "negative_initialization" ? "negative-initialization-only-no-modal-or-service-crud" : "isolated-desktop-modal-create-and-service-update-not-dirty-editor-or-cloud" };
  private client: any;
  private readonly linkAbort = new AbortController();
  private superStarted = false;
  private stopped = false;
  private modal: any;
  private scenarioStarted = false;

  async loadData() {
    const data = await super.loadData();
    return { ...data, tasksFolder: "", taskFilenameFormat: "custom", customFilenameTemplate: "{{title}}",
      openTaskAfterCreation: "none", enableMdbaseSpec: true, enableAPI: false, enableDebugLogging: false, uiLanguage: "en" };
  }

  async onload() {
    try {
      const status = JSON.parse(await readFile(LAB_STATUS_FILE, "utf8"));
      const fixture = JSON.parse(await readFile(LAB_FIXTURE_FILE, "utf8"));
      validateEnvelope(status, fixture);
      const parent = await realpath(dirname(dirname(LAB_FIXTURE_FILE)));
      const root = await realpath(fixture.root);
      const base = this.app.vault.adapter.getBasePath?.();
      if (!base) throw new Error("wrong_vault");
      validatePhysicalRoot(parent, root, await realpath(base));
      this.result.stage = "connect";
      const openTimeout = setTimeout(() => this.linkAbort.abort(), 20_000);
      try {
        this.client = await connect({ app: { name: "obsidian-lab-tasknotes-full-ui", version: "0.0.0" }, reconnect: false,
          signal: this.linkAbort.signal, connector: connectDaemonLocalhost({ collection: fixture.collection, stateDir: fixture.stateDir, localOnly: true }) });
      } finally { clearTimeout(openTimeout); }
      if (this.stopped) { this.client.close(); throw new Error("stopped"); }
      await this.client.query({ limit: 1 });
      const delegate = this.client;
      const observe = (write: any, resource = false) => {
        appendDiagnostic(this.result.diagnostics, resource ? "resource_submit" : "record_write", "receipt", receiptSummary(write));
        if (write.receipt.published === "published") {
          if (resource) this.result.resourcePublished++; else this.result.recordPublished++;
        }
        return write;
      };
      const port = {
        find: (ref: any, include: any) => delegate.find(ref, include),
        create: async (input: any, options: any) => {
          this.result.createdFixtures.push(input.path);
          try { return observe(await delegate.create(input, options)); }
          catch (error) {
            appendDiagnostic(this.result.diagnostics, "record_create", "throw", errorSummary(error));
            throw error;
          }
        },
        update: async (target: any, changes: any, options: any) => observe(await delegate.update(target, changes, options)),
        replaceDocument: async (target: any, doc: any, options: any) => observe(await delegate.replaceDocument(target, doc, options)),
        submit: async (ops: any[], options: any) => {
          this.result.attemptedResources.push(...ops.map(op => op.path));
          try {
            return (await delegate.submit(ops, options)).map((w: any) => observe(w, true));
          } catch (error) {
            appendDiagnostic(this.result.diagnostics, "resource_submit", "throw", errorSummary(error));
            throw error;
          }
        },
      };
      const isResourcePath = (p: string) => p === "mdbase.yaml" || /^(?:_types|_contracts|_schemas)\//.test(p);
      // Fresh fixture uses default inclusion. Never reuse this predicate for arbitrary collections.
      const adapter = new SdkWriteClient(port, { root: "", toPlain, revisionOf, includeDocument: { document: true },
        indexed: obsidianIndexed(this.app.vault, 15_000), isResourcePath,
        isRecordPath: (p: string) => p.endsWith(".md") && !isResourcePath(p) && !p.startsWith(".") });
      setMdbaseMutationBackend(new MdbaseMutationBackend(adapter));
      this.result.backendInstalled = true;
      this.result.stage = "full_plugin_initialization";
      this.superStarted = true;
      await super.onload();
      this.result.initialized = !!this.taskService && !!this.cacheManager && !!this.mdbaseSpecService;
      if (!this.result.initialized || !this.result.resourcePublished) throw new Error("initialization_incomplete");
      if (!shouldRunUI(LAB_UI_MODE)) {
        this.result.stage = "negative_initialized";
        this.result.result = "negative_not_reproduced";
        this.client.close();
        return;
      }
      this.result.stage = "awaiting_ui_runner";
    } catch (error) {
      appendDiagnostic(this.result.diagnostics, "plugin_entry", "throw", errorSummary(error));
      this.result.result = "blocked";
      this.result.errorCode = "full_plugin_entry_blocked";
      this.client?.close();
    }
  }

  async run() {
    if (!shouldRunUI(LAB_UI_MODE) || this.scenarioStarted || this.stopped || this.result.stage !== "awaiting_ui_runner") return structuredClone(this.result);
    this.scenarioStarted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.scenario(), new Promise((_, reject) => {
        timer = setTimeout(() => { this.client?.close(); reject(new Error("scenario_timeout")); }, 60_000);
      })]);
      this.result.result = "passed";
      this.result.stage = "complete";
    } catch (error) {
      appendDiagnostic(this.result.diagnostics, "ui_service", "throw", errorSummary(error));
      this.result.result = "blocked";
      this.result.errorCode = error instanceof LabScenarioError ? error.code : "full_ui_service_blocked";
    } finally {
      if (timer) clearTimeout(timer);
      this.modal?.close();
    }
    return structuredClone(this.result);
  }

  private async scenario() {
    this.result.stage = "modal_create";
    const nonce = crypto.randomUUID();
    const title = `[test] tasknotes-ui-${nonce}`;
    const expectedPath = ownedCreationPath(nonce);
    this.result.attemptedTaskPath = expectedPath; // Retain intent even if an unported path bypasses the SDK.
    let resolveTask!: (task: any) => void;
    const saved = new Promise<any>(resolve => { resolveTask = resolve; });
    this.modal = new TaskCreationModal(this.app, this, { prePopulatedValues: { title, status: "open", priority: "normal" }, onTaskCreated: resolveTask });
    this.modal.open();
    const save = await this.saveButton(this.modal);
    this.result.createModalRendered = this.modal.containerEl.isConnected && save.offsetParent !== null;
    if (!this.result.createModalRendered) throw new Error("modal_not_visible");
    save.click(); // Actual modal event handler -> TaskService -> VaultMutationService.
    const task = await saved;
    this.result.modalSaved = true;
    const disposition = creationDisposition(expectedPath, task.path, this.result.createdFixtures, this.result.recordPublished);
    this.result.creationPathMatched = disposition.creationPathMatched;
    this.result.sdkCreateRouted = disposition.sdkCreateRouted;
    this.result.createPublished = disposition.createPublished;
    if (disposition.errorCode) throw new LabScenarioError(disposition.errorCode);
    this.result.stage = "full_service_update";
    const updated = await this.taskService.updateTask(task, { status: "done" });
    this.result.serviceUpdated = updated.status === "done";
    this.result.stage = "edit_modal_render";
    this.modal = new TaskEditModal(this.app, this, { task: updated });
    this.modal.open();
    const editSave = await this.saveButton(this.modal);
    this.result.editModalRendered = this.modal.containerEl.isConnected && editSave.offsetParent !== null;
    this.modal.close();
    this.result.stage = "sdk_and_vault_readback";
    const record = await this.client.get({ path: task.path }, { body: true });
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) throw new Error("file_missing");
    const disk = await this.app.vault.read(file);
    const fm = parseYaml(disk.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "");
    const statusKey = this.settings.fieldMapping.status;
    this.result.readBack = toPlain(record.frontmatter.get(statusKey)) === "done" && fm[statusKey] === "done";
    if (!this.result.readBack || !this.result.serviceUpdated || !this.result.editModalRendered || this.result.recordPublished < 2) throw new Error("readback_incomplete");
  }

  private async saveButton(modal: any): Promise<HTMLButtonElement> {
    for (let i = 0; i < 100; i++) {
      if (this.stopped) throw new Error("stopped");
      const button = modal.containerEl.querySelector(".tn-task-modal__button-bar button.mod-cta");
      if (button && !button.disabled) return button;
      await pause(50);
    }
    throw new Error("modal_not_ready");
  }

  onunload() {
    this.stopped = true;
    this.modal?.close();
    this.linkAbort.abort();
    this.client?.close();
    // Only our test bundle installs this module-local backend. Production stays inactive.
    setMdbaseMutationBackend(null);
    if (this.superStarted) super.onunload();
  }
}
