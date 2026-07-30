import {
  MDBASE_MARK_VIEW_BOX,
  mdbaseMarkAccentRect,
  mdbaseMarkInkRects
} from "@mdbase/connect-ui/brand";
import {
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference
} from "@mdbase/connect-ui/theme";
import { useEffect, useState } from "react";

export function AccountRow({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) { return <div className="account-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong>{detail && <small>{detail}</small>}</div></div>; }
export function ThemeSelect() {
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);
  return <select className="theme-select" aria-label="Color theme" value={preference} onChange={(event) => {
    const next = event.target.value as ThemePreference;
    setPreference(next);
    saveThemePreference(next);
  }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>;
}
export function useSystemTheme() {
  useEffect(() => {
    applyThemePreference("system");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
}
export function PageBrand({ label, themePicker = true }: { label: string; themePicker?: boolean }) { return <div className="page-brand-row"><div className="page-brand"><Brand /><span>{label}</span></div>{themePicker && <ThemeSelect />}</div>; }
export function Brand({ productLabel = false }: { productLabel?: boolean }) { return <div className="product-brand"><MdbaseMark /><strong>mdbase</strong>{productLabel && <span className="product-brand-label">connect</span>}</div>; }
function MdbaseMark() { return <svg className="product-brand-mark" viewBox={MDBASE_MARK_VIEW_BOX} aria-hidden="true" focusable="false"><g className="product-brand-mark-ink">{mdbaseMarkInkRects.map((rect) => <rect key={`${rect.x}-${rect.y}`} {...rect} />)}</g><rect className="product-brand-mark-accent" {...mdbaseMarkAccentRect} /></svg>; }
export function SectionHeading({ title, note, count }: { title: string; note: string; count?: number }) { return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div>{count !== undefined && <span>{count}</span>}</div>; }
export function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span className="empty-folder" /><strong>{title}</strong><p>{text}</p></div>; }
export function Loading({ error = "" }: { error?: string }) { return <main className="loading"><Brand /><p>{error || "Opening mdbase connect…"}</p></main>; }

