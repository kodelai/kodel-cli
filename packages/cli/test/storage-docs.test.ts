import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFile(join(root, path), "utf8");

/**
 * The documents say where the history is kept. These are the statements that were true before
 * `storage: home` and would be false (or incomplete) now, and the lines a person needs.
 */
describe("the documents about where the history is kept", () => {
  test("storage_docs_consistency: the stale statements are gone", async () => {
    const forbidden: [file: string, text: string][] = [
      ["README.md", "Run history stays in git and is analyzed"],
      ["AGENTS.md", "The proposal waits in `.kodel/proposals/` (do not edit it) until"],
      [
        "docs/project-root.md",
        "Its runs,\ntasks, pipelines and config live in the `.kodel` folder there. One",
      ],
      [
        "docs/history.md",
        "The run folder is committed when the project tracks `.kodel/runs` (this\nrepository ignores it, and `kodel init` does not write `.gitignore`). **Projects",
      ],
    ];
    for (const [file, text] of forbidden) {
      expect(await read(file), `${file} still says: ${text}`).not.toContain(text);
    }
  });

  test("storage_docs_consistency: the lines a person needs are there", async () => {
    const history = await read("docs/history.md");
    for (const line of [
      "## Where the history is kept",
      "storage: home",
      "project_id",
      "KODEL_STATE_DIR",
      "restart the MCP server",
      "upgrade everybody's kodel before committing",
      "kodel init --storage home",
      "deny rules",
      // The path forms of the deny rule: the one that matches (`~/`, `//`) and a warning about the one that does not.
      "Edit(~/.kodel/projects/<project_id>/**)",
      "`//` starts a path from the root of the file system",
      "Edit(.kodel/config.yaml)",
      "**Before** you switch",
      "foreign",
    ]) {
      expect(history, line).toContain(line);
    }
    expect(await read("AGENTS.md")).toContain("`storage`");
    expect(await read("AGENTS.md")).toContain("`project_id`");
    expect(await read("README.md")).toContain("storage: home");
    expect(await read("docs/project-root.md")).toContain("storage: home");
  });
});
