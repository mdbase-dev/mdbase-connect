// @vitest-environment jsdom
import { useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, click, find, get, key, mount, type } from "../test/dom.js";
import { AnchoredPopover } from "./AnchoredPopover.js";

afterEach(cleanup);

function Panel({ children, onClose, onBlur }: { children?: ReactNode; onClose?: (refocus: boolean) => void; onBlur?: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen(!open)}>Due</button>
      {open ? (
        <AnchoredPopover anchor={anchor} label="Due date" className="mine" onClose={(refocus) => { onClose?.(refocus); setOpen(false); }}>
          <button type="button">First</button>
          <input aria-label="Day" data-autofocus="" onBlur={onBlur} />
          {children}
        </AnchoredPopover>
      ) : null}
      <button type="button">Elsewhere</button>
    </>
  );
}

describe("AnchoredPopover", () => {
  it("opens in the top layer beside its control, with the keyboard in the marked field", () => {
    const view = mount(<Panel />);
    click(get("button", "Due"));
    const panel = get("dialog", "Due date");
    expect(panel.className).toBe("mdbase-popover mdbase-overlay mine");
    expect(panel.getAttribute("popover")).toBe("manual");
    expect(panel.dataset.popoverOpen).toBe("");
    expect(view.host.contains(panel)).toBe(false);
    expect(panel.style.top).toBe("6px");
    expect(panel.style.left).toBe("8px");
    expect(document.activeElement).toBe(get("textbox", "Day"));
  });

  it("puts the keyboard in its first control when none is marked", () => {
    function Plain() {
      const anchor = useRef<HTMLButtonElement>(null);
      return <><button ref={anchor} type="button">Open</button><AnchoredPopover anchor={anchor} label="Choices" onClose={() => undefined}><p>Pick</p><button type="button">One</button></AnchoredPopover></>;
    }
    mount(<Plain />);
    expect(document.activeElement).toBe(get("button", "One"));
  });

  it("closes on Escape and gives the focus back to its control", () => {
    const onClose = vi.fn();
    mount(<Panel onClose={onClose} />);
    click(get("button", "Due"));
    key("Escape");
    expect(onClose).toHaveBeenCalledWith(true);
    expect(find("dialog")).toBeNull();
    expect(document.activeElement).toBe(get("button", "Due"));
  });

  it("leaves Escape to a list that is open inside it", () => {
    const onClose = vi.fn();
    mount(<Panel onClose={onClose}><div role="listbox"><button type="button">Row</button></div></Panel>);
    click(get("button", "Due"));
    get("button", "Row").focus();
    key("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(get("dialog", "Due date")).toBeTruthy();
  });

  it("closes on a press elsewhere, after the field being typed in has lost the focus", () => {
    const order: string[] = [];
    mount(<Panel onBlur={() => order.push("blur")} onClose={(refocus) => order.push(`close ${String(refocus)}`)} />);
    click(get("button", "Due"));
    type(get("textbox", "Day"), "tomorrow");
    click(get("button", "Elsewhere"));
    expect(order).toEqual(["blur", "close false"]);
    expect(find("dialog")).toBeNull();
  });

  it("stays open for a press inside it, and lets its control close it", () => {
    const onClose = vi.fn();
    mount(<Panel onClose={onClose} />);
    click(get("button", "Due"));
    click(get("button", "First"));
    expect(get("dialog", "Due date")).toBeTruthy();
    click(get("button", "Due"));
    expect(onClose).not.toHaveBeenCalled();
    expect(find("dialog")).toBeNull();
  });

  it("mounts inside a modal dialog that is open, so the dialog does not make it inert", () => {
    const dialog = document.body.appendChild(document.createElement("dialog"));
    // jsdom does not know :modal; the shared dialog also says it is one.
    dialog.setAttribute("open", "");
    dialog.setAttribute("aria-modal", "true");
    mount(<Panel />);
    click(get("button", "Due"));
    expect(get("dialog", "Due date").parentElement).toBe(dialog);
  });
});
