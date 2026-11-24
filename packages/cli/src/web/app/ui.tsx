/** @jsxImportSource preact */
/** Small pieces every screen uses: the dialog, the notice, a time and a status chip. */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../../tui/session";

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  actions: ComponentChildren;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props.onClose]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, from the listener above
    // biome-ignore lint/a11y/noStaticElementInteractions: a tap outside the dialog closes it
    <div class="backdrop" onClick={props.onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only keeps a tap inside from closing it */}
      <div
        class="modal"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{props.title}</h2>
        <div class="modal-body">{props.children}</div>
        <div class="modal-actions">{props.actions}</div>
      </div>
    </div>
  );
}

export function Toast(props: { text: string; ok: boolean }) {
  return <div class={`toast ${props.ok ? "ok" : "bad"}`}>{props.text}</div>;
}

const STATUS_LABEL: Record<Session["status"], string> = {
  waiting: "waits for you",
  running: "running",
  failed: "failed",
  done: "done",
  canceled: "canceled",
  unreadable: "unreadable",
};

export function StatusChip(props: { status: Session["status"]; label?: string }) {
  return <span class={`chip st-${props.status}`}>{props.label ?? STATUS_LABEL[props.status]}</span>;
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function clock(ts: number | undefined): string {
  if (ts === undefined) return "";
  const d = new Date(ts);
  const same = new Date().toDateString() === d.toDateString();
  return same
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Text written by an agent or a command: shown as it is, never as markup. */
export function Prose(props: { text: string; class?: string }) {
  return <div class={`prose ${props.class ?? ""}`}>{props.text}</div>;
}

/** A text box that takes the focus once, when it appears. */
export function TextBox(props: {
  value: string;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <textarea
      ref={box}
      rows={5}
      value={props.value}
      placeholder={props.placeholder}
      onInput={(e) => props.onInput((e.target as HTMLTextAreaElement).value)}
    />
  );
}

/** Which bands are folded, kept on this device; a page that cannot keep it uses the defaults. */
const FOLDED_KEY = "kodel.folds";
const folds: Record<string, boolean> = (() => {
  try {
    return JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
})();

export function useFold(id: string, foldedByDefault = false): [boolean, () => void] {
  const [folded, setFolded] = useState(folds[id] ?? foldedByDefault);
  const toggle = () => {
    const next = !folded;
    folds[id] = next;
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify(folds));
    } catch {
      // Kept for this page only.
    }
    setFolded(next);
  };
  return [folded, toggle];
}

/** A grey band with a title that folds what is under it. */
export function Fold(props: {
  id: string;
  title: ComponentChildren;
  aside?: ComponentChildren;
  folded?: boolean;
  children: ComponentChildren;
}) {
  const [folded, toggle] = useFold(props.id, props.folded);
  return (
    <section>
      <button type="button" class="band" aria-expanded={!folded} onClick={toggle}>
        <span class={`fold ${folded ? "" : "open"}`} aria-hidden="true" />
        <span class="band-title">{props.title}</span>
        {props.aside !== undefined ? <span>{props.aside}</span> : null}
      </button>
      {folded ? null : props.children}
    </section>
  );
}
