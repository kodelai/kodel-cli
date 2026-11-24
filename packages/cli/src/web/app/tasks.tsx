/** @jsxImportSource preact */
/**
 * The Tasks tab and the card of one task: what the terminal's Tasks screen shows. A person can comment on
 * a task and make a new one; nothing else is written from here.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../../tui/session";
import { formatAge } from "../../tui/session";
import type { CardSlot, TaskRow, TasksLoad } from "../../tui/tasks-load";
import { api, type Me } from "./api";
import { Icon } from "./icons";
import { Markdown } from "./md";
import { Fold, Modal, TextBox } from "./ui";

type Notify = (text: string, ok: boolean) => void;

const PRIORITIES = ["high", "normal", "low"] as const;

function Priority(props: { p: string | undefined }) {
  if (!props.p) return null;
  return <span class={`prio prio-${props.p.toLowerCase()}`}>{props.p}</span>;
}

function TaskRowView(props: { r: TaskRow }) {
  const { r } = props;
  return (
    <a class="row" href={`#/task/${encodeURIComponent(r.key)}`}>
      <span class={`dot dot-task-${r.state}`} />
      <span class="row-main">
        <span class="row-title">{r.title}</span>
        <span class="row-meta">
          <span class="task-key">{r.key}</span>
          {` · ${r.status}`}
          {r.runCount > 0 ? ` · ${r.runCount} ${r.runCount === 1 ? "run" : "runs"}` : ""}
        </span>
      </span>
      <span class="row-side">
        <Priority p={r.priority} />
      </span>
    </a>
  );
}

function NewTaskSheet(props: {
  onClose: () => void;
  onMade: (key: string) => void;
  notify: Notify;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (title.trim() === "") return;
    setBusy(true);
    try {
      const key = await api.createTask({
        title: title.trim(),
        ...(body.trim() === "" ? {} : { body }),
        ...(priority === undefined ? {} : { priority }),
      });
      props.notify(`Created ${key}`, true);
      props.onMade(key);
    } catch (e) {
      props.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New task"
      onClose={props.onClose}
      actions={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={busy || title.trim() === ""}
            onClick={save}
          >
            Create
          </button>
        </>
      }
    >
      <input
        class="field"
        type="text"
        placeholder="Title"
        value={title}
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
      />
      <TextBox value={body} placeholder="What should be done (optional)" onInput={setBody} />
      <div class="sevs">
        {[undefined, ...PRIORITIES].map((p) => (
          <button
            type="button"
            key={p ?? "default"}
            class={`sev ${priority === p ? "on" : ""}`}
            onClick={() => setPriority(p)}
          >
            {p ?? "default"}
          </button>
        ))}
      </div>
      <p class="muted small">
        A new task is not started by <code>kodel serve</code> until you run{" "}
        <code>kodel task approve</code>.
      </p>
    </Modal>
  );
}

export function TasksTab(props: { me: Me; onMore: () => void; notify: Notify }) {
  const [load, setLoad] = useState<TasksLoad | undefined>();
  const [query, setQuery] = useState<string | undefined>();
  const [making, setMaking] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .tasks()
        .then((t) => live && setLoad(t))
        .catch((e: Error) => live && setLoad({ status: "error", message: e.message }));
    void read();
    const timer = setInterval(read, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const q = query?.trim().toLowerCase() ?? "";
  const rows =
    load?.status === "ready"
      ? load.rows.filter(
          (r) => q === "" || r.title.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
        )
      : [];
  const of = (state: TaskRow["state"]) => rows.filter((r) => r.state === state);
  return (
    <div class="screen">
      <header class="bar">
        <input
          ref={field}
          class={`search ${query === undefined ? "idle" : ""}`}
          type="search"
          placeholder="Title or key"
          tabIndex={query === undefined ? -1 : 0}
          aria-hidden={query === undefined}
          value={query ?? ""}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {query === undefined ? (
          <>
            <div class="bar-title">
              <h1>Tasks</h1>
              <span class="bar-sub">{props.me.project}</span>
            </div>
            {props.me.canCreateTask && load?.status === "ready" ? (
              <button
                type="button"
                class="icon-btn"
                aria-label="New task"
                onClick={() => setMaking(true)}
              >
                <Icon name="plus" />
              </button>
            ) : null}
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
      {load === undefined ? <p class="empty">Loading…</p> : null}
      {load?.status === "off" ? (
        <p class="empty">
          Tasks are off in this project. Turn them on with <code>tasks: {"{ enabled: true }"}</code>{" "}
          in <code>.kodel/config.yaml</code>.
        </p>
      ) : null}
      {load?.status === "error" ? <p class="empty t-bad">{load.message}</p> : null}
      {load?.status === "ready" ? (
        rows.length === 0 ? (
          <p class="empty">{q === "" ? "No tasks yet." : "Nothing matches."}</p>
        ) : (
          <>
            {(
              [
                ["progress", "In progress", false],
                ["todo", "To do", false],
                ["done", "Done", true],
              ] as const
            ).map(([state, title, folded]) =>
              of(state).length > 0 ? (
                <Fold
                  key={state}
                  id={`tasks.${state}`}
                  title={title}
                  aside={of(state).length}
                  folded={folded}
                >
                  {of(state).map((r) => (
                    <TaskRowView key={r.key} r={r} />
                  ))}
                </Fold>
              ) : null,
            )}
            {load.more ? <p class="empty">Only the first tasks are shown.</p> : null}
            {load.problems > 0 ? (
              <p class="empty t-wait">
                {load.problems} {load.problems === 1 ? "task" : "tasks"} could not be read.
              </p>
            ) : null}
          </>
        )
      ) : null}
      {making ? (
        <NewTaskSheet
          onClose={() => setMaking(false)}
          notify={props.notify}
          onMade={(key) => {
            setMaking(false);
            location.hash = `#/task/${encodeURIComponent(key)}`;
          }}
        />
      ) : null}
    </div>
  );
}

/** Back where the person came from: a run's card or the list. */
function goBack() {
  if (history.length > 1) history.back();
  else location.hash = "#/tasks";
}

export function TaskScreen(props: {
  taskKey: string;
  sessions: Session[] | undefined;
  me: Me;
  now: number;
  notify: Notify;
  nameOf: (s: Session | undefined) => string | undefined;
}) {
  const { taskKey } = props;
  const [slot, setSlot] = useState<CardSlot>({ status: "loading" });
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const read = () =>
    api
      .task(taskKey)
      .then(setSlot)
      .catch((e: Error) => setSlot({ status: "failed", message: e.message }));
  useEffect(() => {
    setSlot({ status: "loading" });
    void read();
  }, [taskKey]);

  const send = async () => {
    if (comment.trim() === "") return;
    setBusy(true);
    try {
      await api.commentTask(taskKey, comment.trim());
      setComment("");
      props.notify("Comment saved", true);
      await read();
    } catch (e) {
      props.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  const card = slot.status === "ready" ? slot.card : undefined;
  const runs = card?.runs ?? [];
  return (
    <div class="screen run">
      <header class="bar">
        <button type="button" class="icon-btn" aria-label="Back" onClick={goBack}>
          <Icon name="back" />
        </button>
        <div class="bar-title">
          <h1 class="small">{taskKey}</h1>
          <span class="bar-sub">
            {card ? [card.status, card.priority].filter(Boolean).join(" · ") : ""}
          </span>
        </div>
      </header>
      {slot.status === "loading" ? <p class="empty">Loading…</p> : null}
      {slot.status === "failed" ? <p class="empty t-bad">{slot.message}</p> : null}
      {card ? (
        <>
          <div class="lead">
            <div class="lead-q">{card.title}</div>
            <div class="lead-meta">
              <span class={`dot dot-task-${card.state}`} /> {card.status}
              {card.priority ? (
                <>
                  {" · "}
                  <Priority p={card.priority} />
                </>
              ) : null}
            </div>
          </div>
          {card.parent ? (
            <a class="row" href={`#/task/${encodeURIComponent(card.parent)}`}>
              <span class="row-main">
                <span class="row-meta">Part of</span>
                <span class="row-title task-key">{card.parent}</span>
              </span>
              <span class="chev" aria-hidden="true" />
            </a>
          ) : null}
          <div class="pad">
            {card.body ? <Markdown text={card.body} /> : <p class="muted">No description.</p>}
          </div>
          {runs.length > 0 ? (
            <>
              <div class="sub-head">
                Runs<span>{runs.length}</span>
              </div>
              {runs.map((id) => {
                const s = props.sessions?.find((x) => x.id === id);
                return (
                  <a key={id} class="row" href={`#/run/${encodeURIComponent(id)}`}>
                    <span class={`dot dot-${s?.status ?? "canceled"}`} />
                    <span class="row-main">
                      <span class="row-title">{props.nameOf(s) ?? id}</span>
                      <span class="row-meta">{s ? `${s.pipeline} · ${s.step}` : id}</span>
                    </span>
                    <span class="row-time">{s ? formatAge(props.now - s.since) : ""}</span>
                  </a>
                );
              })}
            </>
          ) : null}
          {card.subtasks.length > 0 ? (
            <>
              <div class="sub-head">
                Subtasks<span>{card.subtasks.length}</span>
              </div>
              {card.subtasks.map((k) => (
                <a key={k.key} class="row" href={`#/task/${encodeURIComponent(k.key)}`}>
                  <span class="row-main">
                    <span class="row-title">{k.title}</span>
                    <span class="row-meta task-key">{k.key}</span>
                  </span>
                  <span class="chev" aria-hidden="true" />
                </a>
              ))}
            </>
          ) : null}
          <div class="sub-head">
            Comments{card.comments.length > 0 ? <span>{card.comments.length}</span> : null}
          </div>
          {card.comments.map((c, i) => (
            <div key={`${i}:${c.at}`} class="comment">
              <div class="comment-head muted">
                {c.by ?? "someone"} · {formatAge(Math.max(0, props.now - Date.parse(c.at)))} ago
              </div>
              <Markdown text={c.text} />
            </div>
          ))}
          {props.me.canCommentTask ? (
            <div class="ask-box">
              <textarea
                rows={2}
                value={comment}
                placeholder="Add a comment"
                onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)}
              />
              <button
                type="button"
                class="btn primary"
                disabled={busy || comment.trim() === ""}
                onClick={send}
              >
                Save
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
