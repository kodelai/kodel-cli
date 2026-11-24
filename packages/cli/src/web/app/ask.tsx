/** @jsxImportSource preact */
/**
 * The agent, over the run's screen: questions to a read-only copy of the agent's session and its
 * answers. Lines picked in the diff wait here, each with the person's note, and go with the next
 * question at once. An answer can go along with a rejection as a comment.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { AskRef, AskThread, AskTurn } from "../ask";
import { api } from "./api";
import { Icon } from "./icons";
import { Markdown } from "./md";
import { clock, Modal, TextBox } from "./ui";

function RefCard(props: { r: AskRef; onRemove?: () => void }) {
  const { r } = props;
  return (
    <div class="ref">
      <div class="ref-head">
        <code>{r.place}</code>
        {props.onRemove ? (
          <button
            type="button"
            class="icon-btn small"
            aria-label="Remove this place"
            onClick={props.onRemove}
          >
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </div>
      {r.note !== "" ? <div class="ref-note">{r.note}</div> : null}
    </div>
  );
}

function Turn(props: { t: AskTurn; onComment?: (text: string) => void }) {
  const { t } = props;
  return (
    <div class="turn">
      <div class="q">
        <span>{t.question === "" ? "About these places" : t.question}</span>
        <span class="muted small">{clock(t.at)}</span>
      </div>
      {t.refs?.map((r, i) => (
        <RefCard key={i} r={r} />
      ))}
      {t.tools.length > 0 ? (
        <div class="a-tools">
          {t.tools.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      ) : null}
      <div class="a">
        {t.answer !== "" ? <Markdown text={t.answer} /> : null}
        {t.state === "running" ? <div class="muted typing">Reading the run…</div> : null}
        {t.state === "failed" ? (
          <div class="t-bad">{t.error ?? "The agent did not answer."}</div>
        ) : null}
        {t.state === "done" ? (
          <div class="a-foot">
            {t.cost !== undefined ? <span class="muted">${t.cost.toFixed(2)}</span> : <span />}
            {props.onComment ? (
              <button type="button" class="link" onClick={() => props.onComment?.(t.answer)}>
                Use as a comment
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The note on picked lines: what the person wants to know about them. */
export function AskNoteSheet(props: {
  place: string;
  code: string;
  onClose: () => void;
  onAdd: (note: string, now: boolean) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Modal
      title="Ask about these lines"
      onClose={props.onClose}
      actions={
        <>
          <button type="button" class="btn" onClick={() => props.onAdd(note.trim(), false)}>
            Add
          </button>
          <button type="button" class="btn primary" onClick={() => props.onAdd(note.trim(), true)}>
            Ask now
          </button>
        </>
      }
    >
      <code class="sheet-place">{props.place}</code>
      <pre class="ref-code">{props.code}</pre>
      <TextBox value={note} placeholder="What do you want to know?" onInput={setNote} />
    </Modal>
  );
}

export function AskPanel(props: {
  runId: string;
  title: string;
  drafts: AskRef[];
  onDrafts: (next: AskRef[]) => void;
  onClose: () => void;
  notify: (text: string, ok: boolean) => void;
  onComment?: (text: string) => void;
}) {
  const [thread, setThread] = useState<AskThread | undefined>();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const running = thread?.turns.some((t) => t.state === "running") ?? false;
  const count = thread?.turns.length ?? 0;
  const answered = thread?.turns.at(-1)?.answer.length ?? 0;

  // The page under the panel does not scroll with it.
  useEffect(() => {
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = was;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .askThread(props.runId)
        .then((t) => live && setThread(t))
        .catch((e: Error) => live && props.notify(e.message, false));
    void read();
    // While the agent answers, the thread is read again every second.
    const timer = running ? setInterval(read, 1_000) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [props.runId, running]);

  // The newest turn is in view: when it is added, and as its answer grows.
  useEffect(() => {
    const b = body.current;
    if (b) b.scrollTop = b.scrollHeight;
  }, [count, answered, props.drafts.length]);

  const canSend = !busy && !running && (question.trim() !== "" || props.drafts.length > 0);
  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      setThread(await api.ask(props.runId, question.trim(), props.drafts));
      setQuestion("");
      props.onDrafts([]);
    } catch (e) {
      props.notify((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="panel" role="dialog" aria-modal="true" aria-label="Agent">
      <header class="bar">
        <div class="bar-title">
          <h1 class="small">Agent</h1>
          <span class="bar-sub">{props.title}</span>
        </div>
        <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div class="panel-body" ref={body}>
        {thread === undefined ? <p class="empty">Loading…</p> : null}
        {thread?.turns.length === 0 && props.drafts.length === 0 ? (
          <p class="empty">
            Ask why the agent did something, or pick lines in Review and ask about them. A read-only
            copy of its session answers: nothing it does changes the run.
          </p>
        ) : null}
        {thread?.turns.map((t, i) => (
          <Turn
            key={`${i}:${t.at}`}
            t={t}
            {...(props.onComment ? { onComment: props.onComment } : {})}
          />
        ))}
      </div>
      <div class="panel-foot">
        {props.drafts.length > 0 ? (
          <div class="drafts">
            {props.drafts.map((r, i) => (
              <RefCard
                key={`${i}:${r.place}`}
                r={r}
                onRemove={() => props.onDrafts(props.drafts.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        ) : null}
        <div class="ask-box">
          <textarea
            rows={2}
            value={question}
            placeholder={
              running
                ? "Wait for the answer…"
                : props.drafts.length > 0
                  ? "Anything to add (optional)"
                  : "Ask about this run"
            }
            disabled={running}
            onInput={(e) => setQuestion((e.target as HTMLTextAreaElement).value)}
          />
          <button type="button" class="btn primary" disabled={!canSend} onClick={send}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
