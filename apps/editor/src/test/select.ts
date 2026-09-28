import type { UserEvent } from "@testing-library/user-event";

/** The listbox an @mdbase-dev/ui Select trigger controls. */
export function optionsOf(trigger: HTMLElement): HTMLElement {
  const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  if (!list) throw new Error(`${trigger.getAttribute("aria-label") ?? "The select"} has no listbox`);
  return list;
}

/**
 * Chooses an option of an @mdbase-dev/ui Select the way a person does: open it, click the option.
 * Like userEvent.selectOptions, `choice` matches an option's value or its label.
 */
export async function chooseOption(user: UserEvent, trigger: HTMLElement, choice: string): Promise<void> {
  await user.click(trigger);
  const options = [...optionsOf(trigger).querySelectorAll<HTMLElement>('[role="option"]')];
  const option = options.find((candidate) => candidate.dataset.value === choice)
    ?? options.find((candidate) => candidate.textContent === choice);
  if (!option) throw new Error(`Option ${choice} is not in ${trigger.getAttribute("aria-label") ?? "the select"}`);
  await user.click(option);
}
