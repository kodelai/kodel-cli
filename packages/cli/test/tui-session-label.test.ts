/**
 * The name of the agent session in the TUI: read from the journal (never from a transcript), shown instead
 * of the slug in the list and apart from it on the top of a run's card. The name is text the agent's own
 * session can write, so it only labels a row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalRecord, NextStep, RunState } from "@kodel-ai/pipeline-core";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { demoGateDetail, demoSessions } from "../src/tui/demo";
import { isGuess, labelText, renderLabel, rowLabels, sessionLine } from "../src/tui/label";
import {
  agentSessionOf,
  lastSession,
  loadSessions,
  logLines,
  type RunHandle,
  type SessionSource,
  sessionName,
} from "../src/tui/load";
import type { AgentSession, GateDetail, Session } from "../src/tui/session";
import { headerBand } from "../src/tui/tabs";
import { detailKey, initialModel, ordered, render, update, withDetail } from "../src/tui/view";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const MIN = 60_000;
const plain = (lines: string[]) => lines.map(stripAnsi);

// ── journals ────────────────────────────────────────────────────────────────

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

const rec = (event: string, rest: Record<string, unknown> = {}, minutesAgo = 5): JournalRecord => ({
  v: 2,
  seq: 1,
  ts: NOW - minutesAgo * MIN,
  event,
  ...rest,
});
const by = (
  event: string,
  session: string,
  source: string,
  name?: string,
  minutesAgo = 5,
): JournalRecord =>
  rec(
    event,
    {
      executor: {
        session: { value: session, source },
        ...(name === undefined ? {} : { session_name: { value: name, source: "derived" } }),
      },
    },
    minutesAgo,
  );
const named = (session: string, name: string): JournalRecord =>
  rec("agent_session_named", { session, name });

describe("session_label the session and its name in the journal", () => {
  test("session_label_is_the_newest_session_record_in_file_order", () => {
    // equal ts on purpose: only the order of the records says which is newer
    const journal = [
      by("run_started", S1, "observed-env", "old name", 5),
      by("agent_completed", S2, "observed-env", "new name", 5),
    ];
    expect(agentSessionOf(journal)).toEqual({
      id: S2,
      source: "observed-env",
      name: "new name",
      proven: false,
    });
  });

  test("session_label_a_step_served_of_a_new_session_wins_over_the_old_completion", () => {
    const journal = [
      by("run_started", S1, "observed-env", "a"),
      by("agent_completed", S1, "observed-env", "a"),
      by("step_served", S2, "observed-env", "b"),
    ];
    expect(lastSession(journal)?.id).toBe(S2);
  });

  test("session_label_a_newest_record_without_a_name_keeps_the_older_name", () => {
    const journal = [
      by("run_started", S1, "observed-env", "kept"),
      by("agent_completed", S1, "observed-env"),
    ];
    expect(agentSessionOf(journal)?.name).toBe("kept");
  });

  test("session_label_the_name_is_the_newest_of_a_record_and_an_event", () => {
    const record = by("agent_completed", S1, "observed-env", "from a record");
    expect(sessionName([record, named(S1, "from an event")], S1).name).toBe("from an event");
    expect(sessionName([named(S1, "from an event"), record], S1).name).toBe("from a record");
  });

  test("session_label_an_event_for_another_session_does_not_alter_the_row", () => {
    const journal = [by("agent_completed", S1, "observed-env", "mine"), named(S2, "theirs")];
    expect(agentSessionOf(journal)).toEqual({
      id: S1,
      source: "observed-env",
      name: "mine",
      proven: false,
    });
  });

  test("session_label_a_hook_record_after_an_env_one_gives_the_hook_source", () => {
    const journal = [
      by("run_started", S1, "observed-env", "n"),
      by("agent_completed", S1, "observed-hook", "n"),
    ];
    expect(agentSessionOf(journal)?.source).toBe("observed-hook");
  });

  test("session_label_an_event_proves_the_session", () => {
    const journal = [by("run_started", S1, "observed-hook", "n"), named(S1, "n")];
    const found = agentSessionOf(journal) as AgentSession;
    expect(found.proven).toBe(true);
    expect(isGuess(found)).toBe(false);
    const unproven = agentSessionOf([by("run_started", S1, "observed-hook", "n")]);
    expect(isGuess(unproven as AgentSession)).toBe(true);
    expect(isGuess({ id: S1, source: "observed-env", proven: false })).toBe(false);
  });

  test("session_label_works_without_the_event", () => {
    const found = agentSessionOf([by("run_started", S1, "observed-env", "only a record")]);
    expect(found).toMatchObject({ name: "only a record", proven: false });
  });

  test("session_label_skips_invalid_journal_values", () => {
    const valid = by("run_started", S1, "observed-env", "valid");
    const bad = [
      by("agent_completed", "../x", "observed-env", "unsafe id"),
      by("agent_completed", "s".repeat(129), "observed-env", "too long"),
      by("agent_completed", S2, "made-up", "unknown source"),
      rec("agent_completed", { executor: { session: { value: 7, source: "observed-env" } } }),
      rec("agent_completed", { executor: "not an object" }),
      rec("gate_waiting", { executor: { session: { value: S2, source: "observed-env" } } }),
    ];
    // none of them is a session; the valid record before them is the answer
    expect(lastSession([valid, ...bad])?.id).toBe(S1);
    expect(lastSession(bad)).toBeUndefined();
    // a name that is not a string is no name
    const odd = rec("agent_completed", {
      executor: {
        session: { value: S1, source: "observed-env" },
        session_name: { value: 7, source: "derived" },
      },
    });
    expect(agentSessionOf([odd])).toEqual({ id: S1, source: "observed-env", proven: false });
  });

  test("session_label_the_name_is_cleaned_again_on_read", () => {
    const hostile = `‮evil​\u001b]0;pwn\u0007 name ${"x".repeat(300)}`;
    const found = agentSessionOf([by("run_started", S1, "observed-env", hostile)]);
    const name = found?.name ?? "";
    expect(name.startsWith("evil")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(120);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test is about them
    expect(/[\u0000-\u001f​‮]/.test(name)).toBe(false);
    expect(agentSessionOf([named(S1, "‮​")])).toBeUndefined();
  });

  test("session_label_a_session_id_that_redaction_changed_still_matches_its_events", () => {
    // the store redacts the record and the event alike, so both carry the same stand-in
    const id = "id-0123456789abcdef";
    const journal = [by("run_started", id, "observed-env", "n"), named(id, "n")];
    expect(agentSessionOf(journal)).toMatchObject({ id, proven: true });
  });

  test("session_label_the_card_journal_hides_the_event", () => {
    const lines = logLines(
      [rec("node_entered", { node: "a" }, 3), named(S1, "a name"), rec("gate_waiting", {}, 1)],
      NOW,
    );
    expect(lines.join("\n")).not.toContain("agent_session_named");
    expect(lines).toHaveLength(2);
  });
});

// ── loading ─────────────────────────────────────────────────────────────────

function state(): RunState {
  return {
    v: 2,
    runId: "r_1",
    task: "fix the wait timeout",
    specHash: "h",
    status: "running",
    startedAt: NOW - 30 * MIN,
    nodes: {},
    active: [],
    trail: [],
    nextVisitId: 1,
    seq: 1,
  } as unknown as RunState;
}

function source(journal: JournalRecord[], withState = true): SessionSource {
  const run: RunHandle = {
    integrityStatus: async () => "ok",
    sealStatus: async () => "open",
    inspect: async () => ({ node: {} }) as unknown as NextStep,
    journal: async () => journal,
  };
  return {
    runSummaries: async () => [
      {
        meta: {
          runId: "r_1",
          pipeline: "dev",
          task: "fix the wait timeout",
          slug: "fix-wait",
          createdAt: NOW - 30 * MIN,
        },
        state: withState ? state() : undefined,
      },
    ],
    open: async () => run,
    pipelineProposals: async () => [],
  };
}

const loadOne = async (journal: JournalRecord[], withState = true) => {
  const session = (await loadSessions(source(journal, withState), NOW)).sessions[0];
  if (!session) throw new Error("no session");
  return session;
};

describe("session_label loading", () => {
  test("session_label_the_loader_puts_the_session_on_the_run", async () => {
    const session = await loadOne([by("run_started", S1, "observed-env", "fix the list", 29)]);
    expect(session.title).toBe("fix-wait");
    expect(session.agentSession).toMatchObject({ id: S1, name: "fix the list" });
  });

  test("session_label_a_run_whose_state_cannot_be_read_has_no_session", async () => {
    const session = await loadOne([by("run_started", S1, "observed-env", "n")], false);
    expect(session.status).toBe("unreadable");
    expect(session.agentSession).toBeUndefined();
  });

  test("session_label_a_journal_that_names_no_session_gives_none", async () => {
    const session = await loadOne([rec("node_entered", { node: "a" })]);
    expect(session.agentSession).toBeUndefined();
  });

  test("session_label_quiet_detection_ignores_the_name_event", async () => {
    // the agent said its last word 12 minutes ago; a rename a minute ago is not a word of the agent
    const session = await loadOne([
      rec("node_entered", { node: "a" }, 12),
      named(S1, "renamed a minute ago"),
    ]);
    expect(session.activity).toBe("quiet");
    expect(session.step).toBe("quiet 12m");
  });
});

describe("session_label the TUI reads the journal, never a transcript", () => {
  let dir: string | undefined;
  let previous: string | undefined;
  afterEach(async () => {
    if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previous;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("session_label_tui_reads_the_journal_name_not_the_transcript", async () => {
    dir = await mkdtemp(join(tmpdir(), "kodel-tui-label-"));
    previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = dir;
    // a transcript for the session exists, with another name
    await mkdir(join(dir, "projects", "p"), { recursive: true });
    await writeFile(
      join(dir, "projects", "p", `${S1}.jsonl`),
      `${JSON.stringify({ type: "custom-title", customTitle: "from the transcript", sessionId: S1 })}\n`,
    );
    const session = await loadOne([by("run_started", S1, "observed-env", "from the journal")]);
    expect(session.agentSession?.name).toBe("from the journal");
  });

  test("session_label_no_screen_module_reads_a_transcript", async () => {
    const root = new URL("../src/tui/", import.meta.url).pathname;
    for (const file of await readdir(root)) {
      const text = await readFile(join(root, file), "utf8");
      for (const word of ["logFacts", "modelFromLog", "CLAUDE_CONFIG_DIR", ".claude/projects"]) {
        expect(text.includes(word), `${file} mentions ${word}`).toBe(false);
      }
    }
  });
});

// ── labels ──────────────────────────────────────────────────────────────────

const row = (id: string, title: string, agent?: Partial<AgentSession>): Session => ({
  id,
  title,
  pipeline: "dev",
  status: "running",
  activity: "agent",
  step: "implement",
  since: NOW - MIN,
  steps: [],
  log: [],
  ...(agent === undefined
    ? {}
    : { agentSession: { id: S1, source: "observed-env", proven: false, ...agent } }),
});

describe("session_label rows", () => {
  test("session_label_the_name_stands_for_the_slug_and_a_guess_is_marked", () => {
    const labels = rowLabels([
      row("r_a", "slug-a", { name: "Fix the list" }),
      row("r_b", "slug-b", { name: "A guess", source: "observed-hook" }),
      row("r_c", "slug-c", { name: "Proven", source: "observed-hook", proven: true }),
      row("r_d", "slug-d"),
      row("r_e", "slug-e", {}),
    ]);
    expect(labels.get("r_a")).toEqual({ name: "Fix the list", guess: false });
    expect(labels.get("r_b")).toEqual({ name: "A guess", guess: true });
    expect(labels.get("r_c")).toEqual({ name: "Proven", guess: false });
    // no name: the slug
    expect(labels.get("r_d")).toEqual({ name: "slug-d", guess: false });
    expect(labels.get("r_e")).toEqual({ name: "slug-e", guess: false });
  });

  test("session_label_rows_with_one_name_show_the_end_of_the_run_id", () => {
    const two = rowLabels([
      row("r_0aaa11111", "one", { name: "Shared" }),
      row("r_0bbb22222", "two", { name: "Shared" }),
    ]);
    expect(two.get("r_0aaa11111")?.suffix).toBe("r_0aaa11111".slice(-8));
    expect(two.get("r_0bbb22222")?.suffix).toBe("r_0bbb22222".slice(-8));
    const three = rowLabels([
      row("r_1", "a", { name: "Shared" }),
      row("r_2", "b", { name: "Shared" }),
      row("r_3", "c", { name: "Shared" }),
      row("r_4", "d", { name: "Alone" }),
    ]);
    expect([...three.values()].map((l) => l.suffix !== undefined)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test("session_label_a_name_equal_to_another_rows_slug_or_label_is_a_clash_for_both", () => {
    const labels = rowLabels([
      row("r_x", "fix-list", { name: "other task" }),
      row("r_y", "irrelevant", { name: "FIX-LIST" }),
      row("r_z", "z-slug"),
    ]);
    // the name of r_y reads like the slug of r_x
    expect(labels.get("r_x")?.suffix).toBeDefined();
    expect(labels.get("r_y")?.suffix).toBeDefined();
    expect(labels.get("r_z")?.suffix).toBeUndefined();
    // a row that falls back to its slug clashes with a name that equals it
    const fallback = rowLabels([row("r_p", "same"), row("r_q", "q", { name: "same" })]);
    expect(fallback.get("r_p")?.suffix).toBeDefined();
    expect(fallback.get("r_q")?.suffix).toBeDefined();
  });

  test("session_label_names_equal_after_case_and_width_folding_clash", () => {
    const labels = rowLabels([
      row("r_1", "a", { name: "Ｆix List" }),
      row("r_2", "b", { name: "fix list" }),
    ]);
    expect(labels.get("r_1")?.suffix).toBeDefined();
    expect(labels.get("r_2")?.suffix).toBeDefined();
  });

  test("session_label_a_name_with_a_separator_in_it_is_just_a_name", () => {
    const [label] = [...rowLabels([row("r_1", "a", { name: "left · right" })]).values()];
    expect(label).toEqual({ name: "left · right", guess: false });
  });

  test("session_label_rendering_keeps_the_end_of_the_id_and_cuts_the_name_first", () => {
    const label = {
      name: "A very long name of a session that does not fit",
      guess: true,
      suffix: "88k4fn12",
    };
    const text = stripAnsi(renderLabel(label, 24));
    expect(visibleLength(text)).toBeLessThanOrEqual(24);
    expect(text.endsWith(" · 88k4fn12")).toBe(true);
    expect(text).toContain("…");
    expect(labelText(label)).toBe("A very long name of a session that does not fit · 88k4fn12");
    // with room the whole name and the mark show
    expect(stripAnsi(renderLabel({ name: "short", guess: true }, 20))).toBe("short ?");
    // with no room for the mark it goes first
    const tight = stripAnsi(
      renderLabel({ name: "short name", guess: true, suffix: "88k4fn12" }, 15),
    );
    expect(tight).not.toContain("?");
    expect(tight.endsWith(" · 88k4fn12")).toBe(true);
  });

  test("session_label_wide_characters_are_counted_in_columns", () => {
    for (const name of ["日本語のタイトルです", "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂", "mixed 日本語 🙂 text"]) {
      for (const suffix of [undefined, "88k4fn12"]) {
        const rendered = renderLabel({ name, guess: false, ...(suffix ? { suffix } : {}) }, 18);
        expect(visibleLength(rendered)).toBeLessThanOrEqual(18);
        if (suffix) expect(stripAnsi(rendered).endsWith(` · ${suffix}`)).toBe(true);
      }
    }
    // a name cut to nothing but the ellipsis still leaves the end of the id
    const nothing = stripAnsi(
      renderLabel({ name: "日本語", guess: false, suffix: "88k4fn12" }, 11),
    );
    expect(nothing.endsWith("88k4fn12")).toBe(true);
  });

  test("session_label_the_session_line", () => {
    const base = { id: "9f3c2a71-5d0e-4b86-a1c4-0c7e2d9b3f10", source: "observed-env" as const };
    expect(sessionLine({ ...base, name: "fix the list", proven: false })).toBe(
      "session «fix the list» · 9f3c2a71",
    );
    expect(sessionLine({ ...base, proven: false })).toBe("session 9f3c2a71");
    expect(sessionLine({ ...base, source: "observed-hook", name: "n", proven: false })).toBe(
      "session «n» · 9f3c2a71 (maybe)",
    );
    expect(sessionLine({ ...base, source: "observed-hook", name: "n", proven: true })).toBe(
      "session «n» · 9f3c2a71",
    );
    const cut = sessionLine({ ...base, name: "x".repeat(200), proven: false }, 40);
    expect(visibleLength(cut)).toBeLessThanOrEqual(40);
    expect(cut.endsWith("» · 9f3c2a71")).toBe(true);
  });
});

// ── the screens ─────────────────────────────────────────────────────────────

const SIZE = { cols: 120, rows: 44 };
const demo = () => initialModel(demoSessions(NOW), "demo", NOW);
const listPart = (m: ReturnType<typeof demo>, size = SIZE) =>
  plain(render(m, size))
    .map((l) => l.slice(0, 50))
    .join("\n");
const cardPart = (m: ReturnType<typeof demo>, size = SIZE) =>
  plain(render(m, size))
    .map((l) => l.slice(52))
    .join("\n");

describe("session_label the list", () => {
  test("session_label_demo_shows_a_name_a_guess_a_proven_session_and_a_shared_session", () => {
    const { sessions } = demoSessions(NOW);
    const agents = sessions.flatMap((s) => (s.agentSession ? [s.agentSession] : []));
    expect(agents.some((a) => isGuess(a))).toBe(true);
    expect(agents.some((a) => a.proven)).toBe(true);
    expect(agents.some((a) => a.name === undefined)).toBe(true);
    const shared = agents.filter((a) => a.name === "docs fixes");
    expect(shared).toHaveLength(2);
  });

  test("session_label_the_list_shows_the_name_instead_of_the_slug", () => {
    const list = listPart(demo());
    expect(list).toContain("usage and cost capture");
    expect(list).not.toContain("capture-usage-cost");
    // no name: the slug
    expect(list).toContain("report-pdf-export");
  });

  test("session_label_a_guess_carries_a_question_mark", () => {
    const list = listPart(demo());
    const guess = list.split("\n").find((l) => l.includes("pipeline format")) ?? "";
    expect(guess).toContain("pipeline format ?");
    const exact = list.split("\n").find((l) => l.includes("usage and cost capture")) ?? "";
    expect(exact).not.toContain("?");
  });

  test("session_label_rows_that_clash_show_the_end_of_the_run_id", () => {
    const lines = listPart(demo())
      .split("\n")
      .filter((l) => l.includes("docs fixes"));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes(` · ${"r_0vb88k4fn".slice(-8)}`))).toBe(true);
    expect(lines.some((l) => l.includes(` · ${"r_0t55c8k21".slice(-8)}`))).toBe(true);
  });

  test("session_label_no_row_is_wider_than_the_screen_with_wide_names", () => {
    const wide = demoSessions(NOW);
    const sessions = wide.sessions.map((s, i) =>
      s.agentSession
        ? {
            ...s,
            agentSession: {
              ...s.agentSession,
              name: i % 2 === 0 ? "日本語のタイトル🙂🙂🙂🙂🙂🙂🙂🙂🙂" : "🙂".repeat(30),
            },
          }
        : s,
    );
    const m = initialModel({ ...wide, sessions }, "demo", NOW);
    for (const cols of [60, 80, 120]) {
      for (const line of render(m, { cols, rows: 30 })) {
        expect(visibleLength(line)).toBeLessThanOrEqual(cols);
      }
    }
  });

  test("session_label_the_selection_and_the_keys_follow_the_row_not_its_label", () => {
    const m = demo();
    const second = ordered(m.sessions).filter((s) => s.agentSession?.name === "docs fixes")[1];
    const chosen = { ...m, selected: second?.id ?? "" };
    const asked = update(chosen, "a");
    expect(asked.selected).toBe(second?.id ?? "");
    expect(asked.confirm).toBe("a");
  });
});

describe("session_label the top of a run's card", () => {
  const first = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
  const withBand = () => {
    const g = first();
    return withDetail(
      { ...demo(), selected: g.id },
      detailKey(g),
      demoGateDetail(g.id, NOW) as GateDetail,
    );
  };

  test("session_label_the_plain_card_shows_the_slug_and_the_session_apart", () => {
    const m = { ...demo(), selected: "r_1kd93xa07" };
    const card = cardPart(m);
    expect(card).toContain("pipeline-format-version");
    expect(card).toContain("session «pipeline format» · 4be81f06 (maybe)");
  });

  test("session_label_without_a_name_the_card_shows_the_id_only", () => {
    const m = { ...demo(), selected: "r_1kd9q22vb" };
    expect(cardPart(m)).toContain("session 2a6e94d8");
    expect(cardPart(m)).not.toContain("«");
  });

  test("session_label_no_session_no_line", () => {
    const m = { ...demo(), selected: "r_0zz41pe8c" };
    expect(cardPart(m)).not.toContain("session ");
  });

  test("session_label_the_band_keeps_the_slug_and_adds_the_line", () => {
    const text = cardPart(withBand());
    expect(text).toContain("capture-usage-cost");
    expect(text).toContain("session «usage and cost capture» · 9f3c2a71");
    expect(text).not.toContain("(maybe)");
  });

  test("session_label_the_compact_band_keeps_its_height", () => {
    const s = first();
    const detail = demoGateDetail(s.id, NOW) as GateDetail;
    const without = { ...s, agentSession: undefined } as Session;
    for (const compact of [true, false]) {
      const a = headerBand(s, detail, 80, "●", NOW, compact);
      const b = headerBand(without, detail, 80, "●", NOW, compact);
      // full mode has a line of its own for the session; compact mode does not
      expect(a.length - b.length).toBe(compact ? 0 : 1);
    }
    const hostile = {
      ...s,
      agentSession: { ...(s.agentSession as AgentSession), name: "y".repeat(500) },
    };
    const compact = plain(headerBand(hostile, detail, 80, "●", NOW, true));
    expect(compact[0]).toContain("capture-usage-cost".slice(0, 8));
    for (const line of compact) expect(visibleLength(line)).toBeLessThanOrEqual(80);
    expect(compact.join("\n")).toContain("» · 9f3c2a71");
  });

  test("session_label_a_name_cannot_pose_as_a_state_or_act_on_the_terminal", () => {
    const g = first();
    const m0 = withBand();
    for (const name of [
      "approved",
      "run r_0mvo6g4mi",
      "\u001b]0;pwn\u0007title",
      "\u001b[2Jclear",
    ]) {
      const sessions = m0.sessions.map((s) =>
        s.id === g.id ? { ...s, agentSession: { ...(s.agentSession as AgentSession), name } } : s,
      );
      const out = render({ ...m0, sessions }, SIZE).join("\n");
      expect(out.includes("\u001b]")).toBe(false);
      expect(out.includes("\u001b[2J")).toBe(false);
      // the slug is still the title of the card
      expect(plain(render({ ...m0, sessions }, SIZE)).join("\n")).toContain("capture-usage-cost");
    }
  });
});

describe("session_label the confirmation", () => {
  test("session_label_the_confirmation_shows_the_slug_the_end_of_the_run_id_and_the_row", () => {
    const m = update({ ...demo(), selected: "r_0mvo6g4mi" }, "a");
    expect(m.confirm).toBe("a");
    const bottom = plain(render(m, SIZE)).at(-1) ?? "";
    expect(bottom).toContain("«capture-usage-cost»");
    expect(bottom).toContain(` · ${"r_0mvo6g4mi".slice(-8)}`);
    expect(bottom).toContain("row «usage and cost capture»");
  });

  test("session_label_a_run_without_a_name_gets_the_slug_and_the_id_end_only", () => {
    const sessions = demoSessions(NOW).sessions.map((s) =>
      s.id === "r_0mvo6g4mi" ? { ...s, agentSession: undefined } : s,
    );
    const m = update(
      { ...initialModel({ ...demoSessions(NOW), sessions }, "demo", NOW), selected: "r_0mvo6g4mi" },
      "a",
    );
    const bottom = plain(render(m, SIZE)).at(-1) ?? "";
    expect(bottom).toContain("«capture-usage-cost»");
    expect(bottom).not.toContain("row «");
  });
});
