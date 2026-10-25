import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "check-artifact.mjs",
);

let tree: string;
beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), "kodel-artifact-check-"));
  mkdirSync(join(tree, "scripts"));
  cpSync(script, join(tree, "scripts", "check-artifact.mjs"));
  mkdirSync(join(tree, "packages", "cli", "dist"), { recursive: true });
});
afterEach(() => rmSync(tree, { recursive: true, force: true }));

const artifact = (version: string) => {
  writeFileSync(
    join(tree, "packages", "cli", "package.json"),
    JSON.stringify({ name: "kodel", version }),
  );
  writeFileSync(
    join(tree, "packages", "cli", "dist", "kodel.js"),
    `if (process.argv.includes("--version")) console.log(${JSON.stringify(version)});\n`,
  );
  return spawnSync(process.execPath, [join(tree, "scripts", "check-artifact.mjs")], {
    encoding: "utf8",
  });
};

describe("the artifact check", () => {
  test("t5btp_check_artifact_fails_on_version_0_0_0", () => {
    const result = artifact("0.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0.0.0");
  });

  test("t5btp_check_artifact_gets_past_the_version_with_a_real_one", () => {
    const result = artifact("0.1.0");
    // It stops later, at the commit the stub does not have; what matters is that the version passed.
    expect(result.stderr).not.toContain("reports version");
    expect(result.stderr).toContain("commit");
  });
});
