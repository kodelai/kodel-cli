// Runs before every test file. Trusted state hashes go to a throwaway directory, so running the
// tests never writes into the real ~/.local/state.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODEL_STATE_DIR ??= mkdtempSync(join(tmpdir(), "kodel-test-state-"));

// Inside Claude Code the shell has the id of the developer's own session. A host built without an environment of its
// own reads this process's, and would go looking for that session's log: tests never see it.
delete process.env.CLAUDE_CODE_SESSION_ID;
