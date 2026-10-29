import { createRoot } from "react-dom/client";
import type { JSX } from "react";

import { CollectionPanel, CollectionProblem } from "./CollectionGate.js";
import { CollectionSwitcher, type CollectionSwitcherProps } from "./CollectionSwitcher.js";
import type { CollectionUiOptions } from "./use-collection-ui.js";

export type CollectionUiPart = "panel" | "switcher" | "problem";

export interface MountCollectionUiOptions extends CollectionUiOptions {
  /** "panel": sign-in, choosing and the list (a settings dialog); "switcher": the header trigger; "problem": the current problem with its fix. */
  readonly part: CollectionUiPart;
  /** "switcher": the trigger's variant. "none" needs an app anchor, so it is not mountable. */
  readonly variant?: Exclude<CollectionSwitcherProps["variant"], "none">;
  /** "switcher": leading content in the trigger ("mark" for the collection's initials). */
  readonly icon?: CollectionSwitcherProps["icon"];
  /** "panel": call `mdbase.start()` when it hasn't started. Default true. */
  readonly autoStart?: boolean;
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

function Part({ part, variant, icon, autoStart, ...options }: MountCollectionUiOptions): JSX.Element | null {
  switch (part) {
    case "panel": return <CollectionPanel {...options} {...(autoStart === undefined ? {} : { autoStart })} />;
    case "switcher": return <CollectionSwitcher {...options} {...(variant ? { variant } : {})} {...(icon === undefined ? {} : { icon })} />;
    case "problem": return <CollectionProblem {...options} />;
  }
}
