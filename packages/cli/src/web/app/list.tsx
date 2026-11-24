/** @jsxImportSource preact */
/**
 * The Runs tab: what needs you, what is working, and what finished, by day. One row per run: a dot for
 * its state, its title, one line of what it is doing, and how long.
 */
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { type RowLabel, rowLabels } from "../../tui/label";
import { formatAge, type Session, sortSessions } from "../../tui/session";
import { Icon } from "./icons";

const DAY_MS = 24 * 60 * 60_000;

/** The step a run is at: the one its decision names, else the first one in that state. */
function stepAt(s: Session, state: "waiting" | "running"): string | undefined {
  return s.decisions?.[0]?.node ?? s.steps.find((x) => x.state === state)?.name;
}

/** Where a waiting run waits, in a few words; what it asks for is its label. */
function needText(s: Session): string {
  switch (s.need) {
    case "approve":
    case "paused":
      return stepAt(s, "waiting") ?? s.step;
    case "pipeline_edit":
      return "pipeline changed";
    case "hand_edit":
      return "files changed by hand";
    default:
      return s.step;
  }
}

/** Steps done and in all, as the run's own list has them. */
function progress(s: Session): { done: number; total: number } {
  return {
    done: s.steps.filter((x) => x.state === "done").length,
    total: s.steps.length,
  };
}

/**
 * The task of a run, as a chip that opens the task. The row around it is a link to the run, and a link
 * cannot hold another, so the chip takes the tap itself.
 */
function TaskChip(props: { taskKey: string }) {
  const open = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `#/task/${encodeURIComponent(props.taskKey)}`;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <a> cannot sit inside the run's <a>
    <span
      class="task-chip"
      role="link"
      tabIndex={0}
      aria-label={`Open task ${props.taskKey}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(e);
      }}
    >
      <Icon name="tasks" size={13} />
      {props.taskKey}
    </span>
  );
}

function Meta(props: { s: Session }) {
  const { s } = props;
  const parts: ComponentChildren[] = [
    ...(s.taskKey ? [<TaskChip key="task" taskKey={s.taskKey} />] : []),
    s.pipeline,
  ];
  if (s.status === "waiting") {
    parts.push(needText(s));
    const more = (s.decisions?.length ?? 0) - 1;
    if (more > 0) parts.push(<span class="t-wait">+{more} more</span>);
  } else if (s.status === "running") {
    const p = progress(s);
    const at = s.steps.find((x) => x.state === "running")?.name ?? s.step;
    parts.push(p.total > 0 ? `${at} ${p.done}/${p.total}` : at);
    if (s.activity === "quiet" && s.quietMs !== undefined) {
      parts.push(<span class="t-wait">quiet {formatAge(s.quietMs)}</span>);
    }
    if ((s.besides?.length ?? 0) > 0) parts.push(<span class="t-wait">needs you</span>);
  } else if (s.status === "failed") {
    parts.push(<span class="t-bad">failed · {s.step}</span>);
  } else if (s.status === "done") {
    parts.push(<span class="t-ok">done</span>);
  } else if (s.status === "canceled") {
    parts.push("canceled");
  } else {
    parts.push("can't be read");
  }
  return (
    <span class="row-meta">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? " · " : ""}
          {p}
        </span>
      ))}
    </span>
  );
}

/** How long ago, or the date for what is older than a week. */
function timeOf(ts: number, now: number): string {
  if (now - ts < 7 * DAY_MS) return formatAge(now - ts);
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" },
  );
}

/** What a person does for a waiting run, as the label at the right of its row. */
const NEED_LABEL: Record<string, { text: string; kind: string }> = {
  approve: { text: "Approve", kind: "approve" },
  paused: { text: "Resume", kind: "resume" },
  pipeline_edit: { text: "Accept", kind: "other" },
  hand_edit: { text: "Ack", kind: "other" },
};

function Row(props: { s: Session; now: number; label: RowLabel | undefined }) {
  const { s } = props;
  const p = s.status === "running" ? progress(s) : undefined;
  const label = s.status === "waiting" && s.need ? NEED_LABEL[s.need] : undefined;
  return (
    <a class="row" href={`#/run/${encodeURIComponent(s.id)}`}>
      <span class={`dot dot-${s.status}`} />
      <span class="row-main">
        <span class="row-title">
          {props.label?.name ?? s.title}
          {props.label?.guess ? <span class="muted"> ?</span> : null}
          {props.label?.suffix ? <span class="muted"> · {props.label.suffix}</span> : null}
        </span>
        <Meta s={s} />
        {p && p.total > 0 ? (
          <span class="row-bar">
            <span style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} />
          </span>
        ) : null}
      </span>
      <span class="row-side">
        <span class="row-time">{timeOf(s.since, props.now)}</span>
        {label ? <span class={`need need-${label.kind}`}>{label.text}</span> : null}
      </span>
    </a>
  );
}

/** Which groups are folded, kept on this device; a page that cannot keep it starts unfolded. */
const FOLDED_KEY = "kodel.folded";
function readFolded(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
const folded = readFolded();
/** Groups opened in full with "Show more", for as long as the page is open. */
const opened = new Set<string>();

function Section(props: {
  id: string;
  title: string;
  rows: Session[];
  now: number;
  labels: Map<string, RowLabel>;
  limit?: number;
}) {
  const [, redraw] = useState(0);
  if (props.rows.length === 0) return null;
  const isFolded = folded.has(props.id);
  const toggle = () => {
    if (isFolded) folded.delete(props.id);
    else folded.add(props.id);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
    } catch {
      // Kept for this page only.
    }
    redraw((n) => n + 1);
  };
  const shown =
    props.limit !== undefined && !opened.has(props.id)
      ? props.rows.slice(0, props.limit)
      : props.rows;
  return (
    <section>
      <button type="button" class="band" aria-expanded={!isFolded} onClick={toggle}>
        <span class={`fold ${isFolded ? "" : "open"}`} aria-hidden="true" />
        <span class="band-title">{props.title}</span>
        <span>{props.rows.length}</span>
      </button>
      {isFolded
        ? null
        : shown.map((s) => <Row key={s.id} s={s} now={props.now} label={props.labels.get(s.id)} />)}
      {!isFolded && shown.length < props.rows.length ? (
        <button
          type="button"
          class="row row-more"
          onClick={() => {
            opened.add(props.id);
            redraw((n) => n + 1);
          }}
        >
          Show {props.rows.length - shown.length} more
        </button>
      ) : null}
    </section>
  );
}

export function RunsTab(props: {
  sessions: Session[] | undefined;
  proposals: number;
  now: number;
  live: boolean;
  project: string;
  onMore: () => void;
}) {
  const [query, setQuery] = useState<string | undefined>();
  // The field is always there: a phone opens its keyboard only for a focus given right in the tap.
  const field = useRef<HTMLInputElement>(null);
  const { now } = props;
  const q = query?.trim().toLowerCase() ?? "";
  const sorted = sortSessions(props.sessions ?? []).filter(
    (s) =>
      q === "" ||
      s.title.toLowerCase().includes(q) ||
      (s.agentSession?.name ?? "").toLowerCase().includes(q) ||
      s.pipeline.toLowerCase().includes(q) ||
      (s.taskKey ?? "").toLowerCase().includes(q),
  );
  const labels = rowLabels(props.sessions ?? []);
  // Newest first by when they ended, whatever the way they ended.
  const finished = sorted
    .filter((s) => s.status === "done" || s.status === "failed" || s.status === "canceled")
    .sort((a, b) => b.since - a.since);
  return (
    <div class="screen">
      <header class="bar">
        <input
          ref={field}
          class={`search ${query === undefined ? "idle" : ""}`}
          type="search"
          placeholder="Title, pipeline or task"
          tabIndex={query === undefined ? -1 : 0}
          aria-hidden={query === undefined}
          value={query ?? ""}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {query === undefined ? (
          <>
            <div class="bar-title">
              <h1>Runs</h1>
              <span class="bar-sub">
                <span class={`live ${props.live ? "on" : ""}`} />
                {props.project}
              </span>
            </div>
            <button
              type="button"
              class="icon-btn"
              aria-label="Search"
              onClick={() => {
                field.current?.focus();
                setQuery("");
              }}
            >
              <Icon name="search" />
            </button>
            <button type="button" class="icon-btn" aria-label="More" onClick={props.onMore}>
              <Icon name="more" />
            </button>
          </>
        ) : (
          <button
            type="button"
            class="text-btn"
            onClick={() => {
              field.current?.blur();
              setQuery(undefined);
            }}
          >
            Cancel
          </button>
        )}
      </header>
      {props.sessions === undefined ? (
        <div aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} class="row">
              <span class="dot" />
              <span class="row-main">
                <span class="sk sk-title" />
                <span class="sk sk-meta" />
              </span>
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p class="empty">
          {q === "" ? "No runs yet. Start one from your coding agent." : "Nothing matches."}
        </p>
      ) : (
        <>
          {props.proposals > 0 && q === "" ? (
            <a class="notice" href="#/pipelines">
              {props.proposals === 1
                ? "A pipeline proposal waits for you"
                : `${props.proposals} pipeline proposals wait for you`}
            </a>
          ) : null}
          <Section
            id="waiting"
            title="Needs you"
            rows={sorted.filter((s) => s.status === "waiting")}
            now={now}
            labels={labels}
          />
          <Section
            id="running"
            title="Working"
            rows={sorted.filter((s) => s.status === "running")}
            now={now}
            labels={labels}
          />
          <Section
            id="finished"
            title="Finished"
            rows={finished}
            now={now}
            labels={labels}
            limit={25}
          />
          <Section
            id="unreadable"
            title="Can't be read"
            rows={sorted.filter((s) => s.status === "unreadable")}
            now={now}
            labels={labels}
            limit={5}
          />
        </>
      )}
    </div>
  );
}
