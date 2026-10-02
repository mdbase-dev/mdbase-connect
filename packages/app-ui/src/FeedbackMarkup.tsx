import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "./Dialog.js";
import { screenshotFromCanvas, screenshotUrl, type FeedbackScreenshot } from "./feedback-data.js";

type Point = { x: number; y: number };
type Tool = "draw" | "highlight" | "blackout";
export interface FeedbackMark { tool: Tool; points: Point[] }

/** Redactions render last and replace whole pixels. Export is a flattened raster, never layers. */
export function paintFeedbackMarks(context: CanvasRenderingContext2D, image: CanvasImageSource, marks: readonly FeedbackMark[]): void {
  const { width, height } = context.canvas;
  context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0);
  for (const mark of [...marks.filter((m) => m.tool !== "blackout"), ...marks.filter((m) => m.tool === "blackout")]) {
    const first = mark.points[0], last = mark.points.at(-1);
    if (!first || !last) continue;
    context.save();
    if (mark.tool === "draw") {
      context.strokeStyle = "#df3c32"; context.lineWidth = Math.max(3, width / 360); context.lineCap = "round"; context.lineJoin = "round";
      context.beginPath(); context.moveTo(first.x, first.y);
      for (const point of mark.points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    } else {
      const x = Math.floor(Math.min(first.x, last.x)), y = Math.floor(Math.min(first.y, last.y));
      context.fillStyle = mark.tool === "blackout" ? "#000" : "rgba(255, 214, 48, .42)";
      context.fillRect(x, y, Math.ceil(Math.max(first.x, last.x)) - x, Math.ceil(Math.max(first.y, last.y)) - y);
    }
    context.restore();
  }
}
export function FeedbackMarkup({ screenshot, onApply, onClose }: { screenshot: FeedbackScreenshot; onApply(screenshot: FeedbackScreenshot): void; onClose(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const marks = useRef<FeedbackMark[]>([]);
  const current = useRef<FeedbackMark | null>(null);
  const cursor = useRef<Point | null>(null);
  const [tool, setTool] = useState<Tool>("draw");
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const instructions = useId();
  function paint(showCursor = true) {
    const context = canvas.current?.getContext("2d");
    if (!context || !image.current) return;
    paintFeedbackMarks(context, image.current, current.current ? [...marks.current, current.current] : marks.current);
    if (showCursor && cursor.current) {
      context.strokeStyle = "#1267ad"; context.lineWidth = 2;
      context.beginPath(); context.arc(cursor.current.x, cursor.current.y, 7, 0, Math.PI * 2); context.stroke();
    }
  }
  useEffect(() => {
    let live = true;
    const decoded = new Image(); decoded.src = screenshotUrl(screenshot);
    void decoded.decode().then(() => {
      if (!live || !canvas.current) return;
      image.current = decoded; canvas.current.width = decoded.naturalWidth; canvas.current.height = decoded.naturalHeight;
      paint(); setReady(true);
    }).catch(() => { if (live) setError("The screenshot could not be opened for markup."); });
    return () => { live = false; image.current = null; marks.current = []; current.current = null; };
  }, [screenshot]);
  function finish() {
    if (current.current && current.current.points.length > 1 && marks.current.length < 100) marks.current.push(current.current);
    current.current = null; setCount(marks.current.length); paint();
  }
  function coordinate(clientX: number, clientY: number): Point {
    const element = canvas.current!; const rect = element.getBoundingClientRect();
    return { x: Math.max(0, Math.min(element.width, (clientX - rect.left) * element.width / rect.width)), y: Math.max(0, Math.min(element.height, (clientY - rect.top) * element.height / rect.height)) };
  }
  return <Dialog open onClose={onClose} closeDisabled={busy} title="Mark up screenshot" className="mdbase-feedback-markup">
    <div className="mdbase-feedback-tools" role="group" aria-label="Screenshot tools">
      {(["draw", "highlight", "blackout"] as const).map((value) => <button type="button" key={value} aria-pressed={tool === value} disabled={!ready || busy} onClick={() => { current.current = null; setTool(value); paint(); }}>{value === "draw" ? "Draw" : value === "highlight" ? "Highlight" : "Blackout"}</button>)}
      <button type="button" disabled={!count || busy} onClick={() => { current.current = null; marks.current.pop(); setCount(marks.current.length); paint(); }}>Undo</button>
      <button type="button" disabled={!count || busy} onClick={() => { current.current = null; marks.current = []; setCount(0); paint(); }}>Reset</button>
    </div>
    <div className="mdbase-feedback-canvas"><canvas ref={canvas} tabIndex={0} aria-label="Screenshot annotation canvas" aria-describedby={instructions}
      onPointerDown={(event) => {
        if (!ready || busy || event.button !== 0) return;
        if (marks.current.length >= 100) { setError("Up to 100 marks can be applied. Undo or reset to make another mark."); return; }
        cursor.current = null; event.currentTarget.setPointerCapture(event.pointerId);
        current.current = { tool, points: [coordinate(event.clientX, event.clientY)] };
      }}
      onPointerMove={(event) => { if (current.current && event.currentTarget.hasPointerCapture(event.pointerId) && current.current.points.length < 2000) { current.current.points.push(coordinate(event.clientX, event.clientY)); paint(); } }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { current.current?.points.push(coordinate(event.clientX, event.clientY)); finish(); event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={() => { current.current = null; paint(); }}
      onKeyDown={(event) => {
        if (!ready || busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(event.key)) return;
        event.preventDefault();
        cursor.current ??= { x: event.currentTarget.width / 2, y: event.currentTarget.height / 2 };
        if (event.key === " " || event.key === "Enter") {
          if (current.current) { current.current.points.push({ ...cursor.current }); finish(); }
          else if (marks.current.length < 100) current.current = { tool, points: [{ ...cursor.current }] };
          else setError("Up to 100 marks can be applied. Undo or reset to make another mark.");
        } else {
          const step = event.shiftKey ? 50 : 10;
          cursor.current.x = Math.max(0, Math.min(event.currentTarget.width, cursor.current.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0)));
          cursor.current.y = Math.max(0, Math.min(event.currentTarget.height, cursor.current.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0)));
          if (current.current && current.current.points.length < 2000) current.current.points.push({ ...cursor.current });
        }
        paint();
      }} /></div>
    <p id={instructions} className="mdbase-feedback-help">Drag to mark. Keyboard: arrows move; Space starts or finishes. Blackout removes pixels.</p>
    <span className="mdbase-feedback-sr-only" role="status">{count} marks applied.</span>
    {error && <p role="alert">{error}</p>}
    <div className="mdbase-feedback-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="mdbase-feedback-primary" disabled={!ready || busy} onClick={() => {
      if (!canvas.current) return;
      finish(); paint(false); setBusy(true); setError("");
      void screenshotFromCanvas(canvas.current).then(onApply).catch((reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : "The screenshot could not be saved."); });
    }}>{busy ? "Applying…" : "Apply changes"}</button></div>
  </Dialog>;
}
