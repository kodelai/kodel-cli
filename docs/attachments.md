# Attachments: files a run keeps besides the project's (T-45)

A step can keep a file with the run instead of in the project: a plan, notes, a screenshot. The file
lives in the run's own folder (`<runs>/<run id>/attachments/`), so nothing appears in the working tree,
and it is shown to the person at a gate as a group of its own beside the changed files. Every write is
a new version; the history of a name can be listed, read and stepped through.

The local host keeps attachments. A host that keeps none offers neither the tools nor the check kind.

## The tools

| tool | does |
| --- | --- |
| `pipeline_attachment_write` | keeps a version: text given in `content`, or a file the engine reads from the run's working directory (`path`); only for an open agent step, with its `node_slug` and `attempt` |
| `pipeline_attachment_read` | one version (the latest, or `version`): a text in `content`, marked as data an agent wrote; for an image the facts only, never its bytes |
| `pipeline_attachment_list` | the latest version of each name; with `name`, every version of it (number, step, attempt, time, bytes, lines, hash) |

`path` is the only way for an image: the bytes of a screenshot sent through the model as text would cost
tens of thousands of tokens and invite corrupted bytes.

The same in a terminal, read-only: `kodel attachment ls <run> [name]` and
`kodel attachment show <run> <name> [--version n]` (also `kodel attachments ...`). For an image a person at
a terminal is told the path of the stored file; a command the engine or an agent runs (`KODEL_ENGINE`) gets
the facts only, since the path is a run file.

## Names, types and limits

A name is 1 to 64 characters of `a-z`, `0-9`, `.`, `_` and `-`, starting with a letter or a digit, with one
of the extensions below and not a name Windows keeps for a device (`con.md`, `nul.txt`). A name that a
redaction rule of the project matches is refused: it goes into the journal and into a file name.

The type is the host's finding, never the agent's word: the extension says what the name is stored as, and
the bytes must agree.

| type | extensions | must be |
| --- | --- | --- |
| text | `.md` `.txt` `.json` `.yaml` `.yml` `.csv` `.log` | valid UTF-8 without a NUL byte |
| image | `.png` `.jpg` `.jpeg` `.gif` `.webp` | bytes that begin as that image type does |

PDF and every other type are refused.

| limit | value |
| --- | --- |
| one text version, as stored | 256 KB |
| one image | 2 MB |
| names in a run | 20 |
| versions in a run, over all names | 200 |
| bytes stored in a run | 16 MB |

The limits are never reset, and a refused write spends none of them. A project that tracks `.kodel/runs`
in git commits these files with the rest of the run.

## Versions

Each accepted write is the next version of its name, with one journal record
(`attachment_written`: `node`, `attempt`, `name`, `version`, `ref`, `type`, `bytes`, `lines`, `sha256`,
`scanned`, `claim`) and no content in it. The stored file is named by the sha256 of its bytes.

Writing the bytes of the latest version again is a no-op only when that version verifies, was written
by the same step in the same visit, and stands to the step's claim as this write does (a version written
without the token of the worker that holds the step does not count for the check, so the holder's write
of the same bytes with its token is a new version). Otherwise it is a new version that points to the same stored file: a
step entered again, another step, and a rewrite after the file was changed outside kodel each get their
own record. A record's file is never replaced.

## What is trusted

- **Agent input is untrusted.** The file an agent names by `path` is opened once and judged on that
  handle: it must be a regular file with one link, inside the run's working directory, not under `.git/` or
  `.kodel/` (compared by the identity of the folders, so the case of the letters does not matter), within
  the size cap, and the path must still name the file that was opened. A link, a hard link, a FIFO and a file
  swapped between the open and the check are refused. Windows has no `O_NOFOLLOW`; there the comparison of
  identities alone guards. Two limits of this check:
  - The path is opened before it is known to be inside the working directory (the check is made on the
    handle), so the wording of a refusal can tell an agent whether a path outside exists and what kind of
    file it is ("there is no such file", "not a regular file", "not a file inside the run's working
    directory"). Nothing of such a file is read or stored.
  - Only `.git` and `.kodel` directly under the run's working directory are closed. A `.git` or `.kodel`
    folder deeper in the tree (a nested repository, a vendored project) is an ordinary folder here.
- **A read trusts the journal, not the folder.** A version is a record whose stored file hashes to the
  recorded `sha256`. A file with no record is not an attachment; a missing or changed file is said to be
  so and has no content and no path. What a crash or a refused write left is removed at the next write:
  a temporary file, and a stored file whose hash no line of the journal names. The journal is looked at
  as text for this, so the file of a record this kodel does not read (a newer build's) is never taken
  away, and a file that is not of the store's making is left alone.
- **Redaction.** Text is redacted before it is hashed and stored, like everything else that reaches the
  history. The agent's own log and the tool-call previews also hold the first 500 redacted characters of a
  written text, outside the 16 MB bound.

### The exception to "redact at every write path": images

An image cannot be redacted. A scan of its bytes would find nothing in compressed pixels and would only
look like protection, so PNG, JPEG, GIF and WebP are stored byte for byte and every one is marked
`not scanned for secrets`: in its record (`scanned: false`), in every list, at the gate and in the TUI.
Never put a secret in a screenshot. This is the one exception to principle 3 of `AGENTS.md`.

### A limit: the journal of an open run can be forged

While a run is open only `state.json` has a trusted hash; the journal is at the agent's trust level, as the
patches are (`docs/changes.md`). An agent that writes run files against the rules can append an
`attachment_written` line and put its file in place, around the redaction, the type check and the limits,
and so pass the check below. What such a line cannot do is point out of `attachments/` or pass for
another type. The limit is pinned by `t45_limit_a_forged_journal_line_is_an_attachment`; lifting it
needs the latest hash of each name in the state, which is a new run format.

## At a gate

Every place that asks a person to decide lists the attachments of the run apart from the project files:

- the gate answer to the agent (`waiting.attachments`, `attachments_omitted` past 20, and
  `attachments_fingerprint`), also when the changed files could not be told;
- `kodel gate` and the dialog, with name, type, size, the unscanned mark, and which were written since the
  run stopped there;
- the TUI: one line in the Report, and a second group under Code. A text opens as the diff from its version
  before, `[` and `]` step through the versions, and the header names the step that wrote each. An image
  shows type, size, the mark and the path of the stored file.

The diff of two versions is made by git in a folder of its own, with no external diff, no text
conversion, no hooks and no configuration but git's defaults (`t45_version_diff_is_hardened`); without
git the whole text is shown.

**A version written after the look refuses the approval.** A sibling branch of a fork can go on writing
while a gate waits. `kodel gate`, the dialog and the TUI compare the attachments with what they showed and
ask the person to look again; `pipeline_decide_gate` must send back the `attachments_fingerprint` of the
answer the person decided on, and a missing or stale one is refused with the attachments as they are now.
A write that was a no-op changes nothing, and the 200 versions end the loop. A rejection is never held
back. This is not relaxed for a shared tree: an attachment has a writer and a number. The comparison is
made twice: when the person answers, for a refusal in plain words, and again under the run's lock with the
write of the decision, so a version that lands in between is refused and never approved unseen
(`t45_decision_is_held_against_the_attachments_under_the_lock`).

## Comments

A comment at a gate can point at an attachment: `attachment:<name>@<version>:<line>` for a line of a text
(a line the version removed is recorded as that line of the version before), and
`attachment:<name>@<version>` for a version as a whole, which is the only form for an image. The comment
key of the TUI records them, they go back with a rejection like any comment, and a step's finding may use
the same form (a critique of a plan names its lines this way).

A location is an attachment's only if it has this form **and** the run has that name; anything else is a
project path. The TUI writes a project path that starts with `attachment:` as `./attachment:...`.

## The `attachment` check

```yaml
checks:
  - { kind: attachment, name: plan.md, min_lines: 10 }
```

The check passes only when the step itself kept a version of the name in its current visit, and the stored
file still verifies. `min_lines` is for a text and counts the stored (redacted) lines.

- A version written by another step, or in an earlier visit of this one, does not count. A retry inside the
  visit keeps the version written before it.
- When the step was held by a worker's claim at the write, the version counts only if the write carried the
  claim's token: a worker cannot write as another worker's step.
- Two branches of a fork that write the same name do not fail each other: each check judges the version its
  own node wrote.
- Only an agent that works the step through the tools can feed it: the parser refuses the check on a
  `command` node and on a step with `engine:`.
- On a host that keeps no attachments the kind is unknown, so a pipeline with it is refused at
  `pipeline_start` and at every accept; no step waits for a check that cannot run.

## Formats

Run-state format 2 gained the journal event and no state field; format 1 has no place for it and refuses
the write, and a pipeline with the check, with `UNSUPPORTED_FORMAT_FEATURE` and the offer of
`kodel migrate` (`docs/run-formats.md`). `kodel migrate` leaves `attachments/` alone, and removing a run
removes it.

## What the tests cannot show

A kill on a real disk between the file and its journal line (a hook that fails there stands in), the race
on a path under a real scheduler (a hook between the open and the check stands in) and on Windows, a secret
inside an image, and the layout of the TUI on a person's terminal.
