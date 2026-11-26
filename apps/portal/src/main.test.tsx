import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the routing in main.tsx is under test, so every page is a stub.
const page = (name: string) => () => <h1>{name}</h1>;
vi.mock("./ConnectApp", () => ({ ConnectApp: page("Connect app") }));
vi.mock("./auth-view", () => ({
  ForgotPassword: page("Forgot password"), Login: page("Login"), ResetPassword: page("Reset password"),
  Signup: page("Signup"), Unsubscribe: page("Unsubscribe")
}));
vi.mock("./authority-workflows", () => ({ Pairing: page("Pairing") }));
vi.mock("./authorization-view", () => ({ Authorization: page("Authorization"), DeviceAuthorization: page("Device") }));
vi.mock("./onboarding-view", () => ({ GettingStarted: page("Getting started") }));

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, "", "/");
  vi.resetModules();
});

describe("portal routes", () => {
  // The legacy mirror pairing, authority transfer and adoption pages were removed; their
  // old links open the portal app instead of a blank or broken page.
  it.each(["/mirror", "/transfer", "/adopt"])("opens the portal app for an old %s link", async (prefix) => {
    history.replaceState(null, "", `${prefix}/11111111-1111-4111-8111-111111111111`);
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await act(async () => { await import("./main"); });
    expect(await screen.findByRole("heading", { name: "Connect app" })).toBeInTheDocument();
  });

  it("still opens the pairing page for its link", async () => {
    history.replaceState(null, "", "/pair/11111111-1111-4111-8111-111111111111");
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await act(async () => { await import("./main"); });
    expect(await screen.findByRole("heading", { name: "Pairing" })).toBeInTheDocument();
  });
});
