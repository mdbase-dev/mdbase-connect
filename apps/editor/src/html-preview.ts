import type { CollectionFile } from "./model";
import { isReadOnlyMarkdownFile } from "./file-reference-resolution";

/** Maximum HTML file size rendered inline in the sandboxed preview iframe.
 * Larger HTML files still download via Open original up to the store ceiling. */
export const MAX_HTML_PREVIEW_BYTES = 5 * 1024 * 1024;

/** Maximum characters rendered in the HTML Source tab before truncating. */
export const MAX_HTML_SOURCE_CHARACTERS = 512 * 1024;

/** Opaque origin, no scripts, no forms, no top-navigation; only explicit new-tab
 * links may open outside the sandbox. */
export const HTML_IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'";
const HTML_MEDIA_TYPE = /^(?:text\/html|application\/xhtml\+xml)$/;
const HTML_EXTENSION = /\.html?$/iu;

/** HTML files rendered in the sandboxed previewer. Exact Markdown profiles
 * always take precedence over MIME or path metadata. */
export function isHtmlPreviewFile(
  file: Pick<CollectionFile, "contentProfile" | "mediaClass" | "mediaType" | "path">
): boolean {
  if (isReadOnlyMarkdownFile(file) || file.mediaClass !== "other") return false;
  const type = file.mediaType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (HTML_MEDIA_TYPE.test(type)) return true;
  return (!type || type === "application/octet-stream") && HTML_EXTENSION.test(file.path);
}

/** Prepares untrusted HTML for a scriptless, opaque-origin `srcdoc` iframe:
 * removes active/navigation directives, prepends a strict CSP and referrer
 * policy, keeps in-page `#anchor` links, rewrites `http(s):` links to open in a
 * new tab, and strips every other link scheme/target so clicks cannot execute
 * scripts or navigate the frame into a CSP error. */
export function prepareHtmlPreviewDocument(source: string): string {
  const document_ = new DOMParser().parseFromString(source, "text/html");
  for (const element of document_.querySelectorAll("script, base")) element.remove();
  for (const meta of document_.querySelectorAll("meta[http-equiv]")) {
    const equiv = meta.getAttribute("http-equiv")?.trim().toLowerCase();
    if (equiv === "refresh" || equiv === "content-security-policy") meta.remove();
  }
  for (const link of document_.querySelectorAll("a[href], area[href]")) {
    const raw = link.getAttribute("href")?.trim() ?? "";
    if (raw.startsWith("#")) {
      link.removeAttribute("target");
      continue;
    }
    const safeUrl = parseExternalHttpUrl(raw);
    if (safeUrl) {
      link.setAttribute("href", safeUrl);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.removeAttribute("href");
      link.removeAttribute("target");
      link.removeAttribute("rel");
    }
  }
  const head = document_.head
    ?? document_.documentElement.insertBefore(document_.createElement("head"), document_.documentElement.firstChild);
  const referrer = document_.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer");
  const csp = document_.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", HTML_PREVIEW_CSP);
  head.prepend(csp, referrer);
  return `<!DOCTYPE html>\n${document_.documentElement.outerHTML}`;
}

export function truncateHtmlSource(source: string): { text: string; truncated: boolean } {
  if (source.length <= MAX_HTML_SOURCE_CHARACTERS) return { text: source, truncated: false };
  let end = MAX_HTML_SOURCE_CHARACTERS;
  if (/[\uD800-\uDBFF]/.test(source[end - 1])) end -= 1;
  return { text: source.slice(0, end), truncated: true };
}

function parseExternalHttpUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
