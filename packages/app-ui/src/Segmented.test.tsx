// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented.js";
import { ThemeSelect } from "./ThemeSelect.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
function mount(node: React.ReactNode) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(node));
}

// jsdom lays nothing out: each option is 50px wide, in a group with 2px of padding.
beforeEach(() => {
  const optionIndex = (element: HTMLElement): number =>
    [...element.parentElement!.querySelectorAll("label")].indexOf(element as HTMLLabelElement);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return 2 + optionIndex(this) * 50;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(50);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return 4 + this.querySelectorAll("label").length * 50;
  });
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

const views = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;
type View = (typeof views)[number]["value"];
const radios = (): HTMLInputElement[] => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const thumb = (): HTMLElement => host.querySelector<HTMLElement>(".mdbase-segmented-thumb")!;

it("is a named group of radios that share one name", () => {
  const onChange = vi.fn();
  mount(<Segmented aria-label="View" value="week" options={views} onChange={onChange} />);
  const group = host.querySelector('[role="radiogroup"]')!;
  expect(group.getAttribute("aria-label")).toBe("View");
  expect(radios().map((radio) => radio.checked)).toEqual([false, true, false]);
  expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);
  expect(radios()[0]!.labels![0]!.textContent).toBe("Day");
  act(() => radios()[2]!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith("month");
});

it("disables one option or all of them", () => {
  const onChange = vi.fn();
  const options = [views[0], { ...views[1], disabled: true }];
  mount(<Segmented<View> aria-label="View" value="day" options={options} onChange={onChange} />);
  expect(radios().map((radio) => radio.disabled)).toEqual([false, true]);
  act(() => root.render(<Segmented<View> aria-label="View" value="day" options={options} onChange={onChange} disabled />));
  expect(radios().map((radio) => radio.disabled)).toEqual([true, true]);
});

it("places the thumb on the chosen option, and names the leading edge only for a new choice", () => {
  const render = (value: View) => <Segmented aria-label="View" value={value} options={views} onChange={() => {}} />;
  mount(render("week"));
  const group = host.querySelector<HTMLElement>(".mdbase-segmented")!;
  expect(thumb().hidden).toBe(false);
  expect([thumb().style.left, thumb().style.right]).toEqual(["52px", "52px"]);
  expect(group.dataset["moving"]).toBeUndefined();
  act(() => root.render(render("month")));
  expect([thumb().style.left, thumb().style.right]).toEqual(["102px", "2px"]);
  expect(group.dataset["moving"]).toBe("end");
  act(() => root.render(render("day")));
  expect([thumb().style.left, thumb().style.right]).toEqual(["2px", "102px"]);
  expect(group.dataset["moving"]).toBe("start");
});

it("hides the thumb when no option holds the value", () => {
  mount(<Segmented aria-label="View" value={"year" as View} options={views} onChange={() => {}} />);
  expect(thumb().hidden).toBe(true);
});

it("offers the theme as three radios", () => {
  const onChange = vi.fn();
  mount(<ThemeSelect value="system" onChange={onChange} />);
  expect(host.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Color theme");
  expect(radios().map((radio) => [radio.value, radio.checked])).toEqual([
    ["system", true],
    ["light", false],
    ["dark", false],
  ]);
  act(() => radios()[2]!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith("dark");
});
