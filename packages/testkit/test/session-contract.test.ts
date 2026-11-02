import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipesSessionAdapter, processIdentity } from "@kodel-ai/local";
import {
  FakeSessionAdapter,
  RemoteStyleSessionAdapter,
  runStepAsSession,
  type SessionSubject,
  sessionContract,
  stepSessionName,
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
  hang: () => ({ argv: ["sh", "-c", "sleep 120"], timeoutMs: 120_000 }),
};

// stop signals only a process whose identity it can check; without the process table (a sandbox) the pipes
// suites are skipped, visibly, unless the job requires the table.
const tableAvailable = processIdentity(process.pid) !== undefined;
const skipPipes = !tableAvailable && process.env.KODEL_REQUIRE_PROCTABLE !== "1";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const register = (
  label: string,
  make: () => SessionSubject,
  onlyPortable = false,
  skip = false,
) => {
  describe(`session contract: ${label}`, () => {
    for (const c of sessionContract(make)) {
      if (onlyPortable && !c.portable) continue;
      test.skipIf(skip)(`tA_contract_${c.name}`, c.run, 60_000);
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
register(
  "local pipes (real processes)",
  () => {
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
  },
  false,
  skipPipes,
);

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
    const target = cases.find((c) => c.name.startsWith("host_name_taken"));
    await expect(target?.run()).rejects.toThrow(/used/);
  });
});

describe("consumer-shaped engine step on the public interface", () => {
  const step = { run: "r_0mvy8fm6k_de55", node: "impl", attempt: 1 };

  const onAdapter = (label: string, make: () => SessionSubject, skip = false) => {
    test.skipIf(skip)(
      `tA_engine_step_consumer_${label}: one result, a retry joins, a gone session is unknown`,
      async () => {
        const s = make();
        try {
          const program = { ...s.programs.echoExit("done", 0), cwd: s.cwd } as {
            argv: string[];
            cwd: string;
          };
          const first = await runStepAsSession(s.adapter, step, program);
          expect(first).toMatchObject({ kind: "result", exitCode: 0 });
          // a retry with the same (run, node, attempt) must not run the command again
          const again = await runStepAsSession(s.adapter, step, program);
          expect(again).toMatchObject({ kind: "result", exitCode: 0 });
          expect((await s.adapter.list()).length).toBe(1);
          // after the session is removed the name is used: the step is unknown, never a second run
          const [only] = await s.adapter.list();
          if (only) await s.adapter.remove(only.id);
          const third = await runStepAsSession(s.adapter, step, program);
          expect(third.kind).toBe("unknown");
          expect((await s.adapter.list()).length).toBe(0);
        } finally {
          await s.dispose?.();
        }
      },
      60_000,
    );
  };

  onAdapter("fake", () => ({
    adapter: new FakeSessionAdapter(),
    programs: fakePrograms,
    cwd: "/work",
    unknownId: "a_000000000_0000",
  }));
  onAdapter("remote_style", () => ({
    adapter: new RemoteStyleSessionAdapter(),
    programs: fakePrograms,
    cwd: "/work",
    unknownId: "srv-1",
  }));
  onAdapter(
    "pipes",
    () => {
      const base = mkdtempSync(join(tmpdir(), "kdjs-e-base-"));
      const root = mkdtempSync(join(tmpdir(), "kdjs-e-root-"));
      dirs.push(base, root);
      const adapter = new PipesSessionAdapter({
        base,
        root,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
        pollMs: 50,
      });
      return { adapter, programs: shPrograms, cwd: root, unknownId: "a_000000000_0000" };
    },
    skipPipes,
  );

  test("tA_engine_step_name_is_deterministic_and_distinct", () => {
    expect(stepSessionName("r1", "impl", 1)).toBe(stepSessionName("r1", "impl", 1));
    expect(stepSessionName("r1", "impl", 1)).not.toBe(stepSessionName("r1", "impl", 2));
    expect(stepSessionName("r1", "impl", 1)).not.toBe(stepSessionName("r2", "impl", 1));
  });

  test("tA_engine_step_lost_session_is_unknown_not_a_rerun", async () => {
    class LostOnWait extends FakeSessionAdapter {
      override async wait(id: string) {
        return {
          ...(await this.status(id)),
          state: "lost" as const,
          reason: "holder_gone" as const,
        };
      }
    }
    const out = await runStepAsSession(new LostOnWait(), step, {
      ...fakePrograms.hang(),
      cwd: "/work",
    } as { argv: string[]; cwd: string });
    expect(out.kind).toBe("unknown");
  });
});
