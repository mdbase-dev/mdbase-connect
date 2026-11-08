import { render, screen, waitFor } from "./test/locale";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@mdbase-dev/ui/confirm-dialog";

describe("ConfirmDialog", () => {
  it("focuses cancel before a destructive confirmation", async () => {
    render(<ConfirmDialog open pendingLabel="Working…"
      title="Discard changes?"
      confirmLabel="Discard"
      tone="danger"
      onConfirm={vi.fn()}
      onClose={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("focuses the primary action for a non-destructive confirmation", async () => {
    render(<ConfirmDialog open pendingLabel="Working…"
      title="Continue?"
      initialFocus="confirm"
      tone="default"
      confirmLabel="Continue"
      onConfirm={vi.fn()}
      onClose={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus());
  });
});
