/** Entry of the holder processes: `intermediate <json launch>` or `holder`. The CLI's hidden command calls the same functions. */
import { holderMain, intermediateMain } from "./session-holder";

const [, , role, arg] = process.argv;
if (role === "intermediate") {
  intermediateMain(JSON.parse(arg ?? "{}") as { exec: string; args: string[] });
  process.exit(0);
} else if (role === "holder") {
  process.exit(await holderMain());
}
