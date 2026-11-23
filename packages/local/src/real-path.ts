import { realpathSync } from "node:fs";

/**
 * The real path of `path`, as `realpath` of `node:fs/promises` gives it, made with the sync call: under Bun 1.3.5
 * the promise form is lost now and then (it never settles, once in some hundred thousand calls), and whatever
 * awaited it hung for good (TASK-7BH9). Being `async`, a throw is a rejection with the same `code`.
 */
export async function realPath(path: string): Promise<string> {
  return realpathSync.native(path);
}
