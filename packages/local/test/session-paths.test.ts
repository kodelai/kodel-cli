import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalSessionId, SessionError } from "@kodel-ai/pipeline-core";
import {
  ensurePrivateDir,
  newSessionId,
  sessionCheckoutKey,
  sessionDirOf,
  sessionPlace,
} from "../src/session-paths";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "kdjs-paths-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("session paths", () => {
  test("tA_new_session_ids_match_the_local_shape", () => {
    for (const now of [0, 1_000, Date.now()])
      expect(isLocalSessionId(newSessionId(now))).toBe(true);
    expect(newSessionId(0, () => 0)).toBe("a_000000000_0000");
  });

  test("tA_rm_dotdot_deletes_nothing: a bad id never becomes a path", () => {
    const place = sessionPlace({ base: tmp(), root: tmp() });
    for (const bad of ["..", ".", "names", "x.names", "../x", "a_1_2"]) {
      expect(() => sessionDirOf(place, bad)).toThrow(SessionError);
    }
    expect(sessionDirOf(place, "a_000000000_0000").startsWith(place.dir)).toBe(true);
  });

  test("tA_used_marker_outside_session_dir: names folder is a sibling", () => {
    const place = sessionPlace({ base: tmp(), root: tmp(), uid: 7 });
    expect(place.namesDir).toBe(`${place.dir}.names`);
    expect(place.dir.includes(join("run", "7"))).toBe(true);
  });

  test("tA_checkout_key_symlinked_root_same_folder", () => {
    const real = tmp();
    const holder = tmp();
    const link = join(holder, "link");
    symlinkSync(real, link);
    expect(sessionCheckoutKey(link)).toBe(sessionCheckoutKey(real));
  });

  test("tA_private_dir_refuses_a_symlink_and_a_shared_mode", () => {
    const root = tmp();
    const ok = join(root, "ok");
    ensurePrivateDir(ok);
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(() => ensurePrivateDir(link)).toThrow(SessionError);
  });
});
