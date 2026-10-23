import { LocaleProvider } from "@mdbase-dev/i18n/react";
import { render as renderReact, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { createEditorLocaleRuntime } from "../i18n/runtime";

export * from "@testing-library/react";

// Exercise the real Lingui runtime, not a translator mock. A fresh runtime keeps
// explicit language changes in one test from affecting another test's English UI.
export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  const runtime = createEditorLocaleRuntime({ preferences: ["en"] });
  function Wrapper({ children }: { children: ReactNode }) {
    return <LocaleProvider runtime={runtime} onError={(error) => { throw error; }}>{children}</LocaleProvider>;
  }
  return renderReact(ui, { ...options, wrapper: Wrapper });
}
