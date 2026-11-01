# How the project is found

A **project** is a folder with a committed `.kodel/config.yaml` (`kodel init` writes it). Its runs,
tasks, pipelines and config live in the `.kodel` folder there, except that with `storage: home` in the config the
runs, the proposals made outside a run, `start.lock` and the session index live under
`~/.kodel/projects/<project_id>/` (see [Where the history is kept](history.md#where-the-history-is-kept)). One
function decides which project a command, the MCP server or the pipeline host works on, so they always agree.

Order:

1. **`--root <dir>`**, else the `KODEL_ROOT` environment variable: used as is. No marker is needed, and
   a linked worktree given here is not mapped to anything.
2. **The nearest marker above the current folder.** The walk starts at the real path of the folder
   (symbolic links resolved). Inside a git repository it stops at the top of the repository, so a
   nested repository or a submodule does not use the project above it; without git it goes up to the
   top of the file system. The `.kodel` folder in your home directory belongs to another product and is
   skipped. `.kodel/pipelines/` alone is not a project.
3. **Linked worktrees.** If the current folder is in a linked git worktree, the marker found in it is
   mapped to the same place in the main checkout (git's common directory has to be a folder named
   `.git`), and the main checkout's `.kodel` is used. A run started in a worktree, a task made there and
   `kodel status` therefore see the same data. If git is missing or answers something unexpected, the
   project is used in place.
4. **No marker:** the error says "no Kodel project here (no .kodel/config.yaml in this folder or above);
   run kodel init here, or pass --root". There is no fallback store and nothing is written. The CLI
   exits with an error; the MCP server still starts, lists its tools, and every tool answers
   `{ok: false, code: "NO_PROJECT", message}` (the `task_*` tools are not offered, because whether tasks
   are on is not known).

A monorepo may have a project per package (`kodel init` in each); the nearest one wins, there is no
merging, and `--root` picks another. A run of a project that is a subfolder of the repository works in
the same subfolder of its worktree.

The CLI says on stderr (never stdout, which is the MCP protocol and the data of `--json`) when it used a
project other than the current folder's: `using the project at <path>: you are in a worktree of it`, or
`using the project at <path>: it is above this folder` when the walk climbed without a git boundary. A
plain subfolder of a repository is silent.
