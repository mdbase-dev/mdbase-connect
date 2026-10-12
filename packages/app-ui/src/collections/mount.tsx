import { createRoot } from "react-dom/client";
import type { JSX } from "react";

import { CollectionPanel, CollectionProblem } from "./CollectionGate.js";
import { CollectionSwitcher, type CollectionSwitcherProps } from "./CollectionSwitcher.js";
import type { CollectionUiOptions } from "./use-collection-ui.js";

export type CollectionUiPart = "panel" | "switcher" | "problem";

export interface MountCollectionUiOptions extends CollectionUiOptions {
  /** "panel": sign-in, choosing and the list (a settings dialog); "switcher": the header trigger; "problem": the current problem with its fix. */
  readonly part: CollectionUiPart;
  readonly variant?: CollectionSwitcherProps["variant"];
}

export interface MountedCollectionUi {
  update(next: Partial<MountCollectionUiOptions>): void;
  unmount(): void;
}

/** Render a shared collection component into an element, for apps that don't render with React. */
export function mountCollectionUi(element: Element, options: MountCollectionUiOptions): MountedCollectionUi {
  const root = createRoot(element);
  let current = options;
  const render = (): void => root.render(<Part {...current} />);
  render();
  return {
    update(next) { current = { ...current, ...next }; render(); },
    unmount() { root.unmount(); },
  };
}

function Part({ part, variant, ...options }: MountCollectionUiOptions): JSX.Element | null {
  switch (part) {
    case "panel": return <CollectionPanel {...options} />;
    case "switcher": return <CollectionSwitcher {...options} {...(variant ? { variant } : {})} />;
    case "problem": return <CollectionProblem {...options} />;
  }
}
