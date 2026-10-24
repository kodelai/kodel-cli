/** The small bundle of `kodel hook`: `node kodel-hook.js <agent>`. See `hook-main.ts`. */
import { runHookEntry } from "./hook-main";

await runHookEntry(process.argv.slice(2));
