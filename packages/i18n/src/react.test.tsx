import { afterEach, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react";
import { LanguagePicker, LocaleProvider } from "./react.js";
import { createI18nRuntime } from "./runtime.js";
afterEach(cleanup);
function Greeting() {
  const { i18n } = useLingui();
  return <p>{i18n._("hello")}</p>;
}
it("provides immediate English and real translated portal context with a native labelled picker", async () => {
  const errors: unknown[] = [];
  const runtime = createI18nRuntime({ english: { messages: { hello: "Hello" } },
    preferences: ["en"], loadLocale: async () => ({ messages: { hello: "Bonjour" } }) });
  const onError = (error: unknown) => { errors.push(error); };
  render(createElement(LocaleProvider, { runtime, onError, children: <>
    <LanguagePicker label="Language" onError={onError} />
    {createPortal(<Greeting />, document.body)}
  </> }));
  expect(screen.getByText("Hello")).toBeTruthy();
  const picker = screen.getByRole("combobox", { name: "Language" });
  expect(screen.getAllByRole("option")).toHaveLength(10);
  expect(screen.getByRole("option", { name: "Italiano" }).getAttribute("lang")).toBe("it");
  fireEvent.change(picker, { target: { value: "fr" } });
  await waitFor(() => expect(screen.getByText("Bonjour")).toBeTruthy());
  expect(errors).toEqual([]);
  expect(runtime.i18n.locale).toBe("fr");
});
it("reports load failure and retains current choice", async () => {
  const errors: unknown[] = [];
  const runtime = createI18nRuntime({ english: { messages: { hello: "Hello" } }, preferences: ["en"],
    loadLocale: async () => { throw new Error("offline"); } });
  const onError = (error: unknown) => { errors.push(error); };
  render(<LocaleProvider runtime={runtime} onError={onError}>
    <LanguagePicker label="Language" onError={onError} /><Greeting />
  </LocaleProvider>);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "ja" } });
  await waitFor(() => expect(errors).toHaveLength(1));
  expect(screen.getByText("Hello")).toBeTruthy();
  expect(runtime.i18n.locale).toBe("en");
});
