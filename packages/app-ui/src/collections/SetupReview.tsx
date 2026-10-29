import type { MdbaseSetupPlan, MdbaseSetupPlanOptions } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";

import { actionNotice, problemControl, type CollectionNotice } from "./model.js";
import { ActionButton, NoticeBlock } from "./parts.js";
import type { CollectionUi } from "./use-collection-ui.js";

type State =
  | { readonly status: "planning"; readonly notice: CollectionNotice | null }
  | { readonly status: "ready"; readonly plan: MdbaseSetupPlan; readonly notice: CollectionNotice | null }
  | { readonly status: "failed"; readonly notice: CollectionNotice | null };

/** Quiet re-plans after a transient refusal (about a minute in all). */
const TRANSIENT_REPLANS = 15;

interface PlanRequest {
  readonly options: MdbaseSetupPlanOptions;
  readonly notice: CollectionNotice | null;
  /** Keep the current review on screen while planning; a failure keeps it too. */
  readonly quiet: boolean;
}

/**
 * Reviewable setup: `setup.plan()` (read-only, so it starts at once), then
 * `setup.apply(plan)` only from the person's click. Never configures silently.
 */
export function SetupReview({ ui }: { readonly ui: CollectionUi }): JSX.Element {
  const { mdbase } = ui.options;
  const [state, setState] = useState<State>({ status: "planning", notice: null });
  const [request, setRequest] = useState<PlanRequest>({ options: {}, notice: null, quiet: false });
  const [applying, setApplying] = useState(false);
  const applyingNow = useRef(false);
  const shown = useRef(state.status);
  shown.current = state.status;

  // Readiness re-checks whenever the collection changes (in another tab, or in
  // the person's own editor). A review planned before that change can be stale:
  // a restored type may now be upgradable, or a refusal resolved. Plan again,
  // quietly, each time a re-check settles; an apply in flight owns the screen.
  const checking = useSyncExternalStore(mdbase.subscribe, () => mdbase.getSnapshot().readiness.checking);
  const wasChecking = useRef(checking);
  useEffect(() => {
    const settled = wasChecking.current && !checking;
    wasChecking.current = checking;
    // Only a review on screen is kept: planning or a failure plans again plainly.
    if (settled && !applyingNow.current) setRequest((current) => ({ ...current, quiet: shown.current === "ready" }));
  }, [checking]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A transient refusal (another tab is finishing setup, the SDK is busy)
    // clears by itself: plan again quietly, with backoff, before giving up.
    const attempt = (n: number): void => {
      mdbase.setup.plan({ ...request.options, signal: controller.signal }).then(
        (plan) => {
          if (controller.signal.aborted) return;
          setState((current) => ({ status: "ready", plan, notice: request.quiet ? current.notice : request.notice }));
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          const described = describeError(cause);
          if (request.quiet) return;
          if (described?.transient && n < TRANSIENT_REPLANS) {
            timer = setTimeout(() => attempt(n + 1), described.retryAfterMs ?? Math.min(500 * 2 ** n, 5000));
            return;
          }
          setState({ status: "failed", notice: actionNotice(described) });
        },
      );
    };
    attempt(0);
    return () => { controller.abort(); if (timer !== null) clearTimeout(timer); };
  }, [mdbase, request]);

  const replan = (options: MdbaseSetupPlanOptions, notice: CollectionNotice | null = null): void => {
    setState({ status: "planning", notice: null });
    setRequest({ options, notice, quiet: false });
  };

  // Nothing here can change the collection: check it again, then plan again,
  // after the person has fixed it elsewhere. Readiness may open it outright.
  const recheck = (): void => {
    void ui.actions.track("assess", () => mdbase.assess()).then(() => replan(request.options), () => {});
  };

  const apply = (plan: MdbaseSetupPlan): void => {
    setApplying(true);
    applyingNow.current = true;
    mdbase.setup.apply(plan).then((result) => {
      setApplying(false);
      applyingNow.current = false;
      if (result.outcome === "changed") replan(request.options, actionNotice(describeError("setup_changed")));
    }, (cause: unknown) => {
      setApplying(false);
      applyingNow.current = false;
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
  const applicable = !refusal && plan.canApply;
  // NoticeBlock shows a refusal's own control, except `set_up` (this is setup).
  const refusalActs = !!refusalNotice?.control && refusalNotice.control.kind !== "set_up";
  // Never leave the review without a way forward.
  const stuck = !applicable && !adoptable && !refusalActs;
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
      {applicable && <ActionButton tone="primary" progress={applying ? ui.copy.setupApplying : null} onClick={() => apply(plan)}>
        {nothing ? ui.copy.setupContinue : ui.copy.setupApply}
      </ActionButton>}
      {adoptable && <ActionButton tone="secondary" inert={applying} onClick={() => replan({ ...request.options, adopt: plan.adoptable })}>
        {ui.say("setupUseAppVersion")}
      </ActionButton>}
      {stuck && <ActionButton tone="primary" inert={ui.busy !== null} progress={ui.busy === "assess" ? ui.copy.setupChecking : null} onClick={recheck}>
        {ui.copy.tryAgain}
      </ActionButton>}
    </div>
  </div>;
}
