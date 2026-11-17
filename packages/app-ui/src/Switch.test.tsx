// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Switch } from "./Switch.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
function mount(node: React.ReactNode) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(node));
}
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

it("reports the opposite state when pressed", () => {
  const onChange = vi.fn();
  mount(<Switch checked={false} onChange={onChange} aria-label="Wrap lines" />);
  const control = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.type).toBe("button");
  act(() => control.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  act(() => root.render(<Switch checked onChange={onChange} aria-label="Wrap lines" />));
  expect(control.getAttribute("aria-checked")).toBe("true");
});

it("is named and toggled by its label text", () => {
  const onChange = vi.fn();
  mount(<Switch checked onChange={onChange}>Wrap long lines</Switch>);
  const label = host.querySelector("label")!;
  expect(label.control).toBe(host.querySelector('[role="switch"]'));
  act(() => label.querySelector("span")!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
});

it("does nothing while disabled, or when its own click handler cancels", () => {
  const onChange = vi.fn();
  mount(<Switch checked={false} onChange={onChange} disabled aria-label="Sync" />);
  act(() => host.querySelector("button")!.click());
  act(() => root.render(
    <Switch checked={false} onChange={onChange} onClick={(event) => event.preventDefault()} aria-label="Sync" />,
  ));
  act(() => host.querySelector("button")!.click());
  expect(onChange).not.toHaveBeenCalled();
});
