/**
 * The attachments of a run on the card (T-45): a second group under Code, a text as the diff from its
 * version before, an image by its facts, and comments that point at a line of a version.
 */
import { describe, expect, test } from "bun:test";
import { NOT_SCANNED } from "@kodel-ai/pipeline-core";
import { stripAnsi } from "../src/tui/ansi";
import {
  attachmentCommentCount,
  attachmentKey,
  attachmentOf,
  fileCommentCount,
  parseAttachmentKey,
  projectPlace,
} from "../src/tui/attachments";
import { demoDiff, demoGateDetail, demoSessions } from "../src/tui/demo";
import { loadDiff, loadRunDetail } from "../src/tui/gate";
import type { AttachmentView, Comment, GateDetail, Session } from "../src/tui/session";
import { diffKey, itemCount } from "../src/tui/tabs";
import {
  detailKey,
  initialModel,
  render,
  takeEffects,
  update,
  withDetail,
  withDiff,
} from "../src/tui/view";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const SIZE = { cols: 120, rows: 44 };
const demo = () => initialModel(demoSessions(NOW), "demo", NOW);
type Model = ReturnType<typeof demo>;
const gate = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
const detail = () => demoGateDetail(gate().id, NOW) as GateDetail;
const withCard = (d: GateDetail = detail()) =>
  withDetail({ ...demo(), selected: gate().id }, detailKey(gate()), d);
const press = (m: Model, ...keys: string[]) => keys.reduce((acc, k) => update(acc, k, SIZE), m);
const text = (m: Model) => render(m, SIZE).map(stripAnsi).join("\n");
const n = (count: number, key: string) => Array<string>(count).fill(key);

/** The keys to the Code tab, then down to the row of an attachment (after the five files). */
const toAttachment = (index: number) => ["enter", "right", ...n(5 + index, "down")];

const V1 = "@@ -0,0 +1,3 @@\n+# Plan\n+\n+1. Read the status command.\n";
const V2 =
  "@@ -1,3 +1,4 @@\n # Plan\n \n-1. Read the status command.\n+1. Read the status command and its table.\n+2. Add the age column.\n";

/** The card with the plan opened and the diffs of its two versions read. */
function planOpened(d: GateDetail = detail()): Model {
  let m = press(withCard(d), ...toAttachment(0), "enter");
  m = takeEffects(m)[0];
  m = withDiff(m, diffKey(gate().id, attachmentKey("plan.md", 2)), {
    kind: "text",
    text: V2,
    truncated: false,
  });
  return withDiff(m, diffKey(gate().id, attachmentKey("plan.md", 1)), {
    kind: "text",
    text: V1,
    truncated: false,
  });
}

const comment = (location: string, description = "say more"): Comment => ({
  severity: "major",
  location,
  description,
});

describe("t45 the card names the attachments", () => {
  test("t45_tui_report_names_attachments", () => {
    const out = text(press(withCard(), "enter"));
    // one line under the changed files, so the decision stays in sight
    expect(out).toContain("ATTACHMENTS · 2 kept with the run: plan.md, status-table.png");
    expect(out.indexOf("ATTACHMENTS")).toBeGreaterThan(out.indexOf("CHANGED FILES"));
    expect(out.indexOf("YOUR DECISION")).toBeGreaterThan(out.indexOf("ATTACHMENTS"));
    expect(out).toContain("Code 5+2");
    // without a list of files they are still named, as their own group
    for (const changes of [
      { kind: "none" as const },
      { kind: "no_repo" as const },
      { kind: "unavailable" as const, reason: "git failed" },
    ]) {
      const bare = text(press(withCard({ ...detail(), changes }), "enter"));
      expect(bare, changes.kind).toContain("ATTACHMENTS · 2 kept with the run");
      expect(bare, changes.kind).toContain("Code 0+2");
    }
    // one written since the run stopped here is marked
    const d = detail();
    const fresh = (d.attachments ?? []).map((a, i) => (i === 0 ? { ...a, fresh: true } : a));
    expect(text(press(withCard({ ...d, attachments: fresh }), "enter"))).toContain("plan.md (new)");
    // a run that keeps none says nothing
    const { attachments: _none, ...without } = detail();
    const plainCard = text(press(withCard(without), "enter"));
    expect(plainCard).not.toContain("ATTACHMENTS");
    expect(plainCard).toContain("The Code tab opens each diff.");
  });

  test("t45_tui_code_lists_both_groups", () => {
    const d = detail();
    expect(itemCount(d, 1)).toBe(7);
    const list = text(press(withCard(), "enter", "right"));
    expect(list).toContain("5 files · 379 lines · Enter opens a file");
    expect(list).toContain("ATTACHMENTS · 2 kept with the run · Enter opens one");
    expect(list.indexOf("ATTACHMENTS")).toBeGreaterThan(list.indexOf("packages/cli/src/table.ts"));
    expect(list).toMatch(/plan\.md\s+text · 4 lines · 74 B · v2/);
    expect(list).toMatch(new RegExp(`status-table\\.png\\s+png · 47\\.1 KB · ${NOT_SCANNED}`));
    // one cursor walks both groups: from the last file to the first attachment and on
    const onLastFile = press(withCard(), ...toAttachment(-1));
    expect(text(onLastFile)).toMatch(/▸ packages\/cli\/src\/table\.ts/);
    const onPlan = press(onLastFile, "down");
    expect(text(onPlan)).toMatch(/▸ plan\.md/);
    const onImage = press(onPlan, "down", "down", "down");
    expect(text(onImage)).toMatch(/▸ status-table\.png/);
    expect(text(press(onImage, "up", "up"))).toMatch(/▸ packages\/cli\/src\/table\.ts/);
    // with no file changed the attachments are the list
    const alone = press(withCard({ ...d, changes: { kind: "none" } }), "enter", "right");
    expect(text(alone)).toContain("No files changed.");
    expect(text(alone)).toMatch(/▸ plan\.md/);
    expect(text(press(alone, "down"))).toMatch(/▸ status-table\.png/);
  });
});

describe("t45 an attachment opened", () => {
  test("t45_tui_steps_through_versions", () => {
    // opening asks for the diff of the latest version, once, under a key no file can have
    const asked = press(withCard(), ...toAttachment(0), "enter");
    expect(asked.effects).toEqual([
      { type: "load_diff", runId: gate().id, path: attachmentKey("plan.md", 2) },
    ]);
    expect(attachmentKey("plan.md", 2)).toBe("/attachment:plan.md@2");
    expect(text(asked)).toContain("Reading the version…");

    const m = planOpened();
    const latest = text(m);
    expect(latest).toContain("Code › attachment › plan.md");
    // the header names the writer of the version
    expect(latest).toContain("version 2 of 2 · written by plan #2 · [ ] other versions");
    expect(latest).toContain("text · 4 lines · 74 B · v2");
    expect(latest).toMatch(/- 1\. Read the status command\./);
    expect(latest).toMatch(/\+ 2\. Add the age column\./);
    expect(latest).toContain("[ ] version");
    // [ goes to the version before, ] comes back; they stop at the ends
    const first = press(m, "[");
    expect(first.version).toBe(1);
    expect(text(first)).toContain("version 1 of 2 · written by plan · [ ] other versions");
    expect(text(first)).toMatch(/\+ # Plan/);
    expect(press(first, "[").version).toBe(1);
    expect(press(first, "]").version).toBe(2);
    expect(press(first, "]", "]").version).toBe(2);
    // a version not read yet is asked for
    const fresh = takeEffects(press(withCard(), ...toAttachment(0), "enter"))[0];
    expect(press(fresh, "[").effects).toEqual([
      { type: "load_diff", runId: gate().id, path: attachmentKey("plan.md", 1) },
    ]);
    // another item starts at its latest version again
    const next = press(first, "n");
    expect(next.version).toBeUndefined();
    expect(text(next)).toContain("Code › attachment › status-table.png");
    expect(press(first, "escape", "enter").version).toBeUndefined();
  });

  test("t45_tui_shows_an_image_by_its_facts", () => {
    const m = press(withCard(), ...toAttachment(1), "enter");
    // an image has nothing to read: no diff is asked for
    expect(m.effects).toEqual([]);
    const out = text(m);
    expect(out).toContain("Code › attachment › status-table.png");
    expect(out).toContain("version 1 of 1 · written by impl");
    expect(out).toMatch(/type\s+png/);
    expect(out).toMatch(/size\s+47\.1 KB/);
    expect(out).toContain(NOT_SCANNED);
    expect(out).toMatch(/file\s+\/sample\/run\/attachments\/sample-status-table\.png/);
    // a stored file that was changed, or is gone, shows no path and nothing to open
    const damaged = (state: "changed" | "missing"): GateDetail => {
      const d = detail();
      const attachments = (d.attachments ?? []).map((a) =>
        a.name === "status-table.png"
          ? { ...a, versions: a.versions.map(({ path: _path, ...v }) => ({ ...v, state })) }
          : a,
      );
      return { ...d, attachments };
    };
    const changed = text(press(withCard(damaged("changed")), ...toAttachment(1), "enter"));
    expect(changed).toContain("was changed outside kodel");
    expect(changed).not.toContain("sample-status-table.png");
    expect(text(press(withCard(damaged("missing")), ...toAttachment(1), "enter"))).toContain(
      "The stored file of this version is missing",
    );
    // the path came from files an agent can write: it is drawn through `plain`
    const d = detail();
    const odd: AttachmentView[] = (d.attachments ?? []).map((a) =>
      a.name === "status-table.png"
        ? { ...a, versions: a.versions.map((v) => ({ ...v, path: "/runs/a\u0007b.png" })) }
        : a,
    );
    const drawn = text(press(withCard({ ...d, attachments: odd }), ...toAttachment(1), "enter"));
    expect(drawn).toContain("/runs/a b.png");
  });
});

describe("t45 comments on an attachment", () => {
  test("t45_comment_on_an_attachment_line", () => {
    const m = planOpened();
    // the cursor starts on the first line; c records the version and the line
    expect(press(m, "c").input?.place).toBe("attachment:plan.md@2:1");
    // a line the version removed is a line of the version before
    expect(press(m, "down", "down", "c").input?.place).toBe("attachment:plan.md@1:3");
    expect(press(m, "down", "down", "down", "c").input?.place).toBe("attachment:plan.md@2:3");
    // on the first version every line is its own
    expect(press(m, "[", "c").input?.place).toBe("attachment:plan.md@1:1");
    // a comment shows under its line, in the version it was made on
    const d = { ...detail(), comments: [comment("attachment:plan.md@2:4", "why the age?")] };
    const shown = text(planOpened(d));
    expect(shown).toContain("1 comment");
    const lines = shown.split("\n");
    const at = lines.findIndex((l) => l.includes("2. Add the age column."));
    expect(lines[at + 1]).toContain("✎ major");
    expect(lines[at + 1]).toContain("why the age?");
    // the list of the Code tab counts it for the attachment, not for a file
    expect(text(press(withCard(d), "enter", "right"))).toMatch(/plan\.md.*✎1/);
    expect(attachmentCommentCount(d, "plan.md")).toBe(1);
  });

  test("t45_comment_on_an_image", () => {
    const m = press(withCard(), ...toAttachment(1), "enter");
    // an image takes a comment without a line
    expect(press(m, "c").input?.place).toBe("attachment:status-table.png@1");
    const d = {
      ...detail(),
      comments: [comment("attachment:status-table.png@1", "the header is cut off")],
    };
    const out = text(press(withCard(d), ...toAttachment(1), "enter"));
    expect(out).toContain("1 comment");
    expect(out).toContain("the header is cut off");
    // from the list, a comment is about the latest version as a whole
    expect(press(withCard(), ...toAttachment(0), "c").input?.place).toBe("attachment:plan.md@2");
  });

  test("t45_comment_survives_versions_and_damage", () => {
    const d = { ...detail(), comments: [comment("attachment:plan.md@1:1", "read what?")] };
    // looking at the newer version the comment is not on its lines...
    const latest = text(planOpened(d));
    expect(latest).not.toContain("read what?");
    expect(latest).toContain("1 comment");
    // ...it is still under the line of the version it was made on
    const first = text(press(planOpened(d), "["));
    const lines = first.split("\n");
    const at = lines.findIndex((l) => l.includes("+ # Plan"));
    expect(lines[at + 1]).toContain("read what?");
    // when the name no longer verifies the comment is still listed, never lost
    const broken: GateDetail = {
      ...d,
      attachments: (d.attachments ?? []).map((a) =>
        a.name === "plan.md"
          ? { ...a, versions: a.versions.map((v) => ({ ...v, state: "changed" as const })) }
          : a,
      ),
    };
    const comments = text(press(withCard(broken), "enter", "right", "right", "right"));
    expect(comments).toContain("attachment:plan.md@1:1");
    expect(comments).toContain("read what?");
    expect(text(press(withCard(broken), ...toAttachment(0), "enter"))).toContain("1 comment");
    // and when the run holds no such name any more the location is plain text, still listed
    const { attachments: _gone, ...gone } = d;
    expect(text(press(withCard(gone), "enter", "right", "right", "right"))).toContain(
      "attachment:plan.md@1:1",
    );
  });

  test("t45_comment_locations_do_not_collide", () => {
    // project files whose names look like the attachments' keep their own comments
    const files: [string, number][] = [
      ["attachments/plan.md", 3],
      ["attachment:plan.md@2", 2],
      ["attachment", 1],
    ];
    const d: GateDetail = {
      ...detail(),
      changes: { kind: "files", files, totalFiles: 3, totalLines: 6 },
      comments: [
        comment("attachments/plan.md:1", "a file in a folder"),
        comment("./attachment:plan.md@2:1", "a file with a colon"),
        comment("attachment:7", "line 7 of the file named attachment"),
        comment("attachment:plan.md@2:1", "the first line of the plan"),
      ],
    };
    expect(fileCommentCount(d, "attachments/plan.md")).toBe(1);
    expect(fileCommentCount(d, "attachment:plan.md@2")).toBe(1);
    expect(fileCommentCount(d, "attachment")).toBe(1);
    expect(attachmentCommentCount(d, "plan.md")).toBe(1);
    expect(projectPlace("attachment:plan.md@2")).toBe("./attachment:plan.md@2");
    expect(projectPlace("attachments/plan.md")).toBe("attachments/plan.md");
    // a comment made on the project file is written so that it can never read as a version
    const onFile = press(withCard(d), "enter", "right", "down");
    expect(onFile.cursor).toBe(1);
    expect(press(onFile, "c").input?.place).toBe("./attachment:plan.md@2");
    const read = withDiff(press(onFile, "enter"), diffKey(gate().id, "attachment:plan.md@2"), {
      kind: "text",
      text: "@@ -1,1 +1,1 @@\n-a\n+b\n",
      truncated: false,
    });
    expect(press(read, "down", "c").input?.place).toBe("./attachment:plan.md@2:1");
    expect(text(read)).toContain("a file with a colon");
    expect(text(read)).not.toContain("the first line of the plan");
    // the diff of the file and the diff of the version are read under different keys
    expect(attachmentKey("plan.md", 2)).not.toBe("attachment:plan.md@2");
    expect(parseAttachmentKey("attachment:plan.md@2")).toBeUndefined();
    expect(parseAttachmentKey("/attachment:plan.md@2")).toEqual({ name: "plan.md", version: 2 });
    // a location is an attachment's only when the run has that name
    expect(attachmentOf(d, "attachment:plan.md@2:1")).toEqual({
      name: "plan.md",
      version: 2,
      line: 1,
    });
    expect(attachmentOf(d, "attachment:other.md@1:1")).toBeUndefined();
    expect(attachmentOf({}, "attachment:plan.md@2:1")).toBeUndefined();
  });

  test("t45_finding_may_point_at_an_attachment", () => {
    // a step's finding (a critique of the plan) names a line of the attachment the same way
    const d = detail();
    const visits = d.visits.map((v, i) =>
      i === 0
        ? {
            ...v,
            attempt: {
              ...v.attempt,
              review: {
                completeness: "complete",
                findings: [
                  {
                    severity: "minor",
                    location: "attachment:plan.md@2:3",
                    description: "which table?",
                  },
                  { severity: "minor", location: "packages/cli/src/cli.ts:3", description: "x" },
                ],
              },
            },
          }
        : v,
    );
    const out = text(planOpened({ ...d, visits }));
    const lines = out.split("\n");
    const at = lines.findIndex((l) => l.includes("1. Read the status command and its table."));
    expect(lines[at + 1]).toContain("✎ minor");
    expect(lines[at + 1]).toContain("which table?");
  });
});

describe("t45 the card reads the attachments from the run", () => {
  test("t45_tui_reads_attachments_and_their_diffs_from_the_run", async () => {
    const info = (name: string, version: number, type: string, state = "ok") => ({
      name,
      version,
      type,
      bytes: 10,
      ...(type === "text" ? { lines: 2 } : {}),
      sha256: "a".repeat(64),
      node: "plan",
      attempt: 1,
      at: NOW,
      seq: version,
      scanned: type === "text",
      state,
    });
    const asked: string[] = [];
    const run = {
      state: async () => ({ status: "running", startedAt: NOW, active: [], nodes: {} }),
      currentSpec: async () => ({ name: "p", nodes: [], edges: [], entry: "plan" }),
      inspect: async () => ({ running: { active: [], completed_in_run: 0, hint: "" } }),
      journal: async () => [],
      changesSinceStart: async () => ({ kind: "no_repo" as const }),
      changesSinceGate: async () => ({ kind: "no_repo" as const }),
      resultsOf: async () => undefined,
      diffOf: async (path: string) => {
        asked.push(`file ${path}`);
        return { text: "file diff", truncated: false };
      },
      gateAttachments: async () => ({
        list: [
          info("plan.md", 2, "text"),
          info("shot.png", 1, "png"),
          info("gone.png", 1, "png", "missing"),
        ],
        fingerprint: "x",
        newSince: ["shot.png"],
      }),
      listAttachments: async (input?: { name?: string }) =>
        input?.name === "plan.md"
          ? [info("plan.md", 1, "text"), info("plan.md", 2, "text")]
          : input?.name === "shot.png"
            ? [info("shot.png", 1, "png")]
            : [info("gone.png", 1, "png", "missing")],
      readAttachment: async (input: { name: string }) => ({
        attachment: info(input.name, 1, "png"),
        path: `/runs/attachments/${input.name}`,
      }),
      attachmentDiff: async (name: string, version?: number) => {
        asked.push(`attachment ${name}@${version}`);
        return { text: "version diff", truncated: false };
      },
    };
    const source = { open: async () => run as never };
    const d = await loadRunDetail(source, "r_1", NOW);
    expect(d?.attachments).toEqual([
      {
        name: "plan.md",
        versions: [
          expect.objectContaining({ version: 1, type: "text", lines: 2, state: "ok" }),
          expect.objectContaining({ version: 2, type: "text" }),
        ],
      },
      {
        name: "shot.png",
        fresh: true,
        versions: [expect.objectContaining({ type: "png", path: "/runs/attachments/shot.png" })],
      },
      // a stored file that does not verify has no path
      { name: "gone.png", versions: [expect.objectContaining({ state: "missing" })] },
    ]);
    expect(d?.attachments?.[0]?.versions[0]).not.toHaveProperty("path");
    expect(d?.attachments?.[2]?.versions[0]).not.toHaveProperty("path");
    // the key of a version reads the version; a project file of a like name reads the file
    expect(await loadDiff(source, "r_1", attachmentKey("plan.md", 2))).toMatchObject({
      text: "version diff",
    });
    expect(await loadDiff(source, "r_1", "attachment:plan.md@2")).toMatchObject({
      text: "file diff",
    });
    expect(await loadDiff(source, "r_1", "/attachment:../x@1")).toEqual({ kind: "missing" });
    expect(asked).toEqual(["attachment plan.md@2", "file attachment:plan.md@2"]);
    // the sample data answers the same keys
    expect(await demoDiff(attachmentKey("plan.md", 1))).toMatchObject({ kind: "text", text: V1 });
  });
});
