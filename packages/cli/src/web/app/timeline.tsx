/** @jsxImportSource preact */
/**
 * The agent's log the way the agent's own app shows it: what it said, what the person said, and each
 * tool it called as one line that opens to its input and result. A run's log is cut into its steps by
 * the time each step went on; the step at work is open, the others are folded.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { GateDetail, LogEntry } from "../../tui/session";
import { groupsOf, type Notice, noticeOf } from "./groups";
import { Markdown } from "./md";
import { clock, duration, Prose } from "./ui";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function Call(props: { e: LogEntry; live: boolean }) {
  const { e } = props;
  const [open, setOpen] = useState(false);
  const r = e.result;
  const state = r ? (r.ok ? "ok" : "bad") : props.live ? "live" : "none";
  return (
    <div class={`tl-call${open ? " open" : ""}`}>
      <button
        type="button"
        class="tl-call-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class={`tl-mark tl-${state}`} aria-hidden="true" />
        <span class="tl-tool">{e.tool ?? "tool"}</span>
        <span class="tl-arg">{oneLine(e.text)}</span>
        <span class="tl-ms">{r?.ms === undefined ? "" : duration(r.ms)}</span>
      </button>
      {open ? (
        <div class="tl-call-body">
          <pre>{e.text}</pre>
          {r?.text ? <pre class={r.ok ? "" : "t-bad"}>{r.text}</pre> : null}
          {r && !r.text ? <div class="muted">{r.ok ? "Done" : "Failed"}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A key for each entry from what it is, not where it is: a log that grows, loses its oldest entries
 * or gets a subagent's entry in the middle keeps the elements of the entries it already showed.
 */
function keysOf(entries: LogEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const base = `${e.ts}:${e.kind}:${e.tool ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/** A line Claude Code wrote into the conversation: folded, so it does not read as the person's words. */
function NoticeView(props: { n: Notice }) {
  const { n } = props;
  const [open, setOpen] = useState(false);
  const body = n.kind === "task" ? n.result : n.text;
  return (
    <div class={`tl-agent tl-notice${open ? " open" : ""}`}>
      <button
        type="button"
        class="tl-agent-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={body === undefined}
      >
        <span class={`fold ${open ? "open" : ""}`} aria-hidden="true" />
        <span class="tl-agent-name">{n.kind === "task" ? "Background agent" : "Claude Code"}</span>
        <span class="tl-arg">{n.kind === "task" ? n.title : n.tag}</span>
        {n.kind === "task" && n.status ? (
          <span class={n.status === "completed" ? "t-ok tl-ms" : "t-bad tl-ms"}>{n.status}</span>
        ) : null}
      </button>
      {open && body !== undefined ? (
        <div class="tl-agent-body">
          <div class="tl">
            {n.kind === "task" ? <Markdown text={body} /> : <pre class="tl-raw">{body}</pre>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A subagent the agent started: one line that opens to what the subagent said and did. */
function Subagent(props: { e: LogEntry }) {
  const { e } = props;
  const [open, setOpen] = useState(false);
  const own = e.children ?? [];
  const first = own[0]?.ts;
  const last = own.at(-1)?.ts;
  if (own.length === 0) {
    return (
      <div class="tl-sub muted">
        ⤷ <Prose text={oneLine(e.text)} />
      </div>
    );
  }
  return (
    <div class={`tl-agent${open ? " open" : ""}`}>
      <button
        type="button"
        class="tl-agent-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class={`fold ${open ? "open" : ""}`} aria-hidden="true" />
        <span class="tl-agent-name">Subagent</span>
        <span class="tl-arg">{oneLine(e.text)}</span>
        <span class="tl-ms">
          {own.length} · {first !== undefined && last !== undefined ? duration(last - first) : ""}
        </span>
      </button>
      {open ? (
        <div class="tl-agent-body">
          <Entries entries={own} />
        </div>
      ) : null}
    </div>
  );
}

export function Entries(props: { entries: LogEntry[]; live?: boolean }) {
  const last = props.entries.length - 1;
  const keys = keysOf(props.entries);
  return (
    <div class="tl">
      {props.entries.map((e, i) => {
        if (e.kind === "call") {
          return <Call key={keys[i]} e={e} live={props.live === true && i === last} />;
        }
        const notice = e.kind === "you" ? noticeOf(e.text) : undefined;
        if (notice) return <NoticeView key={keys[i]} n={notice} />;
        if (e.kind === "you") {
          return (
            <div key={keys[i]} class="tl-you">
              <Markdown text={e.text} />
            </div>
          );
        }
        if (e.kind === "subagent") return <Subagent key={keys[i]} e={e} />;
        return (
          <div key={keys[i]} class="tl-text">
            <Markdown text={e.text} />
          </div>
        );
      })}
      {props.live ? <div class="tl-working">Working…</div> : null}
    </div>
  );
}

export function AgentTimeline(props: { d: GateDetail; live: boolean; now: number }) {
  const groups = groupsOf(props.d);
  // Open at first: the step at work and the last one the agent said something in. What a step was
  // shown as stays as it was when the log grows: new entries are added, nothing else moves.
  const firstOpen = new Set(
    [
      groups.findLast((g) => g.visit?.state === "running")?.key,
      groups.findLast((g) => g.entries.length > 0)?.key,
    ].filter((k): k is string => k !== undefined),
  );
  const opened = useRef(new Map<string, boolean>());
  for (const g of groups) {
    if (!opened.current.has(g.key)) opened.current.set(g.key, firstOpen.has(g.key));
  }
  const [, redraw] = useState(0);
  const count = props.d.agentLog?.length ?? 0;

  // The screen opens at the newest entry, and follows the log while the person stays at the bottom.
  // Where they are is read as this render begins, while the page still holds the old entries.
  const shown = useRef(false);
  // A run at work opens at its newest entry and follows it; any other run opens at the start of the
  // agent's last message, with what came before above it.
  const box = useRef<HTMLDivElement>(null);
  const first = !shown.current;
  const follow =
    props.live &&
    (first || window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120);
  useLayoutEffect(() => {
    shown.current = true;
    if (follow) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return;
    }
    if (!first) return;
    const said = box.current?.querySelectorAll(".tl-text");
    const last = said?.[said.length - 1];
    if (!last) return;
    // Under the sticky header and tabs, which cover the top of the screen once it scrolls.
    const height = (selector: string) =>
      (document.querySelector(selector) as HTMLElement | null)?.offsetHeight ?? 0;
    const covered = height(".screen.run > .bar") + height(".seg");
    window.scrollTo(0, last.getBoundingClientRect().top + window.scrollY - covered - 8);
  }, [count, groups.length]);

  if (groups.length === 0) {
    return <p class="empty">The agent's log can't be read, or it has not begun yet.</p>;
  }
  return (
    <div ref={box}>
      {groups.map((g) => {
        const open = opened.current.get(g.key) === true;
        const v = g.visit;
        const a = v?.attempt;
        const live = props.live && v?.state === "running";
        const ms =
          a?.ms ?? (live && a?.from !== undefined ? Math.max(0, props.now - a.from) : undefined);
        return (
          <section key={g.key} class="tl-group">
            <button
              type="button"
              class="tl-head"
              aria-expanded={open}
              onClick={() => {
                opened.current.set(g.key, !open);
                redraw((n) => n + 1);
              }}
            >
              <span class={`fold ${open ? "open" : ""}`} aria-hidden="true" />
              <span
                class={`dot dot-${v ? (v.state === "done" || v.state === "failed" || v.state === "running" || v.state === "waiting" ? v.state : "canceled") : "canceled"}`}
              />
              <span class="tl-step">
                {v ? v.slug : g.key === "before" ? "Before the steps" : "Log"}
                {a && a.n > 1 ? <span class="muted"> #{a.n}</span> : null}
              </span>
              <span class="tl-facts">
                {ms !== undefined ? duration(ms) : g.entries[0] ? clock(g.entries[0].ts) : ""}
              </span>
            </button>
            {open ? (
              g.entries.length === 0 ? (
                <div class="tl">
                  <div class="tl-working">
                    {v?.kind === "agent" ? "Working…" : `Running ${v?.kind ?? "the step"}…`}
                  </div>
                </div>
              ) : (
                <Entries entries={g.entries} live={live} />
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
