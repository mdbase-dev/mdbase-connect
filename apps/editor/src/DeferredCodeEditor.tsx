import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { lazy, Suspense, type ComponentProps } from "react";

const CodeEditor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })));

export function DeferredCodeEditor(props: ComponentProps<typeof CodeEditor>) {
  useLingui();
  return <Suspense fallback={<div className={["code-editor-loading", props.className].filter(Boolean).join(" ")}
    role="status" aria-label={t`Loading note editor`} aria-busy="true"><Trans>Preparing editor…</Trans></div>}>
    <CodeEditor {...props} />
  </Suspense>;
}
