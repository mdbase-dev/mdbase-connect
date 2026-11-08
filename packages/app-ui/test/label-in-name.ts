/**
 * WCAG 2.5.3 Label in Name: a control's accessible name must contain the text it shows,
 * so voice-control users can activate it by saying what they see.
 *
 * `visibleLabel` is the control's text outside `aria-hidden` subtrees; `accessibleName` is
 * its `aria-label` or, without one, that same content text.
 */
export function visibleLabel(element: Element): string {
  return collapse(contentText(element));
}

export function accessibleName(element: Element): string {
  return collapse(element.getAttribute("aria-label") ?? contentText(element));
}

function contentText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return [...node.childNodes].map(contentText).join("");
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
