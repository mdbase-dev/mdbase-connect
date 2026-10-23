import { t } from "@lingui/core/macro";
import { useLocaleRevision } from "./i18n.js";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FeedbackMarkup } from "./FeedbackMarkup.js";
import { FeedbackVerification } from "./FeedbackVerification.js";
import {
  FEEDBACK_ERROR_CODES, FEEDBACK_MAX_MESSAGE_LENGTH, captureFeedbackScreenshot, feedbackDiagnostics, feedbackEvents, feedbackTopics,
  readFeedbackScreenshot, resolveFeedbackEndpoint, screenshotUrl, sendFeedback,
  type FeedbackApplication, type FeedbackDiagnosticEvent, type FeedbackFailure, type FeedbackScreenshot, type FeedbackSubmission, type FeedbackTopic
} from "./feedback-data.js";
export { feedbackApplication, resolveFeedbackEndpoint } from "./feedback-data.js";
export type { FeedbackApplication, FeedbackFailure, FeedbackErrorCode, FeedbackTopic } from "./feedback-data.js";

interface FeedbackControls {
  enabled: boolean;
  open: (topic?: FeedbackTopic) => void;
  /** Call only for a user-visible failure, never background retries. Pass codes, not raw exceptions. */
  reportError: (failure: FeedbackFailure) => void;
  wiggle: number;
}
const FeedbackContext = createContext<FeedbackControls | null>(null);
const disabledFeedback: FeedbackControls = { enabled: false, open() {}, reportError() {}, wiggle: 0 };
export function useFeedback(): FeedbackControls { return useContext(FeedbackContext) ?? disabledFeedback; }

export function FeedbackBug({ wiggle = 0 }: { wiggle?: number }) {
  useLocaleRevision();
  return <svg key={wiggle} className={`mdbase-feedback-bug${wiggle ? " is-wiggling" : ""}`} viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 23 8 19l-3 2m10 8H6l-2 3m12 3-7 4v3m23-19 8-4 3 2m-10 8h9l2 3m-12 3 7 4v3M20 13l-4-6-4 1m16 5 4-6 4 1" />
    <ellipse cx="24" cy="29" rx="10" ry="12" /><ellipse cx="24" cy="16" rx="7" ry="6" /><path d="M24 22v17" /><circle cx="21" cy="15" r="1.5" fill="currentColor" stroke="none" /><circle cx="27" cy="15" r="1.5" fill="currentColor" stroke="none" />
  </svg>;
}
export function FeedbackButton({ className, topic }: { className?: string; topic?: FeedbackTopic }) {
  useLocaleRevision();
  const feedback = useFeedback();
  if (!feedback.enabled) return null;
  return <button type="button" className={["mdbase-feedback-trigger", className].filter(Boolean).join(" ")} onClick={() => feedback.open(topic)}><FeedbackBug wiggle={feedback.wiggle} /><span>{topic === "problem" ? t({ message: "Report a problem" }) : t({ message: "Send feedback" })}</span></button>;
}

/** One per application shell. No Connect/auth dependency; drafts live only in this mounted provider. */
export function FeedbackProvider({ endpoint: configuredEndpoint, application, turnstileSiteKey, collectionName, children }: {
  endpoint: string | null;
  application: FeedbackApplication;
  turnstileSiteKey?: string | null;
  collectionName?: string;
  children: ReactNode;
}) {
  useLocaleRevision();
  const endpoint = resolveFeedbackEndpoint(configuredEndpoint ?? undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const events = useRef<FeedbackDiagnosticEvent[]>([]);
  const lastWiggle = useRef(-Infinity);
  const imageOperation = useRef<AbortController | null>(null);
  const submissionOperation = useRef<AbortController | null>(null);
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const live = useRef(true);
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<FeedbackTopic>("problem");
  const [message, setMessage] = useState("");
  const [replyEmail, setReplyEmail] = useState("");
  const [includeCollection, setIncludeCollection] = useState(false);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ReturnType<typeof feedbackDiagnostics> | null>(null);
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot | null>(null);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [markup, setMarkup] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureStatus, setCaptureStatus] = useState("");
  const [screenshotError, setScreenshotError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<FeedbackTopic | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const [wiggle, setWiggle] = useState(0);
  const id = useId();

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; imageOperation.current?.abort(); submissionOperation.current?.abort(); if (content.current) content.current.inert = false; };
  }, []);
  useLayoutEffect(() => { setIncludeCollection(false); }, [collectionName]);
  useEffect(() => {
    if (!wiggle) return;
    const timer = setTimeout(() => setWiggle(0), 600);
    return () => clearTimeout(timer);
  }, [wiggle]);
  const openFeedback = useCallback((next?: FeedbackTopic) => {
    if (!endpoint) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (next) setTopic(next);
    setDiagnostics(feedbackDiagnostics(events.current)); setOpen(true);
  }, [endpoint]);
  const reportError = useCallback((failure: FeedbackFailure) => {
    if (!endpoint || failure.code === "cancelled") return;
    if (!FEEDBACK_ERROR_CODES.includes(failure.code) || (failure.status !== undefined && (!Number.isInteger(failure.status) || failure.status < 100 || failure.status > 599))) throw new TypeError("Feedback failures must contain a bounded error code and HTTP status only.");
    const event = { at: new Date().toISOString(), code: failure.code, ...(failure.status === undefined ? {} : { status: failure.status }) };
    events.current = feedbackEvents([...events.current, event]);
    if (document.visibilityState === "visible" && performance.now() - lastWiggle.current >= 30_000) { lastWiggle.current = performance.now(); setWiggle((value) => value + 1); }
  }, [endpoint]);
  const controls = useMemo(() => ({ enabled: Boolean(endpoint), open: openFeedback, reportError, wiggle }), [endpoint, openFeedback, reportError, wiggle]);
  useLayoutEffect(() => {
    if (!dialog.current) return;
    if (open && !capturing) {
      if (!dialog.current.open) dialog.current.showModal();
      if (submitted) successHeading.current?.focus({ preventScroll: true });
      else messageField.current?.focus({ preventScroll: true });
    } else if (dialog.current.open) dialog.current.close();
  }, [open, capturing, submitted]);
  function resetDraft() {
    setTopic("problem"); setMessage(""); setReplyEmail(""); setIncludeCollection(false); setIncludeDiagnostics(false);
    setScreenshot(null); setIncludeScreenshot(true); setSubmitted(null); setSubmitError(""); setScreenshotError(""); setCaptureStatus("");
    attempt.current = null;
  }
  function close() {
    if (submitting) return;
    imageOperation.current?.abort(); imageOperation.current = null;
    setCapturing(false); setImageBusy(false); setMarkup(false); setOpen(false);
    setTurnstileToken(""); setVerificationAttempt((value) => value + 1);
    if (submitted) resetDraft();
    dialog.current?.close();
    trigger.current?.focus({ preventScroll: true });
  }
  async function capture() {
    if (imageOperation.current || submitting) return;
    const controller = new AbortController(); imageOperation.current = controller;
    const scroll = body.current?.scrollTop ?? 0;
    setImageBusy(true); setCapturing(true); setScreenshotError(""); setCaptureStatus("");
    // Close synchronously, before either the picker or capture stream sees this native modal.
    dialog.current?.close(); if (content.current) content.current.inert = true;
    try {
      const next = await captureFeedbackScreenshot(controller.signal);
      if (!controller.signal.aborted && live.current) { setScreenshot(next); setIncludeScreenshot(true); setCaptureStatus(t({ message: "Screenshot captured. Sharing has stopped." })); }
    } catch (reason) {
      if (!controller.signal.aborted && live.current) {
        if (reason instanceof DOMException && (reason.name === "NotAllowedError" || reason.name === "AbortError")) setCaptureStatus(t({ message: "No screenshot taken. You can still send feedback." }));
        else setScreenshotError(reason instanceof Error ? reason.message : t({ message: "The screenshot could not be captured." }));
      }
    } finally {
      if (imageOperation.current === controller) imageOperation.current = null;
      if (content.current) content.current.inert = false;
      if (!controller.signal.aborted && live.current) {
        setCapturing(false); setImageBusy(false);
        if (dialog.current && !dialog.current.open) dialog.current.showModal();
        if (body.current) body.current.scrollTop = scroll;
      }
    }
  }
  async function upload(file: File) {
    if (imageOperation.current || submitting) return;
    const controller = new AbortController(); imageOperation.current = controller;
    setImageBusy(true); setScreenshotError(""); setCaptureStatus("");
    try {
      const next = await readFeedbackScreenshot(file);
      if (!controller.signal.aborted && live.current) { setScreenshot(next); setIncludeScreenshot(true); }
    } catch (reason) {
      if (!controller.signal.aborted && live.current) setScreenshotError(reason instanceof Error ? reason.message : t({ message: "The screenshot could not be read." }));
    } finally {
      if (imageOperation.current === controller) imageOperation.current = null;
      if (!controller.signal.aborted && live.current) setImageBusy(false);
    }
  }
  async function submit() {
    if (!endpoint || !message.trim() || imageOperation.current || submissionOperation.current || (turnstileSiteKey && !turnstileToken)) return;
    const payload = {
      schema_version: 2 as const, application, topic, message: message.trim(),
      ...(replyEmail.trim() ? { reply_email: replyEmail.trim() } : {}),
      ...(includeCollection && collectionName ? { context: { collection_name: collectionName } } : {}),
      ...(topic === "problem" && includeDiagnostics && diagnostics ? { diagnostics } : {}),
      ...(screenshot && includeScreenshot ? { screenshot } : {})
    };
    const fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: crypto.randomUUID() };
    const submission: FeedbackSubmission = { ...payload, request_id: attempt.current.requestId, ...(turnstileToken ? { turnstile_token: turnstileToken } : {}) };
    const controller = new AbortController(); submissionOperation.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    setSubmitting(true); setSubmitError("");
    try {
      await sendFeedback(endpoint, submission, controller.signal);
      if (live.current) { setSubmitted(topic); setScreenshot(null); }
    } catch (reason) {
      if (live.current) setSubmitError(controller.signal.aborted ? t({ message: "Sending timed out. Please try again." }) : reason instanceof Error ? reason.message : t({ message: "Feedback could not be sent. Please try again." }));
    } finally {
      clearTimeout(timer); submissionOperation.current = null;
      if (live.current) { setSubmitting(false); setTurnstileToken(""); setVerificationAttempt((value) => value + 1); }
    }
  }
  const config = feedbackTopics[topic];
  return <FeedbackContext.Provider value={controls}>
    <div className="mdbase-feedback-app" ref={content}>{children}</div>
    <span className="mdbase-feedback-sr-only" role="status">{wiggle ? t({ message: "A problem occurred. You can use Send feedback to report it." }) : ""}</span>
    {endpoint && <dialog ref={dialog} className="mdbase-feedback-dialog" aria-labelledby={`${id}-title`} onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); close(); }}>
      <header className="mdbase-feedback-header"><h2 id={`${id}-title`}>{t({ message: "Send feedback" })}</h2><button type="button" disabled={submitting} onClick={close} aria-label={t({ message: "Close feedback" })}>×</button></header>
      {submitted ? <section className="mdbase-feedback-success"><h3 ref={successHeading} tabIndex={-1}>{feedbackTopics[submitted].thanks}</h3><p>{t({ message: "Sent privately to the mdbase team." })}</p><button type="button" className="mdbase-feedback-primary" onClick={close}>{t({ message: "Back to your work" })}</button></section> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="mdbase-feedback-body" ref={body}>
          <fieldset className="mdbase-feedback-topics" disabled={submitting}><legend className="mdbase-feedback-sr-only">{t({ message: "Feedback type" })}</legend>{(Object.keys(feedbackTopics) as FeedbackTopic[]).map((value) => <label key={value}><input type="radio" name={`${id}-topic`} checked={topic === value} onChange={() => setTopic(value)} />{feedbackTopics[value].label}</label>)}</fieldset>
          <label className="mdbase-feedback-field"><span>{config.prompt}</span><textarea ref={messageField} required maxLength={FEEDBACK_MAX_MESSAGE_LENGTH} rows={5} placeholder={config.placeholder} value={message} disabled={submitting} onChange={(event) => setMessage(event.target.value)} /></label>
          <label className="mdbase-feedback-field"><span>{t({ message: "Reply email" })} <small>{t({ message: "Optional" })}</small></span><input type="email" maxLength={320} autoComplete="email" placeholder={t({ message: "you@example.com", comment: "Example email address, not user data." })} value={replyEmail} disabled={submitting} onChange={(event) => setReplyEmail(event.target.value)} /></label>
          <div className="mdbase-feedback-screenshot" role="group" aria-label={t({ message: "Screenshot" })}>
            {screenshot && <><button className="mdbase-feedback-preview" type="button" disabled={imageBusy || submitting} onClick={() => { setIncludeScreenshot(false); setMarkup(true); }} aria-label={t({ message: "Mark up screenshot" })}><img src={screenshotUrl(screenshot)} alt={t({ message: "Screenshot attached to your feedback" })} /><span>{t({ message: "Mark up screenshot" })}</span></button><div className="mdbase-feedback-screenshot-actions"><label><input className="mdbase-checkbox" type="checkbox" checked={includeScreenshot} disabled={submitting} onChange={(event) => setIncludeScreenshot(event.target.checked)} />{t({ message: "Include screenshot" })}</label><button type="button" disabled={imageBusy || submitting} onClick={() => { setScreenshot(null); setScreenshotError(""); setCaptureStatus(""); }}>{t({ message: "Remove" })}</button></div></>}
            <div className="mdbase-feedback-screenshot-actions"><button type="button" disabled={imageBusy || submitting} onClick={() => void capture()}>{capturing ? t({ message: "Taking screenshot…" }) : screenshot ? t({ message: "Retake screenshot" }) : t({ message: "Attach screenshot" })}</button><label className="mdbase-feedback-upload"><span>{t({ message: "Choose an image" })}</span><input type="file" accept="image/png,image/jpeg" disabled={imageBusy || submitting} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} /></label></div>
            {screenshot && <p className="mdbase-feedback-help">{t({ message: "Review for private information before sending." })}</p>}
            {captureStatus && <p className="mdbase-feedback-help" role="status">{captureStatus}</p>}{screenshotError && <p className="mdbase-feedback-error" role="alert">{screenshotError}</p>}
          </div>
          <details className="mdbase-feedback-details"><summary>{t({ message: "What gets sent" })}</summary>
            <p className="mdbase-feedback-help">{t({ message: "Your message, any reply email and included screenshot, plus these app and build details." })}</p>
            <pre>{JSON.stringify(application, null, 2)}</pre>
            {collectionName && <label className="mdbase-feedback-check"><input className="mdbase-checkbox" type="checkbox" checked={includeCollection} disabled={submitting} onChange={(event) => setIncludeCollection(event.target.checked)} />{t({ message: "Include collection name:" })} {collectionName}</label>}
            {topic === "problem" && <><label className="mdbase-feedback-check"><input className="mdbase-checkbox" type="checkbox" checked={includeDiagnostics} disabled={submitting} onChange={(event) => setIncludeDiagnostics(event.target.checked)} />{t({ message: "Include technical diagnostics" })}</label><p className="mdbase-feedback-help">{t({ message: "Browser, OS, viewport and recent error codes. No note contents, paths or credentials." })}</p>{includeDiagnostics && <pre>{JSON.stringify(diagnostics, null, 2)}</pre>}</>}
            <p className="mdbase-feedback-help">{t({ message: "Images: PNG or JPEG, up to 3 MB. Blackout replaces pixels; only the final image is attached." })}</p>
            <p className="mdbase-feedback-help">{t({ message: "Replies aren’t guaranteed. Not for security reports or urgent support." })}</p>
          </details>
          {turnstileSiteKey && open && !capturing && <FeedbackVerification key={verificationAttempt} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />}
          {submitError && <p className="mdbase-feedback-error" role="alert">{submitError}</p>}
          <p className="mdbase-feedback-help">{t({ message: "Private feedback to the mdbase team." })}</p>
        </div>
        <footer className="mdbase-feedback-actions"><button type="button" disabled={submitting} onClick={close}>{t({ message: "Cancel" })}</button><button type="submit" className="mdbase-feedback-primary" disabled={submitting || imageBusy || !message.trim() || Boolean(turnstileSiteKey && !turnstileToken)}>{submitting ? t({ message: "Sending…" }) : t({ message: "Send feedback" })}</button></footer>
      </form>}
    </dialog>}
    {markup && screenshot && <FeedbackMarkup screenshot={screenshot} onClose={() => { setMarkup(false); setCaptureStatus(t({ message: "Markup discarded. Screenshot excluded." })); }} onApply={(next) => { setScreenshot(next); setIncludeScreenshot(true); setMarkup(false); setCaptureStatus("Markup applied."); }} />}
  </FeedbackContext.Provider>;
}
