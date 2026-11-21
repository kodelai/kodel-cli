import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../src/cli";
import {
  loadPty,
  PTY_MODULE,
  type PtyHost,
  type PtyModule,
  type PtyProcess,
  probePty,
  ptyCheckMain,
  ptyHost,
  ptyUnsupported,
} from "../src/pty-loader";

// The placeholder id of decision D-A (TASK-HN8N, decision 5): renamed here, and in the session tests, before merge.
const ID = "tA_";

const dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "kodel-pty-loader-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fake {
  host: PtyHost;
  loads: string[];
  spawned: string[];
}

/** A machine where everything is in place; a test takes one thing away. */
function fake(over: Partial<PtyHost> = {}, files: Record<string, boolean> = {}): Fake {
  const loads: string[] = [];
  const spawned: string[] = [];
  const present: Record<string, boolean> = {
    [`${PTY_MODULE}/package.json`]: true,
    [`${PTY_MODULE}-darwin-arm64/pty.node`]: true,
    [`${PTY_MODULE}-darwin-arm64/spawn-helper`]: true,
    [`${PTY_MODULE}-linux-x64/pty.node`]: true,
    ...files,
  };
  const child: PtyProcess = {
    pid: 4242,
    onData: (listener) => listener("30 100\r\n"),
    onExit: (listener) => listener({ exitCode: 0, signal: 0 }),
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
  const pty: PtyModule = {
    spawn(file) {
      spawned.push(file);
      return child;
    },
  };
  const host: PtyHost = {
    platform: "darwin",
    arch: "arm64",
    bun: false,
    glibc: true,
    resolve: (specifier) => (present[specifier] ? `/modules/${specifier}` : undefined),
    executable: () => true,
    load: async (specifier) => {
      loads.push(specifier);
      return { default: pty };
    },
    ...over,
  };
  return { host, loads, spawned };
}

describe("the PTY loader", () => {
  test(`${ID}pty_loader_injected: the module is loaded only through the host, and only when asked`, async () => {
    const f = fake();
    expect(probePty(f.host)).toEqual({ ok: true });
    expect(f.loads).toEqual([]); // the starter's check loads nothing
    const loaded = await loadPty(f.host);
    expect(loaded.ok).toBe(true);
    expect(f.loads).toEqual([PTY_MODULE]);

    const lines: string[] = [];
    expect(await ptyCheckMain(["--spawn"], (t) => lines.push(t), f.host)).toBe(0);
    expect(JSON.parse(lines.join(""))).toEqual({ ok: true, output: "30 100" });
    expect(f.spawned).toEqual(["/bin/sh"]);
  });

  test(`${ID}pty_loader_injected: a module with named exports and no default is taken too`, async () => {
    const inner = fake();
    const pty = ((await inner.host.load(PTY_MODULE)) as { default: PtyModule }).default;
    const f = fake({ load: async () => ({ spawn: pty.spawn }) });
    expect((await loadPty(f.host)).ok).toBe(true);
  });

  test(`${ID}pty_absent_no_child: no package, no platform package, a load that throws, a module without spawn`, async () => {
    const cases: [string, Fake, RegExp][] = [
      ["absent", fake({}, { [`${PTY_MODULE}/package.json`]: false }), /is not installed/],
      [
        "no platform package",
        fake({}, { [`${PTY_MODULE}-darwin-arm64/pty.node`]: false }),
        /no binary package installed for this platform \(@lydell\/node-pty-darwin-arm64\)/,
      ],
      [
        "an unknown platform",
        fake({ platform: "freebsd", arch: "x64" }),
        /@lydell\/node-pty-freebsd-x64/,
      ],
      ["musl", fake({ platform: "linux", arch: "x64", glibc: false }), /Alpine, musl/],
      ["windows", fake({ platform: "win32", arch: "x64" }), /Windows/],
    ];
    for (const [name, f, reason] of cases) {
      const probe = probePty(f.host);
      expect(probe.ok, name).toBe(false);
      if (!probe.ok) expect(probe.reason, name).toMatch(reason);
      const lines: string[] = [];
      expect(await ptyCheckMain(["--spawn"], (t) => lines.push(t), f.host), name).toBe(1);
      expect(JSON.parse(lines.join("")), name).toMatchObject({ ok: false });
      expect(f.loads, `${name}: nothing is loaded after a refusal`).toEqual([]);
      expect(f.spawned, name).toEqual([]);
    }

    const broken: [string, PtyHost["load"], RegExp][] = [
      [
        "a load that throws",
        async () => {
          throw new Error("dlopen failed: wrong architecture\nat more lines");
        },
        /could not be loaded: dlopen failed: wrong architecture$/,
      ],
      ["a module without spawn", async () => ({ default: {} }), /has no spawn function/],
      ["nothing", async () => null, /has no spawn function/],
    ];
    for (const [name, load, reason] of broken) {
      const f = fake({ load });
      expect(probePty(f.host), `${name}: the probe cannot see it`).toEqual({ ok: true });
      const loaded = await loadPty(f.host);
      expect(loaded.ok, name).toBe(false);
      if (!loaded.ok) {
        expect(loaded.reason, name).toMatch(reason);
        expect(ptyUnsupported(loaded.reason)).toStartWith("UNSUPPORTED: ");
      }
      expect(await ptyCheckMain(["--spawn"], () => {}, f.host), name).toBe(1);
      expect(f.spawned, name).toEqual([]);
    }
  });

  test(`${ID}pty_loader_refuses_under_bun: also when the module is there and would load`, async () => {
    const f = fake({ bun: true });
    const probe = probePty(f.host);
    expect(probe).toMatchObject({ ok: false });
    if (!probe.ok) expect(probe.reason).toContain("cannot run under Bun");
    expect<unknown>(await loadPty(f.host)).toEqual(probe);
    expect(f.loads).toEqual([]);

    // The tests themselves run under Bun: the real host says so, whatever is installed.
    expect(ptyHost().bun).toBe(true);
    const real = await loadPty();
    expect(real.ok).toBe(false);
    if (!real.ok && process.platform !== "win32") expect(real.reason).toContain("under Bun");
  });

  test(`${ID}pty_spawn_helper_not_executable: refused with the path to fix; linux has no helper to check`, async () => {
    const notExecutable = fake({ executable: () => false });
    const probe = probePty(notExecutable.host);
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.reason).toContain("not executable");
      expect(probe.reason).toContain(`/modules/${PTY_MODULE}-darwin-arm64/spawn-helper`);
    }
    expect((await loadPty(notExecutable.host)).ok).toBe(false);
    expect(notExecutable.loads).toEqual([]);

    const missing = fake({}, { [`${PTY_MODULE}-darwin-arm64/spawn-helper`]: false });
    expect(probePty(missing.host)).toMatchObject({ ok: false });

    const linux = fake({ platform: "linux", arch: "x64", executable: () => false });
    expect(probePty(linux.host)).toEqual({ ok: true });
  });

  test.skipIf(process.platform === "win32")(
    `${ID}pty_spawn_helper_not_executable: the real host reads the mode of the file`,
    () => {
      const dir = tmp();
      const helper = join(dir, "spawn-helper");
      writeFileSync(helper, "");
      chmodSync(helper, 0o644);
      expect(ptyHost().executable(helper)).toBe(false);
      chmodSync(helper, 0o755);
      expect(ptyHost().executable(helper)).toBe(true);
      expect(ptyHost().executable(join(dir, "none"))).toBe(false);
      expect(ptyHost().resolve("@kodel-ai/no-such-package/package.json")).toBeUndefined();
    },
  );

  // The loader refuses Windows, and the NODE_PATH lookup it asks about is a POSIX one.
  test.skipIf(process.platform === "win32")(
    `${ID}pty_loader_loads_what_the_probe_found: a module that only NODE_PATH leads to is found and loaded alike`,
    () => {
      // On Node, where the holder runs: the lookup of Bun is another one.
      const dir = tmp();
      const pack = join(dir, "lookup", "kd-fake-pty");
      mkdirSync(pack, { recursive: true });
      writeFileSync(
        join(pack, "package.json"),
        JSON.stringify({ name: "kd-fake-pty", main: "main.js" }),
      );
      writeFileSync(join(pack, "main.js"), "exports.spawn = () => 'spawned';\n");
      const script = join(dir, "ask.mjs");
      writeFileSync(
        script,
        [
          `import { ptyHost } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/pty-loader.ts")).href)};`,
          "const host = ptyHost();",
          "const found = host.resolve('kd-fake-pty/package.json') !== undefined;",
          "let loaded;",
          "try {",
          "  const module = await host.load('kd-fake-pty');",
          "  loaded = (module.default ?? module).spawn();",
          "} catch (error) {",
          "  loaded = 'failed: ' + error.code;",
          "}",
          "console.log(JSON.stringify({ found, loaded }));",
        ].join("\n"),
      );
      const ask = (env: Record<string, string>) => {
        const run = spawnSync("node", ["--experimental-strip-types", script], {
          cwd: dir,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
        });
        expect(run.status, run.stderr).toBe(0);
        return JSON.parse(run.stdout) as { found: boolean; loaded: string };
      };
      expect(ask({ NODE_PATH: join(dir, "lookup") })).toEqual({ found: true, loaded: "spawned" });
      // and where the probe does not find it, the load does not either
      expect(ask({})).toEqual({ found: false, loaded: "failed: MODULE_NOT_FOUND" });
    },
  );

  test.skipIf(process.platform === "win32")(
    `${ID}pipes_work_without_pty: a session in pipes mode starts where the PTY module is absent`,
    async () => {
      const absent = fake({}, { [`${PTY_MODULE}/package.json`]: false });
      expect(probePty(absent.host).ok).toBe(false);
      expect(probePty().ok).toBe(false); // and here, under Bun

      const dir = tmp();
      const state = tmp();
      mkdirSync(join(dir, ".kodel"));
      writeFileSync(join(dir, ".kodel", "config.yaml"), "");
      let out = "";
      let err = "";
      const code = await runCli(["agent", "exec", "--", "true"], {
        cwd: dir,
        out: (t) => {
          out += t;
        },
        err: (t) => {
          err += t;
        },
        interactive: true,
        environment: { KODEL_STATE_DIR: state },
        confirm: async () => true,
        select: async () => [],
        sessionLauncher: {
          exec: process.execPath,
          args: [join(import.meta.dir, "../src/main.ts")],
        },
      });
      expect(code, err).toBe(0);
      expect(out).toMatch(/started a_\S+/);
    },
    30_000,
  );
});
