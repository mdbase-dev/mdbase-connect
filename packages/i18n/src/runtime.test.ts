import { describe, it, expect } from "vitest";
import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { i18n as globalI18n } from "@lingui/core";
import { createI18nRuntime, negotiateLocale, formatters, locales } from "./runtime.js";
import { loadCodeMirrorPhrases, englishCodeMirrorPhrases } from "./codemirror.js";
const catalogue = (text: string) => ({ messages: { greeting: compileMessageOrThrow(text) } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
describe("real Lingui runtime", () => {
  it("renders English synchronously without loading, then negotiates and changes html", async () => {
    let loads = 0;
    const runtime = createI18nRuntime({ english: catalogue("Hello {name}"),
      preferences: ["xx", "fr-CA"], loadLocale: async () => { loads++; return catalogue("Bonjour {name}"); }, document });
    expect(runtime.i18n._("greeting", { name: "Ada" })).toBe("Hello Ada");
    expect(loads).toBe(0);
    expect(document.documentElement.lang).toBe("en");
    await runtime.initialize();
    expect(runtime.i18n._("greeting", { name: "Ada" })).toBe("Bonjour Ada");
    expect(document.documentElement.lang).toBe("fr");
    expect(document.documentElement.dir).toBe("ltr");
    await runtime.initialize();
    expect(loads).toBe(1);
  });
  it("accepts the global singleton so non-React core helpers follow provider activation", async () => {
    const helper = () => globalI18n._("greeting", { name: "Ada" });
    const runtime = createI18nRuntime({ i18n: globalI18n, english: catalogue("Hello {name}"),
      preferences: ["fr"], loadLocale: async () => catalogue("Bonjour {name}") });
    expect(runtime.i18n).toBe(globalI18n);
    expect(helper()).toBe("Hello Ada");
    await runtime.initialize();
    expect(helper()).toBe("Bonjour Ada");
    await runtime.selectLocale("en");
    expect(helper()).toBe("Hello Ada");
  });
  it("explicit locale beats browser and persists only successful choices", async () => {
    let saved = "fr";
    const runtime = createI18nRuntime({ english: catalogue("Hello"), preferences: ["de"],
      storage: { getLocale: () => saved, setLocale: (locale) => { saved = locale; } },
      loadLocale: async (locale) => { if (locale === "de") throw new Error("chunk unavailable"); return catalogue("Bonjour"); } });
    await runtime.initialize();
    expect(runtime.i18n.locale).toBe("fr");
    await expect(runtime.selectLocale("de")).rejects.toThrow("chunk unavailable");
    expect(runtime.i18n.locale).toBe("fr");
    expect(saved).toBe("fr");
    await runtime.selectLocale("en");
    expect(saved).toBe("en");
  });
  it("late download and delayed startup cannot overwrite a newer choice", async () => {
    const french = deferred<ReturnType<typeof catalogue>>();
    const stored = deferred<string>();
    const runtime = createI18nRuntime({ english: catalogue("Hello"),
      storage: { getLocale: () => stored.promise, setLocale: () => {} },
      loadLocale: () => french.promise });
    const initialization = runtime.initialize();
    const first = runtime.selectLocale("fr");
    await runtime.selectLocale("en");
    french.resolve(catalogue("Bonjour"));
    stored.resolve("fr");
    await Promise.all([initialization, first]);
    expect(runtime.i18n.locale).toBe("en");
  });
  it("serializes asynchronous persistence so the latest choice remains stored", async () => {
    const firstWrite = deferred<void>();
    let saved = "en";
    const runtime = createI18nRuntime({ english: catalogue("Hello"), loadLocale: async () => catalogue("Bonjour"),
      storage: { getLocale: () => saved, setLocale: async (locale) => {
        if (locale === "fr") await firstWrite.promise;
        saved = locale;
      } } });
    const french = runtime.selectLocale("fr");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const english = runtime.selectLocale("en");
    firstWrite.resolve();
    await Promise.all([french, english]);
    expect(saved).toBe("en");
  });
  it("falls back on invalid persisted and OS locales", async () => {
    expect(negotiateLocale(["xx", "pt_BR"])).toBe("pt");
    expect(negotiateLocale(["xx", "zh-Hans-CN"])).toBe("zh");
    expect(negotiateLocale(["xx"])).toBe("en");
    const runtime = createI18nRuntime({ english: catalogue("Hello"), preferences: ["xx"],
      loadLocale: async () => { throw new Error("must not load"); },
      storage: { getLocale: () => "bad", setLocale: () => {} } });
    await runtime.initialize();
    expect(runtime.i18n.locale).toBe("en");
  });
  it("formats pt as Brazilian Portuguese without changing values", () => {
    expect(formatters("pt").number(1234.5)).toBe(new Intl.NumberFormat("pt-BR").format(1234.5));
    expect(formatters("fr").relativeTime(-1, "day")).toContain("jour");
    expect(formatters("ja").date(new Date("2026-01-02T12:00:00Z"), { timeZone: "UTC", year: "numeric" })).toContain("2026");
  });
});
describe("CodeMirror phrases", () => {
  it("covers all locales, keeps lookup keys and dollar substitution contracts", async () => {
    const english = englishCodeMirrorPhrases;
    expect(Object.keys(english)).toHaveLength(29);
    for (const locale of locales) {
      const phrases = await loadCodeMirrorPhrases(locale);
      expect(Object.keys(phrases)).toEqual(Object.keys(english));
      for (const [key, value] of Object.entries(phrases)) {
        expect(value.trim()).not.toBe("");
        expect(value.match(/\$/g)?.length ?? 0).toBe(key.match(/\$/g)?.length ?? 0);
      }
      phrases.Find = "mutated";
      expect((await loadCodeMirrorPhrases(locale)).Find).not.toBe("mutated");
    }
  });
});
