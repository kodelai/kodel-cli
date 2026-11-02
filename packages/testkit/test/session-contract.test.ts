import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipesSessionAdapter } from "@kodel-ai/local";
import {
  FakeSessionAdapter,
  RemoteStyleSessionAdapter,
  type SessionSubject,
  sessionContract,
} from "../src";

const entry = join(import.meta.dir, "../../local/src/session-holder-entry.ts");
const fakePrograms = {
  exit: (n: number) => ({ argv: ["fake", "exit", String(n)] }),
  echoExit: (t: string, n: number) => ({ argv: ["fake", "echo", t, String(n)] }),
  hang: () => ({ argv: ["fake", "hang"] }),
};
const shPrograms = {
  exit: (n: number) => ({ argv: ["sh", "-c", `exit ${n}`] }),
  echoExit: (t: string, n: number) => ({ argv: ["sh", "-c", `echo ${t}; exit ${n}`] }),
  hang: () => ({ argv: ["sh", "-c", "sleep 120"] }),
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const register = (label: string, make: () => SessionSubject, onlyPortable = false) => {
  describe(`session contract: ${label}`, () => {
    for (const c of sessionContract(make)) {
      if (onlyPortable && !c.portable) continue;
      test(`tA_contract_${c.name}`, c.run, 60_000);
    }
  });
};

register("fake", () => ({
  adapter: new FakeSessionAdapter(),
  programs: fakePrograms,
  cwd: "/work",
  unknownId: "a_000000000_0000",
}));
register(
  "remote-style (core methods only)",
  () => ({
    adapter: new RemoteStyleSessionAdapter(),
    programs: fakePrograms,
    cwd: "/work",
    unknownId: "srv-1",
  }),
  true,
);
register("local pipes (real processes)", () => {
  const base = mkdtempSync(join(tmpdir(), "kdjs-c-base-"));
  const root = mkdtempSync(join(tmpdir(), "kdjs-c-root-"));
  dirs.push(base, root);
  const adapter = new PipesSessionAdapter({
    base,
    root,
    holder: { exec: process.execPath, args: [entry, "holder"] },
    intermediate: { exec: process.execPath, args: [entry] },
    pollMs: 50,
  });
  return {
    adapter,
    programs: shPrograms,
    cwd: root,
    unknownId: "a_000000000_0000",
    dispose: async () => {
      if (!existsSync(adapter.place.dir)) return;
      for (const name of readdirSync(adapter.place.dir)) await adapter.stop(name).catch(() => {});
    },
  };
});

describe("session contract can fail", () => {
  test("tA_contract_catches_an_adapter_that_forgets_names", async () => {
    class Forgetful extends FakeSessionAdapter {
      override async remove(id: string): Promise<void> {
        await super.remove(id);
        (this as unknown as { usedNames: Set<string> }).usedNames.clear();
      }
    }
    const cases = sessionContract(() => ({
      adapter: new Forgetful(),
      programs: fakePrograms,
      cwd: "/work",
      unknownId: "a_000000000_0000",
    }));
    const target = cases.find((c) => c.name.startsWith("name_taken"));
    await expect(target?.run()).rejects.toThrow(/used/);
  });
});
