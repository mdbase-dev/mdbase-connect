import { LocaleProvider } from "@mdbase-dev/i18n/react";
import { runtime } from "../i18n";
import { render as renderBase, type RenderOptions } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
export * from "@testing-library/react";

/** All portal tests render through a real, synchronously initialized translator. */
export function render(ui: ReactElement, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  return renderBase(ui, {
    ...options,
    // React 19 only replays initial effects when StrictMode is at the root,
    // outside the provider wrapper, not just around the supplied component.
    reactStrictMode: options?.reactStrictMode || ui.type === StrictMode,
    wrapper: ({ children }) => <LocaleProvider runtime={runtime} onError={(error) => { throw error; }}>
      {Wrapper ? <Wrapper>{children}</Wrapper> : children}
    </LocaleProvider>,
  });
}
