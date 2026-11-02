// WKJ4-shaped engine step: deterministic name, start-or-join, wait, result. No pipeline imports.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const [run, node, attempt, ...argv] = process.argv.slice(2);
const name = `n${createHash("sha256").update(`${run}\0${node}\0${attempt}`).digest("hex").slice(0, 10)}`;
const spike = new URL("./spike.mjs", import.meta.url).pathname;
const sp = (...a) => execFileSync(process.execPath, [spike, ...a], { encoding: "utf8" });
const st = JSON.parse(sp("status", name));
if (st.state === "unknown") {
  const r = JSON.parse(sp("start", name, "pipes", "--", ...argv));
  if (r.error) throw new Error(r.error);
  if (process.env.SPIKE_DIE_AFTER_START) process.kill(process.pid, "SIGKILL");
} else if (st.state === "lost") {
  console.log(JSON.stringify({ result: "unknown, a person decides", state: st.state }));
  process.exit(3);
}
const done = JSON.parse(sp("wait", name));
console.log(JSON.stringify({ result: done.state, exitCode: done.exitCode, name }));
