import type { ReactElement } from "react";

/**
 * Lingui's <Trans> reparses interpolated strings as rich-text markup, so a user
 * value such as `<0/>` or `<b>x</b>` would be rendered as tags. Pass user text
 * as a node instead; positional placeholders and message IDs stay the same.
 */
export function literal(text: string | null | undefined): ReactElement {
  return <>{text}</>;
}
