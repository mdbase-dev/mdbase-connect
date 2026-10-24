/**
 * DOM rendering for private sync: status, device approval, recovery key setup
 * and import. Plain DOM with Obsidian's CSS classes. The `obsidian` module is
 * not imported, so the runtime stays testable and the plugin passes its own
 * `Modal` class in.
 */

import type { ApproveResult, DeviceApproval, PendingDevice, PrivateSyncAction, PrivateSyncView, RecoveryKeySetup } from "./privateSync.js";
import { formatSas } from "./sas.js";
import type { RecoveryKeyProblem } from "./recoveryKey.js";

type Attrs = { cls?: string; text?: string; attr?: Record<string, string> };

function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, a: Attrs = {}): HTMLElementTagNameMap[K] {
  const e = parent.ownerDocument.createElement(tag);
  if (a.cls) e.className = a.cls;
  if (a.text !== undefined) e.textContent = a.text;
  for (const [k, v] of Object.entries(a.attr ?? {})) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}

const ACTION_LABEL: Record<PrivateSyncAction, string> = {
  "approve-devices": "Review devices",
  "use-recovery-key": "Use recovery key",
  "set-up-recovery-key": "Set up recovery key",
  "replace-recovery-key": "Replace recovery key",
  "enrol-again": "Enrol this device again",
  "request-approval": "Request approval again",
  "retry-connection": "Retry",
};

/** The status block for a private collection. */
export function renderPrivateSyncStatus(parent: HTMLElement, view: PrivateSyncView, onAction: (a: PrivateSyncAction) => void): HTMLElement {
  const root = el(parent, "div", { cls: `mdbase-private-sync mdbase-tone-${view.tone}` });
  el(root, "div", { cls: "mdbase-private-sync-title", text: view.title });
  if (view.code) {
    const code = el(root, "div", { cls: "mdbase-sas-code", text: view.code, attr: { "aria-label": `Approval code ${view.code.split("").join(" ")}` } });
    code.style.fontVariantNumeric = "tabular-nums";
  }
  for (const p of view.body) el(root, "p", { cls: "mdbase-private-sync-body", text: p });
  if (view.actions.length > 0) {
    const row = el(root, "div", { cls: "mdbase-private-sync-actions" });
    view.actions.forEach((a, i) => {
      const b = el(row, "button", { cls: i === 0 ? "mod-cta" : "", text: ACTION_LABEL[a] });
      b.addEventListener("click", () => onAction(a));
    });
  }
  return root;
}

const APPROVE_PROBLEM: Record<Exclude<ApproveResult, { ok: true }>["problem"], string> = {
  format: "Enter the six digits shown on the new device.",
  mismatch: "The code doesn't match. Don't approve a device unless it is yours and you typed the code it shows.",
  gone: "This device is no longer waiting. It may have been approved elsewhere.",
  not_started: "Start the approval first, so the new device shows its code.",
  locked: "Too many wrong codes. For safety this request can't be approved any more. Enrol the new device again to retry.",
};

/**
 * The approval list (`sealed-envelope.md` §5.3, commit then reveal).
 *
 * For each pending device the user presses **Approve…**. This device challenges
 * the new one, which then shows a code. The user types that code here. This
 * device never displays its own copy, so approval needs reading the other screen.
 */
export function renderApprovals(
  parent: HTMLElement,
  pending: readonly PendingDevice[],
  handlers: { approval(device: string): DeviceApproval; reject(device: string): Promise<void> },
): HTMLElement {
  const root = el(parent, "div", { cls: "mdbase-approvals" });
  if (pending.length === 0) {
    el(root, "p", { text: "No devices are waiting for approval." });
    return root;
  }
  el(root, "p", { text: "A device asked to join this end-to-end encrypted collection. Approve it only if it is yours." });
  for (const d of pending) {
    const flow = handlers.approval(d.device);
    const item = el(root, "div", { cls: "setting-item mdbase-approval" });
    const info = el(item, "div", { cls: "setting-item-info" });
    el(info, "div", { cls: "setting-item-name", text: d.label ?? `${d.kind} device` });
    const hint = el(info, "div", { cls: "setting-item-description", text: "Press Approve… and the new device will show a six-digit code." });
    const msg = el(info, "div", { cls: "mdbase-approval-message" });
    const ctl = el(item, "div", { cls: "setting-item-control" });
    const start = el(ctl, "button", { cls: "mod-cta", text: "Approve…" });
    const input = el(ctl, "input", { attr: { type: "text", inputmode: "numeric", autocomplete: "off", placeholder: "Code on the new device", maxlength: "7" } });
    const approve = el(ctl, "button", { cls: "mod-cta", text: "Approve" });
    const reject = el(ctl, "button", { text: "Not mine" });
    input.style.display = approve.style.display = "none";
    const busy = (b: boolean) => {
      for (const x of [start, approve, reject, input]) x.disabled = b;
    };
    start.addEventListener("click", async () => {
      busy(true);
      msg.textContent = "Waiting for the new device…";
      try {
        const r = await flow.start();
        if (r.ok) {
          start.style.display = "none";
          input.style.display = approve.style.display = "";
          hint.textContent = "Type the code now shown on the new device.";
          msg.textContent = "";
          input.focus();
        } else {
          msg.textContent = r.reason === "commitment_mismatch" ? "The new device's answer didn't match what it enrolled with. Don't approve it." : `Couldn't start approval (${r.reason}). Is the new device online with mdbase open?`;
        }
      } catch (e) {
        msg.textContent = `Couldn't start approval: ${e instanceof Error ? e.message : String(e)}`;
      }
      busy(false);
    });
    approve.addEventListener("click", async () => {
      busy(true);
      msg.textContent = "";
      try {
        const r = await flow.confirm(input.value);
        if (r.ok) {
          item.classList.add("is-approved");
          msg.textContent = "Approved. The device can now read the collection.";
          return;
        }
        msg.textContent = APPROVE_PROBLEM[r.problem] + (r.attemptsLeft ? ` ${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? "" : "s"} left.` : "");
        if (r.problem === "locked") {
          item.classList.add("is-locked");
          return;
        }
      } catch (e) {
        msg.textContent = `Approval failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      busy(false);
    });
    reject.addEventListener("click", async () => {
      busy(true);
      try {
        await handlers.reject(d.device);
        item.classList.add("is-rejected");
        msg.textContent = "Not approved here. To remove the device from your account, revoke it in mdbase account settings.";
      } catch (e) {
        msg.textContent = String(e);
        busy(false);
      }
    });
  }
  return root;
}

/** Recovery key setup: show, ask the user to keep it, confirm the last group. */
export function renderRecoverySetup(
  parent: HTMLElement,
  setup: RecoveryKeySetup,
  handlers: { enrol(typed: string): Promise<boolean>; skip(): void; copy?(text: string): void },
): HTMLElement {
  const root = el(parent, "div", { cls: "mdbase-recovery-setup" });
  el(root, "p", {
    text: "A recovery key lets you get this collection back if you lose all your devices. mdbase can't read your notes, so without it they can't be recovered. Write it down or store it in a password manager.",
  });
  const key = el(root, "pre", { cls: "mdbase-recovery-key", text: setup.formatted });
  key.style.userSelect = "all";
  key.style.whiteSpace = "pre-wrap";
  if (handlers.copy) {
    const copy = el(root, "button", { text: "Copy" });
    copy.addEventListener("click", () => handlers.copy!(setup.formatted));
  }
  el(root, "p", { text: "To confirm you've saved it, type the last group of five characters." });
  const input = el(root, "input", { attr: { type: "text", autocomplete: "off", maxlength: "5" } });
  const msg = el(root, "div", { cls: "mdbase-recovery-message" });
  const row = el(root, "div", { cls: "mdbase-private-sync-actions" });
  const ok = el(row, "button", { cls: "mod-cta", text: "Set up recovery key" });
  const skip = el(row, "button", { text: "Skip for now" });
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      if (await handlers.enrol(input.value)) {
        key.textContent = "";
        msg.textContent = "Recovery key set up.";
        return;
      }
      msg.textContent = `That doesn't match. The last group is the five characters after the final dash.`;
    } catch (e) {
      msg.textContent = `Couldn't set up the recovery key: ${e instanceof Error ? e.message : String(e)}`;
    }
    ok.disabled = false;
  });
  skip.addEventListener("click", () => handlers.skip());
  return root;
}

const RECOVERY_PROBLEM: Record<RecoveryKeyProblem, string> = {
  wrong_prefix: "A recovery key starts with MDB1.",
  wrong_length: "That's not the right length. Check for a missing or extra group.",
  bad_character: "That contains a character a recovery key never has.",
  checksum: "That key has a typo: one of the characters is wrong.",
};

/** Recovery key import, to key this device without another device online. */
export function renderRecoveryImport(
  parent: HTMLElement,
  handlers: { submit(typed: string): Promise<{ ok: true } | { ok: false; problem: RecoveryKeyProblem }> },
): HTMLElement {
  const root = el(parent, "div", { cls: "mdbase-recovery-import" });
  el(root, "p", { text: "Enter the recovery key you saved when you set up this collection." });
  const input = el(root, "textarea", { attr: { rows: "3", autocomplete: "off", spellcheck: "false", placeholder: "MDB1-…" } });
  const msg = el(root, "div", { cls: "mdbase-recovery-message" });
  const ok = el(root, "button", { cls: "mod-cta", text: "Recover" });
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    msg.textContent = "";
    try {
      const r = await handlers.submit(input.value);
      if (r.ok) {
        input.value = "";
        msg.textContent = "This device can read the collection again.";
        return;
      }
      msg.textContent = RECOVERY_PROBLEM[r.problem];
    } catch (e) {
      msg.textContent = `Recovery failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    ok.disabled = false;
  });
  return root;
}

/** The part of Obsidian's `Modal` used here. */
export interface ModalLike {
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  onOpen(): void;
  onClose(): void;
  open(): void;
  close(): void;
}

/** Open `render` in a modal built from the plugin's own `Modal` class. */
export function openInModal<A>(Modal: new (app: A) => ModalLike, app: A, title: string, render: (el: HTMLElement, close: () => void) => void): ModalLike {
  const m = new Modal(app);
  m.onOpen = () => {
    m.titleEl.textContent = title;
    render(m.contentEl, () => m.close());
  };
  m.onClose = () => {
    m.contentEl.replaceChildren();
  };
  m.open();
  return m;
}
