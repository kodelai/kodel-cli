/**
 * Run attachments (T-45), the pure part: names, the journal event, the format rule, the limits, and the
 * tools a host with attachments serves.
 */
import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_LIMITS,
  type AttachmentRecord,
  attachmentLimitProblem,
  attachmentNameProblem,
  attachmentRecords,
  attachmentRef,
  attachmentsFingerprint,
  attachmentTypeOfName,
  capabilitiesOf,
  countLines,
  decide,
  encodeRunState,
  formatAttachmentLocation,
  isAttachmentRef,
  type JournalRecord,
  KodelError,
  latestAttachments,
  type PipelineHost,
  PipelineService,
  type PipelineSpec,
  parseAttachmentLocation,
  parsePipeline,
  type RunEvent,
  type RunHandle,
  type RunState,
  readRunState,
  V1_EVENTS,
  V2_ONLY_EVENTS,
  versionOfVisit,
  visitStartSeq,
} from "../src";
import {
  ATTACHMENT_TOOLS,
  invokeTool,
  SERVER_INSTRUCTIONS,
  serverInstructions,
  TOOLS,
  toolsFor,
} from "../src/mcp";

const SPEC = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: gate, kind: human, prompt: ok? }",
    "  - { slug: impl, kind: agent, prompt: build }",
    "edges:",
    "  - { from: plan, to: gate }",
    "  - { from: gate, to: impl, when: approved }",
    "  - { from: gate, to: plan, when: rejected }",
    "",
  ].join("\n"),
);

const SHA = "a".repeat(64);
const start = (): RunEvent => ({ type: "start", runId: "r1", task: "t", specHash: "h" });

function apply(spec: PipelineSpec, state: RunState | undefined, event: RunEvent, now = 10) {
  const decision = decide(spec, state, event, now);
  if (!decision.ok) throw decision.error;
  return decision;
}

const written = (over: Partial<Extract<RunEvent, { type: "attachment_written" }>> = {}) =>
  ({
    type: "attachment_written",
    node: "plan",
    attempt: 1,
    name: "plan.md",
    version: 1,
    ref: attachmentRef(SHA, over.name ?? "plan.md"),
    fileType: "text",
    bytes: 12,
    lines: 2,
    sha256: SHA,
    scanned: true,
    ...over,
  }) as RunEvent;

const record = (over: Partial<AttachmentRecord> = {}): AttachmentRecord => ({
  seq: 1,
  ts: 1,
  node: "plan",
  attempt: 1,
  name: "plan.md",
  version: 1,
  ref: attachmentRef(SHA, over.name ?? "plan.md"),
  type: "text",
  bytes: 10,
  sha256: SHA,
  scanned: true,
  ...over,
});

describe("t45 the name of an attachment", () => {
  test("t45_name_table", () => {
    for (const good of ["plan.md", "a.txt", "shot-1.png", "data_2.json", "x.y.yaml", "p.jpeg"]) {
      expect(attachmentNameProblem(good), good).toBeUndefined();
    }
    const bad = [
      "PLAN.md",
      "con.md",
      "nul.txt",
      "com1.log",
      "plan.md.",
      "plan.md ",
      "plan\0.md",
      "..",
      "../a.md",
      "a/b.md",
      "a\\b.md",
      "plan",
      ".md",
      "tool.exe",
      "doc.pdf",
      `${"a".repeat(62)}.md`,
      "",
      42,
      undefined,
    ];
    for (const name of bad) {
      expect(attachmentNameProblem(name), String(name)).toBeString();
    }
    // 64 characters is the bound: the 65th is refused
    expect(attachmentNameProblem(`${"a".repeat(61)}.md`)).toBeUndefined();
    expect(attachmentTypeOfName("plan.md")).toBe("text");
    expect(attachmentTypeOfName("a.jpg")).toBe("jpeg");
    expect(attachmentTypeOfName("a.jpeg")).toBe("jpeg");
    expect(attachmentTypeOfName("a.webp")).toBe("webp");
    expect(attachmentTypeOfName("a.pdf")).toBeUndefined();
  });

  test("t45_a_ref_never_leaves_the_attachments_folder", () => {
    expect(isAttachmentRef(attachmentRef(SHA, "plan.md"), SHA, "plan.md")).toBe(true);
    expect(isAttachmentRef(attachmentRef(SHA, "plan.md", 3), SHA, "plan.md")).toBe(true);
    for (const ref of [
      `attachments/../${SHA}-plan.md`,
      `attachments/${SHA}/../plan.md`,
      `attachments/${SHA}~0-plan.md`,
      `attachments/${SHA}-other.md`,
      `changes/${SHA}-plan.md`,
      42,
    ]) {
      expect(isAttachmentRef(ref, SHA, "plan.md"), String(ref)).toBe(false);
    }
  });

  test("t45_lines_are_counted_as_stored", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\n\n")).toBe(2);
  });
});

describe("t45 the event of a version", () => {
  test("t45_write_needs_an_open_agent_step", () => {
    const begun = apply(SPEC, undefined, start()).state;
    const ok = apply(SPEC, begun, written());
    expect(ok.journal.map((r) => r.event)).toEqual(["attachment_written"]);
    expect(ok.journal[0]).toMatchObject({
      node: "plan",
      attempt: 1,
      name: "plan.md",
      version: 1,
      type: "text",
      sha256: SHA,
      scanned: true,
      claim: "none",
    });
    // no content, and no field of the event that is not the record's
    expect(Object.keys(ok.journal[0] ?? {}).sort()).toEqual(
      [
        "attempt",
        "bytes",
        "claim",
        "event",
        "lines",
        "name",
        "node",
        "ref",
        "scanned",
        "seq",
        "sha256",
        "ts",
        "type",
        "v",
        "version",
      ].sort(),
    );

    const code = (state: RunState, event: RunEvent) => {
      const decision = decide(SPEC, state, event, 10);
      return decision.ok ? "ok" : decision.error.code;
    };
    expect(code(begun, written({ attempt: 2 }))).toBe("ATTEMPT_MISMATCH");
    expect(code(begun, written({ node: "impl" }))).toBe("NODE_NOT_RUNNING");
    expect(code(begun, written({ node: "nope" }))).toBe("UNKNOWN_NODE");
    // at the gate nothing is an open agent step: neither the gate nor the step before it
    const atGate = apply(SPEC, begun, { type: "agent_completed", node: "plan", attempt: 1 }).state;
    expect(atGate.active.map((v) => v.phase)).toEqual(["human"]);
    expect(code(atGate, written({ node: "gate" }))).toBe("NODE_NOT_RUNNING");
    expect(code(atGate, written())).toBe("NODE_NOT_RUNNING");
    // and after the end
    const canceled = apply(SPEC, begun, { type: "cancel" }).state;
    expect(code(canceled, written())).toBe("NODE_NOT_RUNNING");
  });

  test("t45_a_record_that_would_not_read_back_is_not_written", () => {
    const begun = apply(SPEC, undefined, start()).state;
    for (const over of [
      { name: "PLAN.md" },
      { ref: `attachments/../${SHA}-plan.md` },
      { sha256: "zz" },
      { fileType: "png" as const },
      { scanned: false },
      { version: 0 },
      { bytes: -1 },
    ]) {
      const decision = decide(SPEC, begun, written(over), 10);
      expect(decision.ok, JSON.stringify(over)).toBe(false);
    }
  });

  test("t45_write_never_touches_the_claim", () => {
    const begun = apply(SPEC, undefined, start()).state;
    const claimed = apply(SPEC, begun, {
      type: "step_claimed",
      node: "plan",
      token: "hash-1",
      ttlMs: 60_000,
    }).state;
    const claim = structuredClone(claimed.nodes.plan?.claim);
    expect(claim).toBeDefined();

    const own = apply(SPEC, claimed, written({ claimToken: "hash-1" }), 20);
    expect(own.journal[0]?.claim).toBe("matched");
    const foreign = apply(SPEC, claimed, written({ claimToken: "hash-2" }), 20);
    expect(foreign.journal[0]?.claim).toBe("foreign");
    const none = apply(SPEC, claimed, written(), 20);
    expect(none.journal[0]?.claim).toBe("foreign");

    for (const decision of [own, foreign, none]) {
      // the claim is as it was: not renewed, not released, and no claim event was journaled
      expect(decision.state.nodes.plan?.claim).toEqual(claim as NonNullable<typeof claim>);
      expect(decision.state.claimEvents).toEqual(claimed.claimEvents as never);
      // only `seq` of the state moves
      expect({ ...decision.state, seq: claimed.seq }).toEqual(claimed);
      expect(decision.state.seq).toBe(claimed.seq + 1);
      expect(decision.effects).toEqual([]);
    }
  });

  test("t45_format_1_refuses_an_attachment", () => {
    expect(capabilitiesOf(1).attachments).toBe(false);
    expect(capabilitiesOf(2).attachments).toBe(true);
    expect(V2_ONLY_EVENTS).toContain("attachment_written");
    expect(V1_EVENTS).not.toContain("attachment_written");
    const begun = apply(SPEC, undefined, start());
    const raw = JSON.parse(JSON.stringify(begun.encoded?.state)) as Record<string, unknown>;
    raw.v = 1;
    delete raw.pauses;
    for (const visit of raw.active as Record<string, unknown>[]) delete visit.spec;
    const v1 = readRunState(JSON.stringify(raw), "r1");
    const before = JSON.stringify(encodeRunState(v1));
    const decision = decide(SPEC, v1, written(), 10);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
    expect(decision.error.details).toMatchObject({ how_to_upgrade: { cli: "kodel migrate r1" } });
    expect(JSON.stringify(encodeRunState(v1))).toBe(before);
  });

  test("t45_an_engine_that_skips_the_event_decides_the_same", () => {
    // Rule 5: the event changes nothing in the state but `seq`, so an engine that ignores the record
    // has nothing to drop on a write-back and decides every later step the same way.
    const begun = apply(SPEC, undefined, start()).state;
    const withIt = apply(SPEC, begun, written()).state;
    const done = (state: RunState) => {
      const next = apply(SPEC, state, { type: "agent_completed", node: "plan", attempt: 1 });
      return { ...next.state, seq: 0 };
    };
    expect(done(withIt)).toEqual(done(begun));
  });
});

describe("t45 the history of a name", () => {
  const journalOf = (records: Partial<JournalRecord>[]): JournalRecord[] =>
    records.map((r, i) => ({ v: 2, seq: i + 1, ts: i + 1, event: "x", ...r }) as JournalRecord);
  const line = (over: Record<string, unknown> = {}) => ({
    event: "attachment_written",
    node: "plan",
    attempt: 1,
    name: "plan.md",
    version: 1,
    ref: attachmentRef(SHA, "plan.md"),
    type: "text",
    bytes: 10,
    sha256: SHA,
    scanned: true,
    ...over,
  });

  test("t45_records_come_from_the_journal_and_malformed_ones_are_not_versions", () => {
    const journal = journalOf([
      line(),
      line({ version: 2 }),
      line({ name: "../x.md" }),
      line({ ref: "attachments/elsewhere" }),
      line({ type: "png" }),
      line({ name: "shot.png", type: "png", scanned: false, ref: attachmentRef(SHA, "shot.png") }),
      { event: "node_entered", node: "plan" },
    ]);
    const records = attachmentRecords(journal);
    expect(records.map((r) => [r.name, r.version, r.seq])).toEqual([
      ["plan.md", 1, 1],
      ["plan.md", 2, 2],
      ["shot.png", 1, 6],
    ]);
    expect(latestAttachments(records).map((r) => [r.name, r.version])).toEqual([
      ["plan.md", 2],
      ["shot.png", 1],
    ]);
    expect(attachmentsFingerprint(records)).toBe("plan.md@2;shot.png@6");
    expect(attachmentsFingerprint([])).toBeUndefined();
  });

  test("t45_a_visit_begins_at_the_entry_that_is_not_a_retry", () => {
    const journal = journalOf([
      { event: "node_entered", node: "plan", rework: false },
      line({ version: 1 }),
      { event: "node_entered", node: "plan", rework: true },
      { event: "node_entered", node: "impl", rework: false },
      line({ version: 2, node: "impl" }),
      line({ version: 3, claim: "foreign" }),
    ]);
    expect(visitStartSeq(journal, "plan")).toBe(1);
    expect(visitStartSeq(journal, "impl")).toBe(4);
    expect(visitStartSeq(journal, "nope")).toBe(0);
    // the retry did not begin a new visit; another node's version and a foreign write do not count
    expect(versionOfVisit(journal, "plan", "plan.md")?.version).toBe(1);
    expect(versionOfVisit(journal, "impl", "plan.md")?.version).toBe(2);
    const entered = journalOf([...journal, { event: "node_entered", node: "plan", rework: false }]);
    expect(versionOfVisit(entered, "plan", "plan.md")).toBeUndefined();
  });

  test("t45_limits_name_the_bound", () => {
    const fits = { name: "plan.md", type: "text" as const, bytes: 10, stored: true };
    expect(attachmentLimitProblem([], fits)).toBeUndefined();
    expect(
      attachmentLimitProblem([], { ...fits, bytes: ATTACHMENT_LIMITS.textBytes }),
    ).toBeUndefined();
    expect(
      attachmentLimitProblem([], { ...fits, bytes: ATTACHMENT_LIMITS.textBytes + 1 }),
    ).toContain(String(ATTACHMENT_LIMITS.textBytes));
    const image = { name: "a.png", type: "png" as const, stored: true };
    expect(
      attachmentLimitProblem([], { ...image, bytes: ATTACHMENT_LIMITS.imageBytes }),
    ).toBeUndefined();
    expect(
      attachmentLimitProblem([], { ...image, bytes: ATTACHMENT_LIMITS.imageBytes + 1 }),
    ).toContain(String(ATTACHMENT_LIMITS.imageBytes));

    const names = Array.from({ length: ATTACHMENT_LIMITS.names }, (_, i) =>
      record({ name: `n${i}.md`, ref: attachmentRef(SHA, `n${i}.md`) }),
    );
    expect(attachmentLimitProblem(names.slice(1), fits)).toBeUndefined();
    expect(attachmentLimitProblem(names, fits)).toContain(
      `${ATTACHMENT_LIMITS.names} attachment names`,
    );
    // a new version of a name the run has is not a new name
    expect(attachmentLimitProblem(names, { ...fits, name: "n0.md" })).toBeUndefined();

    const versions = Array.from({ length: ATTACHMENT_LIMITS.versions }, (_, i) =>
      record({ version: i + 1 }),
    );
    expect(attachmentLimitProblem(versions.slice(1), fits)).toBeUndefined();
    expect(attachmentLimitProblem(versions, fits)).toContain(
      `${ATTACHMENT_LIMITS.versions} attachment versions`,
    );

    const mb = 1024 * 1024;
    const big = Array.from({ length: 8 }, (_, i) =>
      record({
        name: "a.png",
        type: "png",
        scanned: false,
        bytes: 2 * mb,
        version: i + 1,
        sha256: String(i).repeat(64),
        ref: attachmentRef(String(i).repeat(64), "a.png"),
      }),
    );
    expect(attachmentLimitProblem(big.slice(1), { ...image, bytes: 2 * mb })).toBeUndefined();
    expect(attachmentLimitProblem(big, { ...image, bytes: 1 })).toContain(
      `${ATTACHMENT_LIMITS.runBytes} bytes`,
    );
    // a version that points to a file already kept adds no bytes
    expect(attachmentLimitProblem(big, { ...image, bytes: 2 * mb, stored: false })).toBeUndefined();
  });
});

describe("t45 the tools of a host with attachments", () => {
  const names = (tools: { name: string }[]) => tools.map((t) => t.name);

  test("t45_host_without_attachments", async () => {
    // a handle without the methods answers a failure and never throws
    const handle = { runId: "r_000000001_aaaa" } as unknown as RunHandle;
    const host = { open: async () => handle } as unknown as PipelineHost;
    const service = new PipelineService(host);
    const tools = toolsFor({ attachments: true });
    const run_id = "r_000000001_aaaa";
    for (const [tool, args] of [
      [
        "pipeline_attachment_write",
        { run_id, node_slug: "a", attempt: 1, name: "a.md", content: "x" },
      ],
      ["pipeline_attachment_read", { run_id, name: "a.md" }],
      ["pipeline_attachment_list", { run_id }],
    ] as const) {
      expect(await invokeTool(service, tool, args, tools), tool).toMatchObject({
        ok: false,
        code: "INVALID_ARGUMENTS",
        message: "this server keeps no attachments",
      });
    }
    // the tools and the rule about them are there only on a host that keeps attachments
    expect(names(toolsFor())).toEqual(names(TOOLS));
    expect(names(toolsFor({ taskLink: true }))).toEqual(names(TOOLS));
    for (const taskLink of [false, true]) {
      expect(names(toolsFor({ taskLink, attachments: true }))).toEqual([
        ...names(TOOLS),
        ...names(ATTACHMENT_TOOLS),
      ]);
    }
    expect(SERVER_INSTRUCTIONS).not.toContain("pipeline_attachment");
    expect(serverInstructions({ attachments: true })).toContain("pipeline_attachment_write");
    expect(await invokeTool(service, "pipeline_attachment_list", { run_id })).toMatchObject({
      ok: false,
      message: 'there is no tool "pipeline_attachment_list"',
    });
  });

  test("t45_the_write_tool_takes_content_or_path_not_both", async () => {
    const calls: unknown[] = [];
    const handle = {
      runId: "r_000000001_aaaa",
      writeAttachment: async (input: unknown) => {
        calls.push(input);
        throw new KodelError("NODE_NOT_RUNNING", "no");
      },
    } as unknown as RunHandle;
    const service = new PipelineService({ open: async () => handle } as unknown as PipelineHost);
    const tools = toolsFor({ attachments: true });
    const base = { run_id: "r_000000001_aaaa", node_slug: "a", attempt: 1, name: "a.md" };
    for (const args of [base, { ...base, content: "x", path: "a.md" }]) {
      expect(await invokeTool(service, "pipeline_attachment_write", args, tools)).toMatchObject({
        ok: false,
        code: "INVALID_ARGUMENTS",
      });
    }
    expect(calls).toEqual([]);
    // a refusal of the host is a failure with its code, never a throw
    expect(
      await invokeTool(service, "pipeline_attachment_write", { ...base, content: "x" }, tools),
    ).toMatchObject({ ok: false, code: "NODE_NOT_RUNNING" });
    expect(calls).toEqual([{ node: "a", attempt: 1, name: "a.md", content: "x" }]);
  });
});

describe("t45 the location of a comment on an attachment", () => {
  test("t45_attachment_location_table", () => {
    // with a line
    expect(parseAttachmentLocation("attachment:plan.md@3:12")).toEqual({
      name: "plan.md",
      version: 3,
      line: 12,
    });
    // without a line: the version as a whole (an image takes only this form)
    expect(parseAttachmentLocation("attachment:shot.png@1")).toEqual({
      name: "shot.png",
      version: 1,
    });
    for (const location of [
      { name: "plan.md", version: 3, line: 12 },
      { name: "shot.png", version: 1 },
    ]) {
      expect(parseAttachmentLocation(formatAttachmentLocation(location))).toEqual(location);
    }
    // anything else is a project path, or plain text
    for (const bad of [
      "plan.md:12",
      "attachment:plan.md",
      "attachment:plan.md:12",
      "attachment:plan.md@0:1",
      "attachment:plan.md@1:0",
      "attachment:plan.md@x",
      "attachment:plan.md@1:2:3",
      "attachment:PLAN.md@1",
      "attachment:plan@1",
      "attachment:../plan.md@1",
      "attachment:a/b.md@1",
      "./attachment:plan.md@1:2",
      "attachments/plan.md:1",
      "attachment",
      "attachment:7",
      " attachment:plan.md@1",
      "attachment:plan.md@1 (removed line)",
      "",
    ]) {
      expect(parseAttachmentLocation(bad), bad).toBeUndefined();
    }
  });
});
