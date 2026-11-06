import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { Signup } from "./auth-view";
import { fireEvent, render, screen } from "./test/render";

vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), api: vi.fn() }));

beforeEach(() => {
  vi.mocked(api).mockResolvedValue({ provider: "password", providers: [], password_login: true, password_public_registration: true });
});

it("focuses the email confirmation, names the address and lets a typo be corrected", async () => {
  render(<Signup invitationToken="" verificationToken="" />);
  const email = await screen.findByRole("textbox", { name: "Email" });
  fireEvent.change(email, { target: { value: "typo@example.com" } });
  fireEvent.submit(screen.getByRole("button", { name: "Send verification link" }).closest("form")!);
  const heading = await screen.findByRole("heading", { name: "Check your email" });
  expect(heading).toHaveFocus();
  expect(screen.getByText("typo@example.com")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
  expect(await screen.findByRole("textbox", { name: "Email" })).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("typo@example.com");
});

it("does not blame a missing link when public signup is paused", async () => {
  vi.mocked(api).mockResolvedValue({ provider: "password", providers: [], password_login: true, password_public_registration: false });
  render(<Signup invitationToken="" verificationToken="" />);
  expect(await screen.findByRole("heading", { name: "Account creation is paused" })).toHaveFocus();
  expect(screen.getByRole("link", { name: /waitlist/i })).toHaveAttribute("href", "https://mdbase.dev/beta/");
});
