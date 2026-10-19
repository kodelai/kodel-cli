// Runs before every test file. Trusted state hashes go to a throwaway directory, so running the
// tests never writes into the real ~/.local/state.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODEL_STATE_DIR ??= mkdtempSync(join(tmpdir(), "kodel-test-state-"));
