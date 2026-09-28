import { EditorView } from "@codemirror/view";

/**
 * The popups an mdbase editor shows: completion lists, their info panels, hover cards and
 * lint diagnostics. Reader's completion picker, in Editor's quiet treatment: a fine outline,
 * 2px corners and no shadow. Tooltips mounted outside the editor still carry this theme.
 *
 * Completion `type`s map to icons: `citation` (@) and `annotation` (❝) reference sources,
 * `source` and `text` are records, `keyword` is a command, `namespace` a folder, `type` a type.
 */
export const mdbasePopupTheme = EditorView.theme({
  ".cm-tooltip": {
    border: "1px solid var(--color-border-strong)",
    borderRadius: "var(--control-radius, 2px)",
    color: "var(--color-text)",
    backgroundColor: "var(--color-surface)",
    boxShadow: "none",
    fontFamily: "var(--sans)"
  },
  ".cm-tooltip.cm-tooltip-autocomplete": { padding: "4px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    width: "min(440px, calc(100vw - 24px))",
    minWidth: "0",
    maxWidth: "none",
    maxHeight: "min(320px, 45vh)",
    fontFamily: "var(--sans)",
    whiteSpace: "normal"
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "grid",
    gridTemplateColumns: "20px minmax(0, 1fr)",
    columnGap: "8px",
    alignItems: "center",
    padding: "6px 8px",
    borderRadius: "var(--control-radius, 2px)",
    lineHeight: "1.35"
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    color: "var(--color-text)",
    background: "var(--color-selected)"
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li > *": {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  ".cm-completionIcon": {
    gridRow: "1 / span 2",
    width: "20px",
    padding: "0",
    color: "var(--color-text-muted)",
    fontSize: "13px",
    lineHeight: "20px",
    textAlign: "center",
    opacity: "1"
  },
  ".cm-completionIcon-citation::after": { content: '"@"', color: "var(--color-accent)" },
  ".cm-completionIcon-annotation::after": { content: '"❝"', color: "var(--color-accent)" },
  ".cm-completionIcon-source::after, .cm-completionIcon-text::after": { content: '"§"' },
  ".cm-completionIcon-keyword::after": { content: '"/"' },
  ".cm-completionIcon-namespace::after": { content: '"▤"' },
  ".cm-completionIcon-type::after": { content: '"T"' },
  ".cm-completionLabel": {
    gridColumn: "2",
    color: "var(--color-text)",
    fontSize: "13px",
    fontWeight: "600"
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--color-accent)"
  },
  ".cm-completionDetail": {
    gridColumn: "2",
    marginLeft: "0",
    color: "var(--color-text-muted)",
    fontSize: "11px",
    fontStyle: "normal"
  },
  ".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after": {
    color: "var(--color-text-faint)",
    fontSize: "11px"
  },
  ".cm-tooltip.cm-completionInfo": {
    maxWidth: "min(320px, calc(100vw - 24px))",
    margin: "0 4px",
    padding: "10px 12px",
    color: "var(--color-text-soft)",
    fontSize: "12px",
    lineHeight: "1.5",
    whiteSpace: "pre-line"
  },
  ".cm-tooltip.cm-tooltip-lint": { padding: "4px", fontSize: "12px" },
  ".cm-diagnostic": { padding: "4px 8px", borderRadius: "var(--control-radius, 2px)", fontFamily: "var(--sans)" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--color-danger)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--color-warning)" },
  ".cm-diagnostic-info, .cm-diagnostic-hint": { borderLeft: "3px solid var(--color-accent)" }
});
