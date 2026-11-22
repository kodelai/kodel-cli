// The person's side of a THROWAWAY run, played by the spike through the calls `kodel gate` makes (as
// tests/agents/harness.ts `decideGate` does). It refuses any root that is not a spike project.
//   bun decide.ts <root> <state dir> <run id> <node> approved|rejected
import { basename, dirname, join } from "node:path";

const MAIN = process.env.EKAV_MAIN ?? "/Users/tyurin23/Code/KodelAI/etude";
const { LocalPipelineHost } = await import(join(MAIN, "packages/local/src/index.ts"));
const [root, state, runId, node, decision] = process.argv.slice(2);
if (!root || basename(root) !== "project" || !basename(dirname(root)).startsWith("ekav-")) {
  throw new Error("this decides only in a project the spike made (…/ekav-*/project)");
}
const run = await new LocalPipelineHost({ root, integrityDir: state, heartbeatMs: 0 }).open(runId);
if (run === undefined) throw new Error(`no run ${runId}`);
const result = await run.decideHuman(node, decision);
await run.waitForRest(60_000);
console.log(JSON.stringify({ ok: result.ok, status: (await run.state())?.status }));
