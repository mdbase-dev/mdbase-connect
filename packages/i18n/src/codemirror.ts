import type { Locale } from "./runtime.js";
import english from "./codemirror/en.js";

/** Bundled English; pass to EditorState.phrases.of(...). */
export const englishCodeMirrorPhrases: Readonly<Record<string, string>> = Object.freeze(english);
const loaders = {
  fr: () => import("./codemirror/fr.js"), de: () => import("./codemirror/de.js"),
  es: () => import("./codemirror/es.js"), ja: () => import("./codemirror/ja.js"),
  ko: () => import("./codemirror/ko.js"), pt: () => import("./codemirror/pt.js"),
  ru: () => import("./codemirror/ru.js"), zh: () => import("./codemirror/zh.js"),
};
/** Lazy chunks from the app's own deployment. Reconfigure the facet on activation.
 * Keys come from CodeMirror 6 view/search/autocomplete/language/commands/lint.
 * pt is Brazilian Portuguese; zh is Simplified Chinese. Never translate document data.
 */
export async function loadCodeMirrorPhrases(locale: Locale): Promise<Record<string, string>> {
  return { ...(locale === "en" ? english : (await loaders[locale]()).default) };
}
