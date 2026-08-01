import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ComboboxInput, SelectControl } from "./SelectionControls";

describe("selection controls", () => {
  it("keeps fixed choices native while applying the shared control shell", async () => {
    const user = userEvent.setup();
    render(<SelectHarness />);

    const control = screen.getByRole("combobox", { name: "Status" });
    expect(control.parentElement).toHaveClass("select-control");
    expect(control.parentElement?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await user.selectOptions(control, "done");
    expect(control).toHaveValue("done");
  });

  it("filters suggestions and supports complete keyboard selection", async () => {
    const user = userEvent.setup();
    const onOptionSelect = vi.fn();
    render(<ComboboxHarness onOptionSelect={onOptionSelect} />);

    const control = screen.getByRole("combobox", { name: "Related note" });
    await user.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    await user.type(control, "pro");
    const list = screen.getByRole("listbox", { name: "Related note suggestions" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);

    await user.keyboard("{ArrowDown}{Enter}");
    expect(control).toHaveValue("Projects/alpha.md");
    expect(onOptionSelect).toHaveBeenCalledWith("Projects/alpha.md");
    expect(control).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape and reports an empty result without discarding free text", async () => {
    const user = userEvent.setup();
    render(<ComboboxHarness />);

    const control = screen.getByRole("combobox", { name: "Related note" });
    await user.type(control, "missing");
    expect(screen.getByRole("listbox", { name: "Related note suggestions" })).toHaveTextContent("No matching notes.");
    await user.keyboard("{Escape}");
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(control).toHaveValue("missing");
  });
});

function SelectHarness() {
  const [value, setValue] = useState("open");
  return <SelectControl aria-label="Status" value={value} onChange={(event) => setValue(event.target.value)}>
    <option value="open">Open</option>
    <option value="done">Done</option>
  </SelectControl>;
}

function ComboboxHarness({ onOptionSelect }: { onOptionSelect?: (value: string) => void }) {
  const [value, setValue] = useState("");
  return <ComboboxInput
    label="Related note"
    value={value}
    options={["Projects/alpha.md", "Projects/beta.md", "People/ada.md"]}
    emptyMessage="No matching notes."
    onValueChange={setValue}
    onOptionSelect={onOptionSelect}
  />;
}
