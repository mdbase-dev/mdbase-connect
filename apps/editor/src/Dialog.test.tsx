import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./Dialog";

describe("ConfirmDialog", () => {
  it("focuses cancel before a destructive confirmation", async () => {
    render(<ConfirmDialog
      title="Discard changes?"
      body={<p>The draft will not be kept.</p>}
      confirmLabel="Discard"
      tone="danger"
      onConfirm={vi.fn()}
      onClose={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("focuses the primary action for a non-destructive confirmation", async () => {
    render(<ConfirmDialog
      title="Continue?"
      body={<p>The next step is ready.</p>}
      confirmLabel="Continue"
      onConfirm={vi.fn()}
      onClose={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus());
  });
});
