import {
  MDBASE_MARK_VIEW_BOX,
  mdbaseMarkAccentRect,
  mdbaseMarkInkRects,
  mdbaseMarkMotionClass,
  type MdbaseMarkMotion,
  type MdbaseMarkRect
} from "@mdbase/connect-ui/brand";
import {
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference
} from "@mdbase/connect-ui/theme";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";

const themeChoices: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

export interface ProductSidebarItem {
  id: string;
  label: string;
  href?: string;
  count?: number;
  attention?: boolean;
}

export function ProductSidebar({ items, active, account, identity, editorHref, accountHref = "/account", onNavigate }: {
  items: ProductSidebarItem[];
  active: string;
  account: string;
  identity: string;
  editorHref: string;
  accountHref?: string;
  onNavigate(id: string, href: string): void;
}) {
  const follow = (event: MouseEvent<HTMLAnchorElement>, id: string, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(id, href);
  };
  return <aside id="product-navigation" className="product-sidebar">
    <div className="product-sidebar-brand"><Brand productLabel /></div>
    <nav className="product-sidebar-nav" aria-label="mdbase connect navigation">
      {items.map((item) => <a
        key={item.id}
        className={`product-sidebar-link ${active === item.id ? "active" : ""}`}
        href={item.href ?? `/${item.id}`}
        aria-current={active === item.id ? "page" : undefined}
        onClick={(event) => follow(event, item.id, item.href ?? `/${item.id}`)}
      >
        <span>{item.label}</span>
        {item.count !== undefined && <b className={`product-sidebar-count ${item.attention ? "attention" : ""}`}>{item.count}</b>}
      </a>)}
    </nav>
    <footer className="product-sidebar-footer">
      <div className="product-sidebar-footer-nav">
        <a
          className={`product-sidebar-link ${active === "account" ? "active" : ""}`}
          href={accountHref}
          aria-current={active === "account" ? "page" : undefined}
          onClick={(event) => follow(event, "account", accountHref)}
        >Account</a>
      </div>
      <div className="product-sidebar-account">
        <span className="product-sidebar-account-copy"><strong>{account}</strong><small>{identity}</small></span>
        <ThemeMenu placement="up" />
      </div>
      <div className="product-sidebar-utilities">
        <a className="product-sidebar-utility" href={editorHref} target="_blank" rel="noreferrer">Open editor <span aria-hidden="true">↗</span></a>
      </div>
    </footer>
  </aside>;
}

export function MobileProductBar({ open, onOpen }: { open: boolean; onOpen(): void }) {
  return <header className="mobile-product-bar">
    <Brand productLabel />
    <button className="mobile-navigation-button" aria-label="Open navigation" aria-controls="product-navigation" aria-expanded={open} onClick={onOpen}><span /></button>
  </header>;
}

export function AccountRow({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) { return <div className="account-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong>{detail && <small>{detail}</small>}</div></div>; }
export function ThemeMenu({ placement = "down" }: { placement?: "up" | "down" }) {
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    const frame = requestAnimationFrame(() => {
      optionRefs.current[themeChoices.findIndex(({ value }) => value === preference)]?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open, preference]);

  function choose(next: ThemePreference) {
    setPreference(next);
    saveThemePreference(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = optionRefs.current.findIndex((option) => option === document.activeElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % themeChoices.length;
    else if (event.key === "ArrowUp") next = (current - 1 + themeChoices.length) % themeChoices.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = themeChoices.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    } else return;
    event.preventDefault();
    optionRefs.current[next]?.focus();
  }

  const label = themeChoices.find(({ value }) => value === preference)?.label ?? "System";
  return <div className={`theme-menu theme-menu-${placement}`} ref={containerRef}>
    <button
      ref={triggerRef}
      type="button"
      className="theme-menu-trigger"
      aria-label={`Color theme: ${label}`}
      aria-haspopup="menu"
      aria-expanded={open}
      title={`Color theme: ${label}`}
      onClick={() => setOpen((value) => !value)}
    ><ThemeGlyph preference={preference} /></button>
    {open && <div className="theme-menu-popover" role="menu" aria-label="Color theme" onKeyDown={moveFocus}>
      {themeChoices.map((choice, index) => <button
        key={choice.value}
        ref={(element) => { optionRefs.current[index] = element; }}
        type="button"
        className="theme-menu-option"
        role="menuitemradio"
        aria-checked={preference === choice.value}
        onClick={() => choose(choice.value)}
      >
        <ThemeGlyph preference={choice.value} />
        <span>{choice.label}</span>
        <svg className="theme-menu-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.2 2.8 2.8 6.2-6.3" /></svg>
      </button>)}
    </div>}
  </div>;
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
export function PageBrand({ label, themePicker = true, markMotion }: { label: string; themePicker?: boolean; markMotion?: MdbaseMarkMotion }) { return <div className="page-brand-row"><div className="page-brand"><Brand markMotion={markMotion} /><span>{label}</span></div>{themePicker && <ThemeMenu />}</div>; }
export function Brand({ productLabel = false, markMotion }: { productLabel?: boolean; markMotion?: MdbaseMarkMotion }) { return <div className="product-brand"><MdbaseMark motion={markMotion} /><strong>mdbase</strong>{productLabel && <span className="product-brand-label">connect</span>}</div>; }

const conveyorXs = [-6, 22, 50, 78, 106] as const;

function MarkSegment({ rect, index, accent = false }: {
  rect: MdbaseMarkRect;
  index: number;
  accent?: boolean;
}) {
  return <rect
    className={`mdbase-mark-segment mdbase-mark-segment-${index} ${accent ? "mdbase-mark-accent product-brand-mark-accent" : "mdbase-mark-ink"}`}
    pathLength={1}
    {...rect}
  />;
}

function MdbaseMark({ motion }: { motion?: MdbaseMarkMotion }) {
  const clipId = `mdbase-fences-${useId().replaceAll(":", "")}`;
  return <svg className={`product-brand-mark mdbase-motion-mark${mdbaseMarkMotionClass(motion)}`} viewBox={MDBASE_MARK_VIEW_BOX} aria-hidden="true" focusable="false">
    <defs><clipPath id={clipId}><rect x="22" y="22" width="76" height="10" rx="2" /><rect x="22" y="88" width="76" height="10" rx="2" /></clipPath></defs>
    <g className="mdbase-mark-fence mdbase-mark-fence-top product-brand-mark-ink">
      {mdbaseMarkInkRects.slice(0, 3).map((rect, index) => <MarkSegment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 1} />)}
    </g>
    <g className="mdbase-mark-row mdbase-mark-row-top">
      <MarkSegment rect={mdbaseMarkInkRects[3]} index={4} />
      <MarkSegment rect={mdbaseMarkAccentRect} index={5} accent />
    </g>
    <g className="mdbase-mark-row mdbase-mark-row-bottom product-brand-mark-ink">
      <MarkSegment rect={mdbaseMarkInkRects[4]} index={6} />
      <MarkSegment rect={mdbaseMarkInkRects[5]} index={7} />
    </g>
    <g className="mdbase-mark-fence mdbase-mark-fence-bottom product-brand-mark-ink">
      {mdbaseMarkInkRects.slice(6).map((rect, index) => <MarkSegment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 8} />)}
    </g>
    <g clipPath={`url(#${clipId})`}><g className="mdbase-mark-conveyor-track">{conveyorXs.flatMap((x) => [22, 88].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="20" height="10" rx="2" />))}</g></g>
  </svg>;
}
export function SectionHeading({ title, note, count }: { title: string; note: string; count?: number }) { return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div>{count !== undefined && <span>{count}</span>}</div>; }
export function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span className="empty-folder" /><strong>{title}</strong><p>{text}</p></div>; }
export function Loading({ error = "" }: { error?: string }) { return <main className="loading" aria-busy={!error}><Brand productLabel markMotion={error ? undefined : "bootstrap"} /><p>{error || "Opening mdbase connect…"}</p></main>; }

function ThemeGlyph({ preference }: { preference: ThemePreference }) {
  if (preference === "light") return <svg className="theme-glyph" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 2.4v1.2M10 16.4v1.2M2.4 10h1.2M16.4 10h1.2M4.6 4.6l.9.9M14.5 14.5l.9.9M15.4 4.6l-.9.9M5.5 14.5l-.9.9" /></svg>;
  if (preference === "dark") return <svg className="theme-glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M16.3 12.6A6.8 6.8 0 0 1 7.4 3.7 6.8 6.8 0 1 0 16.3 12.6Z" /></svg>;
  return <svg className="theme-glyph" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.8" y="3.5" width="14.4" height="10.2" rx="1.5" /><path d="M7.2 16.5h5.6M10 13.7v2.8" /></svg>;
}
