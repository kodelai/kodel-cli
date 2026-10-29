import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalPipelineHost,
  loadConfig,
  readStorageSettings,
  resolveStoragePlace,
  type StorageSettings,
} from "../src";

let dir: string;
let base: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-storage-config-"));
  base = await mkdtemp(join(tmpdir(), "kodel-storage-config-base-"));
  await mkdir(join(dir, ".kodel"), { recursive: true });
});
afterEach(async () => {
  for (const path of [dir, base]) await rm(path, { recursive: true, force: true });
});

const kodel = () => join(dir, ".kodel");
const write = (text: string) => writeFile(join(kodel(), "config.yaml"), text);

type Outcome = { ok: true; storage: string; project_id?: string } | { ok: false; code?: string };

async function loaded(text: string): Promise<Outcome> {
  await write(text);
  try {
    const config = await loadConfig(kodel());
    return {
      ok: true,
      storage: config.storage,
      ...(config.project_id === undefined ? {} : { project_id: config.project_id }),
    };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code };
  }
}

function matched(text: string): StorageSettings | "refused" {
  try {
    return readStorageSettings(text);
  } catch {
    return "refused";
  }
}

const ID = "demo-aaaa1111";

describe("storage settings in the config", () => {
  test("storage_invalid_value_is_refused", async () => {
    const bad = [
      "storage: cloud\n",
      "storage: homes\n",
      "storage: 5\n",
      "storage: true\n",
      "storage: [home]\n",
      "storage:\n  mode: home\n",
      "storage:\n  home: 1\n",
    ];
    for (const text of bad) {
      expect(await loaded(text), text).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
      await expect(loadConfig(kodel()), text).rejects.toThrow(/storage/);
    }
  });

  test("storage_matcher_agrees_with_loader", async () => {
    const table: { name: string; text: string; expect?: "ok" | "refused" }[] = [
      { name: "plain", text: `storage: home\nproject_id: ${ID}\n`, expect: "ok" },
      { name: "comment", text: `storage: home # c\nproject_id: ${ID} # d\n`, expect: "ok" },
      { name: "quoted", text: `storage: "home"  # c\nproject_id: '${ID}'\n`, expect: "ok" },
      { name: "crlf", text: `storage: home\r\nproject_id: ${ID}\r\n`, expect: "ok" },
      { name: "bom", text: `﻿storage: home\nproject_id: ${ID}\n` },
      { name: "tab after colon", text: `storage:\thome\nproject_id: ${ID}\n` },
      { name: "indented whole doc", text: `  storage: home\n  project_id: ${ID}\n` },
      { name: "indented key", text: "version: 1\n  storage: home\n", expect: "refused" },
      { name: "duplicate", text: "storage: home\nstorage: project\n", expect: "refused" },
      { name: "duplicate id", text: `project_id: ${ID}\nproject_id: ${ID}\n`, expect: "refused" },
      { name: "anchor", text: `storage: &a home\nproject_id: ${ID}\n`, expect: "refused" },
      { name: "anchor id", text: `storage: home\nproject_id: &a ${ID}\n`, expect: "refused" },
      { name: "block scalar", text: `storage: |\n  home\nproject_id: ${ID}\n`, expect: "refused" },
      { name: "folded", text: `storage: >-\n  home\nproject_id: ${ID}\n`, expect: "refused" },
      {
        name: "multi-line plain",
        text: `storage: ho\n  me\nproject_id: ${ID}\n`,
        expect: "refused",
      },
      { name: "flow doc", text: "{storage: home}\n", expect: "refused" },
      { name: "flow doc with id", text: `{storage: home, project_id: ${ID}}\n`, expect: "refused" },
      { name: "flow value", text: "storage: {a: home}\n", expect: "refused" },
      { name: "quoted key", text: `"storage": home\nproject_id: ${ID}\n`, expect: "refused" },
      { name: "homes", text: `storage: homes\nproject_id: ${ID}\n`, expect: "refused" },
      { name: "cloud", text: "storage: cloud\n", expect: "refused" },
      { name: "empty value", text: "storage:\nproject_id: x\n", expect: "refused" },
      { name: "nested", text: "tasks:\n  storage: home\n", expect: "refused" },
      { name: "project", text: "storage: project\n", expect: "ok" },
      { name: "nothing", text: "version: 1\n", expect: "ok" },
      { name: "home without id", text: "storage: home\n" },
      { name: "uppercase id", text: "storage: home\nproject_id: Demo-1234\n", expect: "refused" },
    ];
    for (const row of table) {
      const loader = await loaded(row.text);
      const matcher = matched(row.text);
      if (loader.ok) {
        // What the loader read, the matcher must have read the same way.
        expect(matcher, row.name).not.toBe("refused");
        if (matcher !== "refused") {
          expect(String(matcher.storage), row.name).toBe(loader.storage);
          expect(matcher.projectId, row.name).toBe(loader.project_id);
        }
      } else {
        expect(loader.code, row.name).toBe("CONFIG_INVALID");
      }
      if (row.expect === "ok") expect(loader.ok, row.name).toBe(true);
      if (row.expect === "refused") expect(loader.ok, row.name).toBe(false);
    }
  });

  test("storage_matcher_agrees_with_loader: a matcher answer the loader refuses is refused by the fallback", async () => {
    const env = { KODEL_STATE_DIR: base };
    const place = (text: string) =>
      write(text).then(() => resolveStoragePlace({ root: dir, dataDir: kodel(), env }));
    // The matcher refuses these as well, so the fallback does not hide the loader's error.
    for (const text of [
      "storage: homes\nnot_a_key: 1\n",
      "storage: cloud\nnot_a_key: 1\n",
      "storage: home\nproject_id: CON\nnot_a_key: 1\n",
      "storage: home\nproject_id: a..bcd\nnot_a_key: 1\n",
      "storage: home\nstorage: home\nnot_a_key: 1\n",
    ]) {
      await expect(place(text), text).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    // The matcher accepts it (the unknown key is not its business): the place is found for the
    // commands that only read.
    expect(await place(`storage: home\nproject_id: ${ID}\nnot_a_key: 1\n`)).toMatchObject({
      mode: "home",
      projectId: ID,
    });
  });

  test("storage_matcher_agrees_with_loader: a loader failure with the matcher saying project never starts a run", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("commit", "-q", "--allow-empty", "-m", "initial");
    await mkdir(join(kodel(), "pipelines"), { recursive: true });
    await writeFile(
      join(kodel(), "pipelines", "demo.yaml"),
      "name: demo\nnodes:\n  - slug: write\n    kind: agent\n    prompt: write\nedges: []\n",
    );
    // The nested `storage` is no top-level line, so the matcher says `project`; the loader refuses.
    await write('worktree:\n  mode: "off"\ntasks:\n  storage: home\n');
    const place = await resolveStoragePlace({
      root: dir,
      dataDir: kodel(),
      env: { KODEL_STATE_DIR: base },
    });
    expect(place.mode).toBe("project");
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: base,
      storage: place,
    });
    await expect(host.start({ pipeline: "demo", task: "t", restart: false })).rejects.toMatchObject(
      { code: "CONFIG_INVALID" },
    );
    expect(await host.runSummaries()).toEqual([]);
  });

  test("storage_project_id_in_config", async () => {
    expect(await loaded("storage: home\nproject_id: my-app-k3f9a2x1\n")).toEqual({
      ok: true,
      storage: "home",
      project_id: "my-app-k3f9a2x1",
    });
    for (const id of ["Demo-1234", "a..bcd", "con", "con.txt", "ab", "-abc", "abc.", "a b c"]) {
      expect(await loaded(`storage: home\nproject_id: "${id}"\n`), id).toMatchObject({
        ok: false,
        code: "CONFIG_INVALID",
      });
    }
    // Flow style, a number and a block are not lines the hook can read.
    for (const text of [
      `{project_id: ${ID}}\n`,
      "project_id: 12345\n",
      `project_id: |\n  ${ID}\n`,
      `project_id: [${ID}]\n`,
    ]) {
      expect(await loaded(text), text).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    }
  });

  test("storage_default_config_has_no_keys", async () => {
    // No file.
    let config = await loadConfig(kodel());
    expect(config.storage).toBe("project");
    expect("project_id" in config).toBe(false);
    // An empty file, and files with other keys only.
    for (const text of ["", "# nothing\n", "version: 1\n"]) {
      await write(text);
      config = await loadConfig(kodel());
      expect(config.storage, text).toBe("project");
      expect("project_id" in config, text).toBe(false);
    }
  });
});
