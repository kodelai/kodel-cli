/**
 * How a run is called in the list and on the top of its card: by the name of the agent session it
 * works in (kept in the journal, see `load.ts`), else by its slug. The name is text the agent's own
 * session can write, so it only labels a row: a gate prompt also shows what the agent cannot write.
 */
import { clip, dim, visibleLength } from "./ansi";
import type { AgentSession, Session } from "./session";

/** A session whose id is a guess: it did not come from the environment of the server and no copy of its log proved it. */
export function isGuess(session: AgentSession): boolean {
  return session.source !== "observed-env" && !session.proven;
}

/** What identifies a name for the purpose of telling two labels apart: letters of one script in the other case and form are the same. */
const fold = (text: string): string => text.normalize("NFKC").toLowerCase();

/** How much of the id of the run is shown where two rows would read the same. */
const ID_END = 8;

export interface RowLabel {
  /** The session name, else the slug. */
  name: string;
  /** The name is of a session that is only a guess. */
  guess: boolean;
  /** The end of the id of the run, where the label alone does not tell the row from another. */
  suffix?: string;
}

/**
 * The label of every row. Two rows clash when their labels are the same after folding, or when the label
 * of one is the slug of the other; every row of a clash shows the end of the id of its run as well, which
 * is not text anybody but the engine writes.
 */
export function rowLabels(sessions: readonly Session[]): Map<string, RowLabel> {
  const rows = sessions.map((s) => {
    const agent = s.agentSession;
    const named = agent?.name !== undefined;
    return {
      id: s.id,
      slug: fold(s.title),
      name: named ? (agent?.name as string) : s.title,
      guess: named && agent !== undefined && isGuess(agent),
    };
  });
  const out = new Map<string, RowLabel>();
  for (const row of rows) {
    const label = fold(row.name);
    const clash = rows.some(
      (other) =>
        other.id !== row.id &&
        (label === fold(other.name) || label === other.slug || row.slug === fold(other.name)),
    );
    out.set(row.id, {
      name: row.name,
      guess: row.guess,
      ...(clash ? { suffix: row.id.slice(-ID_END) } : {}),
    });
  }
  return out;
}

/** The label as plain text, for a line that is not a row. */
export function labelText(label: RowLabel): string {
  return label.suffix === undefined ? label.name : `${label.name} · ${label.suffix}`;
}

/**
 * The label for a row `width` columns wide: the name is shortened first, then the mark of a guess goes;
 * the end of the id stays.
 */
export function renderLabel(label: RowLabel, width: number): string {
  const suffix = label.suffix === undefined ? "" : ` · ${label.suffix}`;
  const suffixColumns = visibleLength(suffix);
  const markColumns = label.guess ? 2 : 0;
  const mark = label.guess && width - suffixColumns - markColumns >= 4 ? " ?" : "";
  const room = Math.max(1, width - suffixColumns - visibleLength(mark));
  const name = clip(label.name, room);
  return `${name}${mark === "" ? "" : dim(mark)}${suffix === "" ? "" : dim(suffix)}`;
}

/** `session «name» · a1b2c3d4`, with `(maybe)` for a guess; the name is shortened to `maxColumns` columns of the whole. */
export function sessionLine(session: AgentSession, maxColumns = 200): string {
  const id = session.id.slice(0, 8);
  const tail = isGuess(session) ? " (maybe)" : "";
  if (session.name === undefined) return `session ${id}${tail}`;
  const fixed = visibleLength(`session «» · ${id}${tail}`);
  return `session «${clip(session.name, Math.max(1, maxColumns - fixed))}» · ${id}${tail}`;
}
