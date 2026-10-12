import type { MdbaseSetupPlan, MdbaseSetupPlanOptions } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { useEffect, useState, type JSX } from "react";

import { actionNotice, problemControl, type CollectionNotice } from "./model.js";
import { ActionButton, NoticeBlock } from "./parts.js";
import type { CollectionUi } from "./use-collection-ui.js";

type State =
  | { readonly status: "planning"; readonly notice: CollectionNotice | null }
  | { readonly status: "ready"; readonly plan: MdbaseSetupPlan; readonly notice: CollectionNotice | null }
  | { readonly status: "failed"; readonly notice: CollectionNotice | null };

/**
 * Reviewable setup: `setup.plan()` (read-only, so it starts at once), then
 * `setup.apply(plan)` only from the person's click. Never configures silently.
 */
export function SetupReview({ ui }: { readonly ui: CollectionUi }): JSX.Element {
  const { mdbase } = ui.options;
  const [state, setState] = useState<State>({ status: "planning", notice: null });
  const [request, setRequest] = useState<{ readonly options: MdbaseSetupPlanOptions; readonly notice: CollectionNotice | null }>({ options: {}, notice: null });
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    mdbase.setup.plan({ ...request.options, signal: controller.signal }).then(
      (plan) => { if (!controller.signal.aborted) setState({ status: "ready", plan, notice: request.notice }); },
      (cause: unknown) => { if (!controller.signal.aborted) setState({ status: "failed", notice: actionNotice(describeError(cause)) }); },
    );
    return () => controller.abort();
  }, [mdbase, request]);

  const replan = (options: MdbaseSetupPlanOptions, notice: CollectionNotice | null = null): void => {
    setState({ status: "planning", notice: null });
    setRequest({ options, notice });
  };

  const apply = (plan: MdbaseSetupPlan): void => {
    setApplying(true);
    mdbase.setup.apply(plan).then((result) => {
      setApplying(false);
      if (result.outcome === "changed") replan(request.options, actionNotice(describeError("setup_changed")));
    }, (cause: unknown) => {
      setApplying(false);
      const notice = actionNotice(describeError(cause));
      setState((current) => current.status === "ready" ? { ...current, notice } : current);
    });
  };

  if (state.status === "planning") {
    return <p className="mdbase-collections-progress" role="status"><span className="mdbase-collections-spinner" aria-hidden="true" />{ui.copy.setupChecking}</p>;
  }
  if (state.status === "failed") {
    return <div className="mdbase-collections-setup">
      {state.notice && <NoticeBlock notice={state.notice} ui={ui} />}
      <div className="mdbase-collections-actions">
        <ActionButton tone="primary" onClick={() => replan(request.options)}>{ui.copy.tryAgain}</ActionButton>
      </div>
    </div>;
  }
  const { plan } = state;
  const refusal = plan.refusal ? describeError(plan.refusal.code) : null;
  const refusalNotice: CollectionNotice | null = refusal
    ? { ...actionNotice(refusal)!, control: problemControl(refusal, { collectionId: null, signedIn: true, open: true }) }
    : null;
  const nothing = plan.status === "current" || (plan.changes.length === 0 && plan.conflicts.length === 0);
  const adoptable = Object.keys(plan.adoptable).length > 0;
  return <div className="mdbase-collections-setup">
    {state.notice && <NoticeBlock notice={state.notice} ui={ui} variant="inline" />}
    {refusalNotice ? <NoticeBlock notice={refusalNotice} ui={ui} /> : <p className="mdbase-collections-setup-summary">{nothing ? ui.copy.setupNothing : plan.summary}</p>}
    {plan.changes.length > 0 && <section className="mdbase-collections-setup-section">
      <h3>{ui.copy.setupChanges}</h3>
      <ul className="mdbase-collections-setup-list">{plan.changes.map((change) => <li key={`${change.kind}:${change.target}`}>{change.message}</li>)}</ul>
    </section>}
    {plan.conflicts.length > 0 && <section className="mdbase-collections-setup-section">
      <h3>{ui.copy.setupConflicts}</h3>
      <ul className="mdbase-collections-setup-list">{plan.conflicts.map((conflict) => <li key={conflict.target}>{conflict.message}</li>)}</ul>
    </section>}
    <div className="mdbase-collections-actions">
      {!refusal && plan.canApply && <ActionButton tone="primary" progress={applying ? ui.copy.setupApplying : null} onClick={() => apply(plan)}>
        {nothing ? ui.copy.setupContinue : ui.copy.setupApply}
      </ActionButton>}
      {adoptable && <ActionButton tone="secondary" inert={applying} onClick={() => replan({ ...request.options, adopt: plan.adoptable })}>
        {ui.say("setupUseAppVersion")}
      </ActionButton>}
    </div>
  </div>;
}
