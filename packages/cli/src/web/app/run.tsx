/** @jsxImportSource preact */
/**
 * One run, read the way a person reads a gate: what is asked on top, then three tabs: what the agent
 * says it did, the review (comments and the code it changed, each diff opening in place), and the
 * history of its steps, each step's log on a page of its own. The decision sits at the bottom.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Comment, DecisionRef, GateDetail, Session, StepLine, Visit } from "../../tui/session";
import { formatAge } from "../../tui/session";
import type { AskRef } from "../ask";
import type { WebDiff, WebDiffRow } from "../handler";
import { ApiError, api, type Me } from "./api";
import { AskNoteSheet, AskPanel } from "./ask";
import { Icon } from "./icons";
import { BlockView, blocksOf, Markdown } from "./md";
import { AgentTimeline, Entries } from "./timeline";
import { duration, Modal, Prose, TextBox } from "./ui";

const SEVERITIES = ["blocker", "critical", "major", "minor", "info"] as const;

type Notify = (text: string, ok: boolean) => void;

/**
 * The log keeps a preview of each message; the report is the agent's last answer whole. The entry that
 * is the start of the report gets its whole text.
 */
function withFullReport(d: GateDetail): GateDetail {
  const log = d.agentLog;
  const full = d.report?.from === "log" ? d.report.text.trim() : undefined;
  if (!log || !full) return d;
  // Compared by their letters and digits: a preview may drop the Markdown marks of the whole.
  const plainOf = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const whole = plainOf(full);
  for (let i = log.length - 1; i >= 0 && i >= log.length - 20; i--) {
    const e = log[i];
    if (e?.kind !== "text") continue;
    const start = plainOf(e.text.replace(/…$/, "")).slice(0, 200);
    if (start.length < 20 || !whole.startsWith(start)) continue;
    if (e.text.length >= full.length) return d;
    const agentLog = [...log];
    agentLog[i] = { ...e, text: full };
    return { ...d, agentLog };
  }
  return d;
}

/** How a run is called: by the agent session it works in, as in the terminal, else by its slug. */
export const nameOf = (s: Session | undefined): string | undefined =>
  s?.agentSession?.name ?? s?.title;

/** Every decision a person can make here; a run of sample data names none, its detail does. */
function refsOf(s: Session | undefined, d: GateDetail | undefined): DecisionRef[] {
  if (s?.decisions !== undefined) return s.decisions;
  if (d?.kind === "gate" && s?.status === "waiting") {
    return [{ kind: "gate", node: d.node, attempt: d.attempt, prompt: d.prompt, command: "" }];
  }
  return [];
}

function tokensText(m: GateDetail["metrics"]): string | undefined {
  if (!m.tokens) return undefined;
  if (m.tokens.cost !== undefined) return `$${m.tokens.cost.toFixed(2)}`;
  const k = m.tokens.total >= 1000 ? `${Math.round(m.tokens.total / 1000)}k` : `${m.tokens.total}`;
  return `${m.tokens.approx ? "~" : ""}${k} tokens`;
}

function StepStrip(props: { steps: StepLine[] }) {
  if (props.steps.length === 0) return null;
  return (
    <div class="strip" role="img" aria-label="Steps of the run">
      {props.steps.map((s, i) => (
        <span key={`${i}:${s.name}`} class={`strip-${s.state}`} title={`${s.name}: ${s.state}`} />
      ))}
    </div>
  );
}

function Lead(props: { s: Session | undefined; d: GateDetail; picked: DecisionRef | undefined }) {
  const { d, s } = props;
  const m = d.metrics;
  const failedChecks = m.checksTotal - m.checksPassed;
  const parts = [
    m.checksTotal === 0 ? undefined : (
      <span key="c" class={failedChecks > 0 ? "t-bad" : "t-ok"}>
        {failedChecks > 0
          ? `✗ ${failedChecks} of ${m.checksTotal} checks failed`
          : `✓ ${m.checksTotal} ${m.checksTotal === 1 ? "check" : "checks"} passed`}
      </span>
    ),
    m.retries > 0 ? `${m.retries} ${m.retries === 1 ? "retry" : "retries"}` : undefined,
    duration(m.workMs),
    tokensText(m),
  ].filter((p) => p !== undefined);
  const question = props.picked?.prompt || s?.prompt || d.prompt;
  const atComputer = s?.need === "hand_edit" || s?.need === "pipeline_edit";
  return (
    <div class="lead">
      {s?.status === "waiting" ? (
        <div class="lead-q">{atComputer ? (s.headline ?? s.prompt ?? question) : question}</div>
      ) : (
        <div class="lead-q muted">
          {s?.status === "running"
            ? `At ${d.node}`
            : s?.status === "done"
              ? "Finished"
              : s?.status === "failed"
                ? `Failed at ${d.node}`
                : s?.status === "canceled"
                  ? "Canceled"
                  : d.node}
        </div>
      )}
      <div class="lead-meta">
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 ? " · " : ""}
            {p}
          </span>
        ))}
      </div>
      <StepStrip steps={s?.steps ?? []} />
      {atComputer && s?.command ? (
        <div class="at-computer">
          Decide at the computer:
          <code>{s.command}</code>
        </div>
      ) : null}
    </div>
  );
}

/** Lines picked in one file's diff, by their index among the rows. */
export interface Picked {
  path: string;
  rows: Map<number, WebDiffRow>;
}

const span = (ns: number[]) => {
  if (ns.length === 0) return "";
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  return lo === hi ? `${lo}` : `${lo}-${hi}`;
};

/** Where picked lines are, the way a comment names a place: `path:10-14`. */
export function placeOfPicked(p: Picked): string {
  const rows = [...p.rows.values()];
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only?.place) return only.place;
  const kept = rows
    .filter((r) => r.kind !== "del" && r.new !== undefined)
    .map((r) => r.new as number);
  const gone = rows
    .filter((r) => r.kind === "del" && r.old !== undefined)
    .map((r) => r.old as number);
  const removed = gone.length === 1 ? "removed line" : "removed lines";
  if (kept.length === 0) return `${p.path}:${span(gone)} (${removed})`;
  return `${p.path}:${span(kept)}${gone.length > 0 ? ` (and ${removed} ${span(gone)})` : ""}`;
}

/** The picked lines as the diff shows them, `+` and `-` in front. */
export function codeOfPicked(p: Picked): string {
  return [...p.rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([, r]) =>
        `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.segs.map((x) => x.text).join("")}`,
    )
    .join("\n");
}

/** The row a comment shows under: a range shows under its last line. */
function anchorOf(location: string): string {
  const range = /^(.+):(\d+)-(\d+)(.*)$/.exec(location);
  if (!range) return location;
  return `${range[1]}:${range[3]}${range[4] === " (removed lines)" ? " (removed line)" : ""}`;
}

function DiffRows(props: {
  diff: WebDiff | undefined;
  comments: Comment[];
  picked?: Map<number, WebDiffRow> | undefined;
  onPick?: (index: number, row: WebDiffRow) => void;
}) {
  const { diff } = props;
  if (diff === undefined) return <div class="diff-note">Loading…</div>;
  if (diff.kind === "missing") return <div class="diff-note">There is no diff of this file.</div>;
  if (diff.kind === "error") return <div class="diff-note t-bad">{diff.message}</div>;
  const byPlace = new Map<string, Comment[]>();
  for (const c of props.comments) {
    const at = anchorOf(c.location);
    byPlace.set(at, [...(byPlace.get(at) ?? []), c]);
  }
  return (
    <div class="diff">
      {diff.rows.map((r, i) => {
        if (r.kind === "hunk") {
          return (
            <div key={i} class="d-hunk">
              {r.segs.map((s) => s.text).join("") || `line ${r.new ?? ""}`}
            </div>
          );
        }
        if (r.kind === "note") {
          return (
            <div key={i} class="d-note">
              {r.segs.map((s) => s.text).join("")}
            </div>
          );
        }
        const place = r.place;
        const notes = place ? (byPlace.get(place) ?? []) : [];
        const on = props.picked?.has(i) ?? false;
        return (
          <div key={i}>
            <div
              class={`d-row d-${r.kind}${notes.length > 0 ? " d-noted" : ""}${on ? " d-picked" : ""}`}
              {...(place && props.onPick
                ? {
                    role: "button",
                    tabIndex: 0,
                    "aria-pressed": on,
                    onClick: () => props.onPick?.(i, r),
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key === "Enter") props.onPick?.(i, r);
                    },
                  }
                : {})}
            >
              <span class="d-num">{r.kind === "del" ? (r.old ?? "") : (r.new ?? "")}</span>
              <span class="d-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
              <span class="d-code">
                {r.segs.map((s, j) => (
                  <span key={j} class={s.type ? `hl-${s.type}` : undefined}>
                    {s.text}
                  </span>
                ))}
              </span>
            </div>
            {notes.map((c, j) => (
              <div key={j} class="d-comment">
                <span class={`sev sev-${c.severity}`}>{c.severity}</span>
                <Prose text={c.description} />
              </div>
            ))}
          </div>
        );
      })}
      {diff.truncated ? <div class="d-note">The diff is cut here: it is too long.</div> : null}
    </div>
  );
}

interface Hunk {
  /** The lines of the new file the hunk shows, and the index of the diff row of each. */
  lines: string[];
  rows: number[];
  removed: number;
}

/** The hunks of a diff as the new file reads: kept and added lines; removed ones are only counted. */
function hunksOf(rows: WebDiffRow[]): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | undefined;
  rows.forEach((r, i) => {
    if (r.kind === "hunk" || cur === undefined) {
      cur = { lines: [], rows: [], removed: 0 };
      out.push(cur);
      if (r.kind === "hunk") return;
    }
    if (r.kind === "del") cur.removed++;
    else if (r.kind === "add" || r.kind === "ctx") {
      cur.lines.push(r.segs.map((x) => x.text).join(""));
      cur.rows.push(i);
    }
  });
  return out.filter((h) => h.lines.length > 0 || h.removed > 0);
}

/**
 * A Markdown file's diff as it reads: each hunk of the new file drawn as Markdown, a block with an added
 * line marked. A tap picks every line of a block, so a comment or a question names the lines it is about.
 */
function RenderedDiff(props: {
  diff: WebDiff | undefined;
  comments: Comment[];
  picked: Map<number, WebDiffRow> | undefined;
  onPick?: (rows: [number, WebDiffRow][]) => void;
}) {
  const { diff } = props;
  if (diff === undefined) return <div class="diff-note">Loading…</div>;
  if (diff.kind === "missing") return <div class="diff-note">There is no diff of this file.</div>;
  if (diff.kind === "error") return <div class="diff-note t-bad">{diff.message}</div>;
  const byPlace = new Map<string, Comment[]>();
  for (const c of props.comments) {
    const at = anchorOf(c.location);
    byPlace.set(at, [...(byPlace.get(at) ?? []), c]);
  }
  const hunks = hunksOf(diff.rows);
  return (
    <div class="rdiff">
      {hunks.map((h, k) => (
        <div key={k} class="rd-hunk">
          {k > 0 ? (
            <div class="rd-gap" aria-hidden="true">
              ⋯
            </div>
          ) : null}
          {blocksOf(h.lines.join("\n")).map((b, j) => {
            const own: [number, WebDiffRow][] = h.rows
              .slice(b.from, b.to + 1)
              .map((i) => [i, diff.rows[i] as WebDiffRow]);
            const added = own.some(([, r]) => r.kind === "add");
            const on = own.length > 0 && own.every(([i]) => props.picked?.has(i));
            const notes = own.flatMap(([, r]) => (r.place ? (byPlace.get(r.place) ?? []) : []));
            const first = own[0]?.[1];
            return (
              <div key={j}>
                <div
                  class={`rd-block md${added ? " rd-add" : ""}${on ? " rd-picked" : ""}${notes.length > 0 ? " d-noted" : ""}`}
                  {...(props.onPick
                    ? {
                        role: "button",
                        tabIndex: 0,
                        "aria-pressed": on,
                        onClick: () => props.onPick?.(own),
                        onKeyDown: (e: KeyboardEvent) => {
                          if (e.key === "Enter") props.onPick?.(own);
                        },
                      }
                    : {})}
                >
                  {first?.new !== undefined ? <span class="rd-line">{first.new}</span> : null}
                  <BlockView b={b} />
                </div>
                {notes.map((c, n) => (
                  <div key={n} class="d-comment">
                    <span class={`sev sev-${c.severity}`}>{c.severity}</span>
                    <Prose text={c.description} />
                  </div>
                ))}
              </div>
            );
          })}
          {h.removed > 0 ? (
            <div class="rd-removed">
              {h.removed} {h.removed === 1 ? "line" : "lines"} removed here · see Source
            </div>
          ) : null}
        </div>
      ))}
      {diff.truncated ? <div class="d-note">The diff is cut here: it is too long.</div> : null}
    </div>
  );
}

function FileRow(props: {
  runId: string;
  path: string;
  lines: number;
  comments: Comment[];
  picked: Picked | undefined;
  onPick?: (path: string, rows: [number, WebDiffRow][]) => void;
  onComment?: (place: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const markdown = /\.(md|markdown|mdx)$/i.test(props.path);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const rendered = markdown && mode === "rendered";
  const [diff, setDiff] = useState<WebDiff | undefined>();
  useEffect(() => {
    if (!open || diff !== undefined) return;
    let live = true;
    api
      .diff(props.runId, props.path)
      .then((r) => live && setDiff(r))
      .catch((e: Error) => live && setDiff({ kind: "error", message: e.message }));
    return () => {
      live = false;
    };
  }, [open, diff, props.runId, props.path]);
  const mine = props.comments.filter(
    (c) => c.location === props.path || c.location.startsWith(`${props.path}:`),
  );
  const slash = props.path.lastIndexOf("/");
  const picked = props.picked?.path === props.path ? props.picked.rows : undefined;
  return (
    <div class="file">
      <button type="button" class="file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`fold ${open ? "open" : ""}`} aria-hidden="true" />
        <span class="file-path">
          {slash >= 0 ? <span class="muted">{props.path.slice(0, slash + 1)}</span> : null}
          {props.path.slice(slash + 1)}
        </span>
        {mine.length > 0 ? <span class="file-notes">{mine.length}</span> : null}
        <span class="file-lines">{props.lines}</span>
      </button>
      {open ? (
        <>
          {props.onPick || markdown ? (
            <div class="file-tools">
              {markdown ? (
                <span class="modes">
                  {(["rendered", "source"] as const).map((m) => (
                    <button
                      type="button"
                      key={m}
                      class={mode === m ? "on" : ""}
                      aria-pressed={mode === m}
                      onClick={() => setMode(m)}
                    >
                      {m === "rendered" ? "Rendered" : "Source"}
                    </button>
                  ))}
                </span>
              ) : (
                <span class="muted">Tap lines to pick them</span>
              )}
              {props.onComment ? (
                <button type="button" class="link" onClick={() => props.onComment?.(props.path)}>
                  Comment on file
                </button>
              ) : null}
            </div>
          ) : null}
          {rendered ? (
            <RenderedDiff
              diff={diff}
              comments={mine}
              picked={picked}
              {...(props.onPick
                ? { onPick: (rows: [number, WebDiffRow][]) => props.onPick?.(props.path, rows) }
                : {})}
            />
          ) : (
            <DiffRows
              diff={diff}
              comments={mine}
              picked={picked}
              {...(props.onPick
                ? { onPick: (i: number, r: WebDiffRow) => props.onPick?.(props.path, [[i, r]]) }
                : {})}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

function dotOf(state: Visit["state"]): string {
  return state === "done" || state === "failed" || state === "running" || state === "waiting"
    ? state
    : "canceled";
}

function StepRow(props: { runId: string; v: Visit; index: number }) {
  const { v } = props;
  const a = v.attempt;
  return (
    <a class="row" href={`#/run/${encodeURIComponent(props.runId)}/step/${props.index}`}>
      <span class={`dot dot-${dotOf(v.state)}`} />
      <span class="row-main">
        <span class="row-title">
          {v.slug}
          {a.n > 1 ? <span class="muted"> #{a.n}</span> : null}
        </span>
        <span class="row-meta">
          {[v.kind, a.outcome, v.rework ? "rework" : undefined].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span class="row-time">{duration(a.ms)}</span>
      <span class="chev" aria-hidden="true" />
    </a>
  );
}

/** The agent's words and calls while the step went on; without an agent log, the records of the step. */
function StepLog(props: { d: GateDetail; v: Visit }) {
  const { d, v } = props;
  const from = v.attempt.from;
  if (d.agentLog && from !== undefined) {
    const to = v.attempt.to ?? Number.POSITIVE_INFINITY;
    const within = d.agentLog.filter((e) => e.ts >= from && e.ts <= to);
    return within.length === 0 ? (
      <p class="muted">The agent did nothing in this step.</p>
    ) : (
      <Entries entries={within} />
    );
  }
  return v.attempt.log.length === 0 ? (
    <p class="muted">No records.</p>
  ) : (
    <pre class="journal">{v.attempt.log.join("\n")}</pre>
  );
}

/** One step of a run's history on a page of its own: how it ended, its checks, and its log. */
export function StepScreen(props: {
  id: string;
  index: number | "journal";
  title: string | undefined;
}) {
  const { id } = props;
  const [detail, setDetail] = useState<GateDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    api
      .detail(id)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  const v = typeof props.index === "number" ? detail?.visits[props.index] : undefined;
  const a = v?.attempt;
  const title =
    props.index === "journal"
      ? "Journal"
      : v
        ? `${v.slug}${a && a.n > 1 ? ` #${a.n}` : ""}`
        : "Step";
  return (
    <div class="screen run">
      <header class="bar">
        <a class="icon-btn" href={`#/run/${encodeURIComponent(id)}`} aria-label="Back">
          <Icon name="back" />
        </a>
        <div class="bar-title">
          <h1 class="small">{title}</h1>
          <span class="bar-sub">
            {props.index === "journal"
              ? props.title
              : [v?.kind, a?.outcome, duration(a?.ms)].filter(Boolean).join(" · ")}
          </span>
        </div>
      </header>
      {error && !detail ? <p class="empty t-bad">{error}</p> : null}
      {!detail && !error ? <p class="empty">Loading…</p> : null}
      {detail && props.index === "journal" ? (
        <pre class="journal">{detail.journal.join("\n")}</pre>
      ) : null}
      {detail && props.index !== "journal" && !v ? <p class="empty">This step is gone.</p> : null}
      {detail && v && a ? (
        <>
          {a.reason || a.decision || a.summary || a.checks.length > 0 || a.review ? (
            <div class="pad step-sum">
              {a.reason ? <Prose text={a.reason} class="t-bad" /> : null}
              {a.decision ? (
                <p>
                  Decided <b>{a.decision.decision}</b>
                  {a.decision.reason ? `: ${a.decision.reason}` : ""}
                </p>
              ) : null}
              {a.summary ? <Markdown text={a.summary} /> : null}
              {a.checks.map((c, i) => (
                <div key={i} class={`check ${c.passed ? "t-ok" : "t-bad"}`}>
                  {c.passed ? "✓" : "✗"} {c.label} <span class="muted">{duration(c.ms)}</span>
                </div>
              ))}
              {a.review?.findings.map((f, i) => (
                <div key={i} class="d-comment">
                  <span class={`sev sev-${f.severity}`}>{f.severity}</span>
                  <code class="muted">{f.location}</code>
                  <Prose text={f.description} />
                </div>
              ))}
            </div>
          ) : null}
          <div class="sub-head">Log</div>
          <div class="pad">
            <StepLog d={detail} v={v} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function CommentSheet(props: {
  place: string;
  text?: string;
  onClose: () => void;
  onSave: (c: Comment) => Promise<void>;
}) {
  const [text, setText] = useState(props.text ?? "");
  const [severity, setSeverity] = useState<string>("major");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (text.trim() === "") return;
    setBusy(true);
    try {
      await props.onSave({ severity, location: props.place, description: text.trim() });
      props.onClose();
    } catch {
      // The notice says why; the text stays to try again.
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Comment"
      onClose={props.onClose}
      actions={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={busy || text.trim() === ""}
            onClick={save}
          >
            Save
          </button>
        </>
      }
    >
      <code class="sheet-place">{props.place}</code>
      <div class="sevs">
        {SEVERITIES.map((s) => (
          <button
            type="button"
            key={s}
            class={`sev sev-${s} ${severity === s ? "on" : ""}`}
            onClick={() => setSeverity(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <TextBox value={text} placeholder="What should change?" onInput={setText} />
    </Modal>
  );
}

type RunTab = "agent" | "review" | "history";
/** What waits to be asked, per run: kept while the page is open, as the person moves around the run. */
const draftsOf = new Map<string, AskRef[]>();
/** The tab each run was left on, so coming back from a step finds it where it was. */
const tabs = new Map<string, RunTab>();

type Asking =
  | { step: "reason"; reason: string }
  | {
      step: "confirm";
      decision: "approve" | "reject" | "resume";
      flow: number;
      questions: string[];
    };

export function RunScreen(props: {
  id: string;
  session: Session | undefined;
  me: Me;
  now: number;
  notify: Notify;
}) {
  const { id, session, me } = props;
  const [detail, setDetail] = useState<GateDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pickKey, setPickKey] = useState<string | undefined>();
  const [commenting, setComment] = useState<{ place: string; text?: string } | undefined>();
  const setCommenting = (place: string | undefined) =>
    setComment(place === undefined ? undefined : { place });
  const [asking, setAsking] = useState<Asking | undefined>();
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Picked | undefined>();
  const [noting, setNoting] = useState<{ place: string; code: string } | undefined>();
  const [agentOpen, setAgentOpen] = useState(false);
  const [drafts, setDraftsState] = useState<AskRef[]>(draftsOf.get(id) ?? []);
  const setDrafts = (next: AskRef[]) => {
    draftsOf.set(id, next);
    setDraftsState(next);
  };
  // A tap picks lines, or lets them go when every one of them was picked.
  const pickLine = (path: string, picked: [number, WebDiffRow][]) => {
    const rows = new Map(chosen?.path === path ? chosen.rows : []);
    const all = picked.every(([i]) => rows.has(i));
    for (const [i, r] of picked) {
      if (all) rows.delete(i);
      else rows.set(i, r);
    }
    setChosen(rows.size === 0 ? undefined : { path, rows });
  };
  const [instructions, setInstructions] = useState(false);
  const [stopping, setStopping] = useState<number | undefined>();
  // The tabs stick right under the header, whatever height the header has on this screen.
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const h = head.current;
    if (!h || typeof ResizeObserver === "undefined") return;
    const set = () => root.current?.style.setProperty("--bar-h", `${h.offsetHeight}px`);
    set();
    const o = new ResizeObserver(set);
    o.observe(h);
    return () => o.disconnect();
  }, []);
  const [tab, setTabState] = useState<RunTab>(tabs.get(id) ?? "agent");
  const setTab = (t: RunTab) => {
    tabs.set(id, t);
    setTabState(t);
  };

  const refs = refsOf(session, detail);
  const picked = refs.find((r) => `${r.kind}:${r.node}` === pickKey) ?? refs[0];
  const pick = picked && refs.length > 1 ? picked : undefined;
  // What of the run's row means the card changed; how long it has been quiet does not.
  const sessionKey = session
    ? JSON.stringify([session.status, session.need, session.step, session.steps, session.decisions])
    : "";

  // Reads can overlap (a timer and a change of the run): only the newest one is shown, so an older
  // answer that comes back late never puts the screen back.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const d = await api.detail(id, pick);
      if (mine !== asked.current) return;
      setDetail(d);
      setError(undefined);
    } catch (e) {
      if (mine !== asked.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, pick?.kind, pick?.node]);

  useEffect(() => {
    void load();
  }, [load, sessionKey]);

  useEffect(() => {
    if (session?.status !== "running") return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load, session?.status]);

  const canComment = me.canComment && detail?.kind === "gate";
  const addComment = async (c: Comment) => {
    if (!detail) return;
    try {
      await api.addComment(id, detail.node, detail.attempt, c);
      props.notify("Comment saved", true);
      await load();
    } catch (e) {
      props.notify((e as Error).message, false);
      throw e;
    }
  };
  const deleteComment = async (index: number) => {
    if (!detail || !confirm("Delete this comment?")) return;
    try {
      await api.deleteComment(id, detail.node, detail.attempt, index);
      await load();
    } catch (e) {
      props.notify((e as Error).message, false);
    }
  };

  const ask = async (decision: "approve" | "reject" | "resume", reason?: string) => {
    if (!picked) return;
    setBusy(true);
    try {
      const ref =
        picked.kind === "gate" &&
        detail &&
        picked.node === detail.node &&
        picked.attempt === undefined
          ? { ...picked, attempt: detail.attempt }
          : picked;
      const { flow, result } = await api.check(id, ref, decision, reason);
      if (!result.ok) {
        if (result.needsReason) setAsking({ step: "reason", reason: reason ?? "" });
        else setAsking(undefined);
        props.notify(result.message, false);
        return;
      }
      setAsking({ step: "confirm", decision, flow, questions: result.questions });
    } catch (e) {
      props.notify(e instanceof ApiError ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };
  const confirmDecision = async () => {
    if (asking?.step !== "confirm") return;
    setBusy(true);
    try {
      const outcome = await api.decide(id, asking.flow);
      props.notify(outcome.message, outcome.ok);
      setAsking(undefined);
      await load();
    } catch (e) {
      props.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  const stopAsk = async () => {
    setBusy(true);
    try {
      const r = await api.stopAgent(id);
      if (r.step === "confirm") setStopping(r.flow);
      else props.notify(r.result.status === "stopped" ? "Agent stopped" : r.result.reason, false);
    } catch (e) {
      props.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };
  const stopConfirmed = async () => {
    if (stopping === undefined) return;
    setBusy(true);
    try {
      const r = await api.stopAgent(id, stopping);
      setStopping(undefined);
      if (r.step === "done") {
        const { result } = r;
        props.notify(
          result.status === "stopped" ? `${result.agent} stopped. ${result.note}` : result.reason,
          result.status === "stopped",
        );
      }
    } catch (e) {
      setStopping(undefined);
      props.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  const waiting = session?.status === "waiting";
  const decidable = waiting && picked !== undefined && me.canDecide;
  const changes = detail?.changes;
  const report = detail?.report;

  return (
    <div ref={root} class={`screen run ${decidable || chosen ? "with-actions" : ""}`}>
      <header ref={head} class="bar">
        <a class="icon-btn" href="#/runs" aria-label="Back">
          <Icon name="back" />
        </a>
        <div class="bar-title">
          <h1 class="small">{nameOf(session) ?? id}</h1>
          <span class="bar-sub">
            {[
              session?.agentSession?.name ? session.title : undefined,
              session?.pipeline,
              detail?.position,
              session ? formatAge(props.now - session.since) : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <span class="bar-actions">
          {session?.taskKey ? (
            <a
              class="icon-btn"
              href={`#/task/${encodeURIComponent(session.taskKey)}`}
              aria-label={`Open task ${session.taskKey}`}
              title={session.taskKey}
            >
              <Icon name="tasks" />
            </a>
          ) : null}
          {me.canStopAgent && (session?.status === "running" || session?.status === "waiting") ? (
            <button type="button" class="text-btn" disabled={busy} onClick={stopAsk}>
              Stop agent
            </button>
          ) : null}
          {me.canAsk ? (
            <button
              type="button"
              class="icon-btn"
              aria-label="Ask the agent"
              onClick={() => setAgentOpen(true)}
            >
              <span class="tab-icon">
                <Icon name="agent" />
                {drafts.length > 0 ? <span class="badge">{drafts.length}</span> : null}
              </span>
            </button>
          ) : null}
        </span>
      </header>

      {stopping !== undefined ? (
        <Modal
          title="Stop the agent?"
          onClose={() => setStopping(undefined)}
          actions={
            <>
              <button type="button" class="btn" onClick={() => setStopping(undefined)}>
                Cancel
              </button>
              <button type="button" class="btn primary" disabled={busy} onClick={stopConfirmed}>
                Stop agent
              </button>
            </>
          }
        >
          <p class="muted small">
            The run stays open with its task; nothing is cancelled. A terminal attached to the agent
            is closed with it. The daemon does not start the agent again.
          </p>
        </Modal>
      ) : null}

      {refs.length > 1 ? (
        <div class="picks">
          {refs.map((r) => (
            <button
              type="button"
              key={`${r.kind}:${r.node}`}
              class={`pick ${picked === r ? "on" : ""}`}
              onClick={() => setPickKey(`${r.kind}:${r.node}`)}
            >
              {r.kind === "pause" ? "Paused · " : ""}
              {r.node}
            </button>
          ))}
        </div>
      ) : null}

      {error && !detail ? <p class="empty t-bad">{error}</p> : null}
      {!detail && !error ? <p class="empty">Loading…</p> : null}

      {detail ? (
        <>
          <Lead s={session} d={detail} picked={picked} />

          {detail.changedAfterChecks.length > 0 ? (
            <div class="warn-line">
              Changed after the checks passed: {detail.changedAfterChecks.join(", ")}
            </div>
          ) : null}

          <div class="seg" role="tablist">
            {(
              [
                ["agent", "Agent", undefined],
                ["review", "Review", detail.comments.length || undefined],
                ["history", "History", undefined],
              ] as const
            ).map(([key, label, count]) => (
              <button
                type="button"
                role="tab"
                key={key}
                aria-selected={tab === key}
                class={tab === key ? "on" : ""}
                onClick={() => setTab(key)}
              >
                {label}
                {count ? <span class="seg-count">{count}</span> : null}
              </button>
            ))}
          </div>

          {tab === "agent" && detail.instructions ? (
            <div class="pad">
              <button
                type="button"
                class="link small"
                onClick={() => setInstructions(!instructions)}
              >
                {instructions ? "Hide" : "Show"} what the agent was asked
              </button>
              {instructions ? <Markdown text={detail.instructions} /> : null}
            </div>
          ) : null}

          {tab === "agent" && (detail.agentLog?.length ?? 0) > 0 ? (
            <AgentTimeline
              d={withFullReport(detail)}
              live={session?.status === "running"}
              now={props.now}
            />
          ) : null}

          {tab === "agent" && (detail.agentLog?.length ?? 0) === 0 ? (
            <div class="pad">
              {report ? (
                <Markdown text={report.text} />
              ) : (
                <p class="muted">The agent left no report and its log can't be read.</p>
              )}
            </div>
          ) : null}

          {tab === "review" ? (
            <>
              {detail.comments.length > 0 || canComment ? (
                <>
                  <div class="sub-head">
                    Comments
                    {detail.comments.length > 0 ? <span>{detail.comments.length}</span> : null}
                  </div>
                  {detail.comments.map((c, i) => (
                    <div key={`${i}:${c.location}`} class="comment">
                      <div class="comment-head">
                        <span class={`sev sev-${c.severity}`}>{c.severity}</span>
                        <code class="muted">{c.location}</code>
                        {canComment ? (
                          <button
                            type="button"
                            class="icon-btn small"
                            aria-label="Delete comment"
                            onClick={() => deleteComment(i)}
                          >
                            <Icon name="close" size={16} />
                          </button>
                        ) : null}
                      </div>
                      <Prose text={c.description} />
                    </div>
                  ))}
                  {canComment ? (
                    <button
                      type="button"
                      class="row row-more"
                      onClick={() => setCommenting(detail.node)}
                    >
                      Comment on the step
                    </button>
                  ) : null}
                </>
              ) : null}
              {changes ? (
                <>
                  <div class="sub-head">
                    Changes
                    {changes.kind === "files" ? (
                      <span>
                        {changes.totalFiles} {changes.totalFiles === 1 ? "file" : "files"} ·{" "}
                        {changes.totalLines} lines
                      </span>
                    ) : null}
                  </div>
                  {changes.kind === "files" ? (
                    <>
                      {changes.files.map(([path, lines]) => (
                        <FileRow
                          key={path}
                          runId={id}
                          path={path}
                          lines={lines}
                          comments={detail.comments}
                          picked={chosen}
                          {...(canComment || me.canAsk ? { onPick: pickLine } : {})}
                          {...(canComment ? { onComment: setCommenting } : {})}
                        />
                      ))}
                      {changes.files.length < changes.totalFiles ? (
                        <div class="pad muted">
                          …and {changes.totalFiles - changes.files.length} more
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div class="pad muted">
                      {changes.kind === "none"
                        ? "No files changed."
                        : changes.kind === "no_repo"
                          ? "This project is not a git repository."
                          : `Changes can't be read: ${changes.reason}`}
                    </div>
                  )}
                </>
              ) : null}
            </>
          ) : null}

          {tab === "history" ? (
            <>
              {detail.visits.map((v, i) => (
                <StepRow key={`${i}:${v.slug}:${v.attempt.n}`} runId={id} v={v} index={i} />
              ))}
              <a class="row row-more" href={`#/run/${encodeURIComponent(id)}/journal`}>
                Full journal · {detail.journal.length}
              </a>
            </>
          ) : null}
        </>
      ) : null}

      {chosen ? (
        <div class="actionbar pickbar">
          <button
            type="button"
            class="icon-btn"
            aria-label="Clear the picked lines"
            onClick={() => setChosen(undefined)}
          >
            <Icon name="close" />
          </button>
          <span class="pick-count">
            {chosen.rows.size} {chosen.rows.size === 1 ? "line" : "lines"}
          </span>
          {canComment ? (
            <button
              type="button"
              class="btn grow"
              onClick={() => {
                setComment({ place: placeOfPicked(chosen) });
                setChosen(undefined);
              }}
            >
              Comment
            </button>
          ) : null}
          {me.canAsk ? (
            <button
              type="button"
              class="btn primary grow"
              onClick={() =>
                setNoting({ place: placeOfPicked(chosen), code: codeOfPicked(chosen) })
              }
            >
              Ask
            </button>
          ) : null}
        </div>
      ) : null}
      {!chosen && waiting && picked && !me.canDecide ? (
        <div class="actionbar">
          <span class="muted">Sample data: decisions aren't written</span>
        </div>
      ) : null}
      {!chosen && decidable ? (
        <div class="actionbar">
          {picked.kind === "pause" ? (
            <button
              type="button"
              class="btn primary grow"
              disabled={busy}
              onClick={() => ask("resume")}
            >
              Resume
            </button>
          ) : (
            <>
              <button
                type="button"
                class="btn danger grow"
                disabled={busy}
                onClick={() => setAsking({ step: "reason", reason: "" })}
              >
                Reject{detail && detail.comments.length > 0 ? ` · ${detail.comments.length}` : ""}
              </button>
              <button
                type="button"
                class="btn primary grow2"
                disabled={busy}
                onClick={() => ask("approve")}
              >
                Approve
              </button>
            </>
          )}
        </div>
      ) : null}

      {noting ? (
        <AskNoteSheet
          place={noting.place}
          code={noting.code}
          onClose={() => setNoting(undefined)}
          onAdd={(note, now) => {
            setDrafts([...drafts, { ...noting, note }]);
            setNoting(undefined);
            setChosen(undefined);
            if (now) setAgentOpen(true);
            else props.notify("Added: open the agent to send", true);
          }}
        />
      ) : null}

      {agentOpen ? (
        <AskPanel
          runId={id}
          title={nameOf(session) ?? id}
          drafts={drafts}
          onDrafts={setDrafts}
          onClose={() => setAgentOpen(false)}
          notify={props.notify}
          {...(canComment && detail
            ? {
                onComment: (text: string) => {
                  setAgentOpen(false);
                  setComment({ place: detail.node, text });
                },
              }
            : {})}
        />
      ) : null}

      {commenting !== undefined ? (
        <CommentSheet
          place={commenting.place}
          {...(commenting.text === undefined ? {} : { text: commenting.text })}
          onClose={() => setCommenting(undefined)}
          onSave={addComment}
        />
      ) : null}

      {asking?.step === "reason" ? (
        <Modal
          title="Reject"
          onClose={() => setAsking(undefined)}
          actions={
            <>
              <button type="button" class="btn" onClick={() => setAsking(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                class="btn danger"
                disabled={busy || asking.reason.trim() === ""}
                onClick={() => ask("reject", asking.reason.trim())}
              >
                Next
              </button>
            </>
          }
        >
          <p class="muted">
            What should the agent do differently?
            {detail && detail.comments.length > 0
              ? ` Your ${detail.comments.length} ${detail.comments.length === 1 ? "comment goes" : "comments go"} along.`
              : ""}
          </p>
          <TextBox
            value={asking.reason}
            onInput={(r) => setAsking({ step: "reason", reason: r })}
          />
        </Modal>
      ) : null}

      {asking?.step === "confirm" ? (
        <Modal
          title={
            asking.decision === "approve"
              ? "Approve"
              : asking.decision === "reject"
                ? "Reject"
                : "Resume"
          }
          onClose={() => setAsking(undefined)}
          actions={
            <>
              <button type="button" class="btn" onClick={() => setAsking(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                class={`btn ${asking.decision === "reject" ? "danger" : "primary"}`}
                disabled={busy}
                onClick={confirmDecision}
              >
                {asking.decision === "approve"
                  ? "Approve"
                  : asking.decision === "reject"
                    ? "Reject"
                    : "Resume"}
              </button>
            </>
          }
        >
          {asking.questions.map((q, i) => (
            <Prose key={i} text={q} />
          ))}
        </Modal>
      ) : null}
    </div>
  );
}
