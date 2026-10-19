import { useEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode, type RefObject } from "react";

import type { MdbaseAppId } from "./apps.js";
import { MdbaseMark, Wordmark } from "./brand.js";
import { FLOCK_TIMING, flockFrame } from "./flock.js";

/**
 * What an app shows while it opens a collection: its wordmark, scanning, and a quiet line
 * saying what it is waiting for. A failure keeps the same place, shakes the mark once and
 * offers a retry.
 *
 * With `entrance="flock"` it is the launch screen: a 42px mark that the flock flies onto
 * from the edges of the screen, once per page, before it starts scanning. Pair it with
 * `useLaunchEntrancePlaying()` so a fast open does not cut the entrance off.
 */
export function OpeningScreen(props: {
  /** A built-in app wordmark, or the name of an independent collection app. */
  readonly app: MdbaseAppId | { readonly name: string; readonly mark?: ReactNode };
  /** Embedded gates must not add a second main landmark. */
  readonly layout?: "page" | "panel" | undefined;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly error?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly entrance?: "flock" | undefined;
}): JSX.Element {
  if (props.entrance === "flock" && typeof props.app === "string") return <LaunchScreen {...props} app={props.app} />;
  const { app, title, detail, error, onRetry } = props;
  const Container = props.layout === "panel" ? "div" : "main";
  return <Container className="mdbase-opening" data-loading-state={error ? "failed" : "opening"} aria-label={title} aria-busy={!error}>
    <div className="mdbase-opening-message" role={error ? "alert" : "status"}>
      {typeof app === "string"
        ? <Wordmark app={app} motion="scan" signal={error ? openingFailed : null} />
        : <span className="wordmark">
          <span className="wordmark-mark mdbase-motion-scan" aria-hidden="true">{app.mark ?? <MdbaseMark signal={error ? openingFailed : null} />}</span>
          <span className="wordmark-label">{app.name}</span>
        </span>}
      <div>
        <p>{error ?? title}</p>
        {!error && detail && <small>{detail}</small>}
      </div>
      {error && onRetry && <button type="button" className="mdbase-button" onClick={onRetry}>Try again</button>}
    </div>
  </Container>;
}

const openingFailed = { kind: "error", id: 1 } as const;

function LaunchScreen({ app, title, detail, error, onRetry }: {
  readonly app: MdbaseAppId;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly error?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
}): JSX.Element {
  const markHost = useRef<HTMLSpanElement>(null);
  const { flying, canvas } = useFlockEntrance(markHost);
  return <main
    className="mdbase-opening mdbase-opening-launch"
    data-loading-state={error ? "failed" : "opening"}
    data-entrance={flying ? "flying" : "landed"}
    aria-label={title}
    aria-busy={!error}
  >
    <div className="mdbase-opening-message" role={error ? "alert" : "status"}>
      <span ref={markHost} className="mdbase-opening-launch-mark">
        {/* Editor carries the platform mark; other apps carry their own, as in the wordmark. */}
        <MdbaseMark
          app={app === "editor" ? undefined : app}
          motion={flying || error ? undefined : "scan"}
          signal={error ? openingFailed : null}
        />
      </span>
      <div className="mdbase-opening-launch-text">
        <p>{error ?? title}</p>
        {!error && detail && <small>{detail}</small>}
      </div>
      {error && onRetry && <button type="button" className="mdbase-button" onClick={onRetry}>Try again</button>}
    </div>
    {canvas}
  </main>;
}

/**
 * The screen before a collection is open: the app's wordmark, a headline, what the app will
 * do, what went wrong if anything, and then the actions (children) for connecting. A status
 * and an error that say the same thing are said once; technical detail waits behind a
 * disclosure.
 */
export function ConnectLayout({ app, title, lead, status, error, detail, footnote, children }: {
  readonly app: MdbaseAppId;
  readonly title: ReactNode;
  readonly lead?: ReactNode | undefined;
  readonly status?: string | null | undefined;
  readonly error?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly footnote?: ReactNode | undefined;
  readonly children?: ReactNode | undefined;
}): JSX.Element {
  return <main className="mdbase-connect-screen">
    <section>
      <Wordmark app={app} motion="assemble" />
      <h1>{title}</h1>
      {lead && <p className="mdbase-connect-lead">{lead}</p>}
      {status && status !== error && <p className="mdbase-connect-status" role="status">{status}</p>}
      {error && <p className="mdbase-connect-error" role="alert">{error}</p>}
      {detail && <details className="mdbase-connect-detail"><summary>Details</summary><code>{detail}</code></details>}
      {children}
      {footnote && <p className="mdbase-connect-footnote">{footnote}</p>}
    </section>
  </main>;
}

/**
 * The launch entrance plays once per page: the first opening screen that asks for it
 * flies the flock in, and every later one shows the mark straight away.
 */
type LaunchState = "idle" | "playing" | "done";

let state: LaunchState = "idle";
let startedAt = 0;
let fallback: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(next: LaunchState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Starts the entrance, or returns when the running one started; null once it is over. */
function beginLaunchEntrance(): number | null {
  if (state === "done") return null;
  if (state === "idle") {
    startedAt = performance.now();
    publish("playing");
    // Frames stop in a background tab; the entrance must still end so the app is never held.
    fallback = setTimeout(finishLaunchEntrance, (FLOCK_TIMING.end + 0.5) * 1000);
  }
  return startedAt;
}

function finishLaunchEntrance(): void {
  clearTimeout(fallback);
  publish("done");
}

/** Whether the launch entrance can play here: a real browser, motion allowed, page in view. */
function launchEntranceEligible(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    && !document.hidden;
}

/**
 * True while the launch entrance is flying. An app that opens quickly keeps its
 * opening screen until this is false, so the entrance is never cut off mid-flight;
 * it lasts at most two seconds.
 */
export function useLaunchEntrancePlaying(): boolean {
  return useSyncExternalStore(subscribe, () => state === "playing", () => false);
}

/**
 * Flies the flock onto the mark inside `target` and reports whether it is still flying.
 * While it flies, the caller hides its real mark; the last frame is drawn from the same
 * rectangles, so the hand-over is seamless.
 */
function useFlockEntrance(target: RefObject<HTMLElement | null>): {
  flying: boolean;
  canvas: JSX.Element | null;
} {
  const [eligible] = useState(() => state !== "done" && launchEntranceEligible());
  const launch = useSyncExternalStore(subscribe, () => state, () => "idle" as LaunchState);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flying = eligible && launch !== "done";

  useEffect(() => {
    if (!eligible) {
      // Nothing played here, and nothing should play later out of context.
      if (state === "idle") publish("done");
      return;
    }
    const started = beginLaunchEntrance();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (started === null || !canvas || !context) return finishLaunchEntrance();

    let frame = 0;
    const draw = (): void => {
      const t = (performance.now() - started) / 1000;
      const mark = target.current?.querySelector("svg");
      if (t >= FLOCK_TIMING.end || !mark) return finishLaunchEntrance();
      const box = mark.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      // The mark's own colours, so app marks keep their inverted palette.
      const ink = getComputedStyle(mark.querySelector(".mdbase-mark-ink") ?? mark).fill;
      const accent = getComputedStyle(mark.querySelector(".mdbase-mark-accent") ?? mark).fill;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const { birds, bars } = flockFrame({
        width,
        height,
        markLeft: box.left,
        markTop: box.top,
        markSize: Math.min(box.width, box.height)
      }, t);
      for (const rect of [...birds, ...bars]) {
        context.fillStyle = rect.accent ? accent : ink;
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [eligible, target]);

  return {
    flying,
    canvas: flying ? <canvas ref={canvasRef} className="mdbase-opening-flock" aria-hidden="true" /> : null
  };
}
