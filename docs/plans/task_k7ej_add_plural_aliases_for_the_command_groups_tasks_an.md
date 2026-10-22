# TASK-K7EJ: plural aliases for the command groups

## Goal
`kodel tasks ...` works like `kodel task ...`, through one helper in `packages/cli/src/cli.ts`
that gives a command group its plural alias, so a group added later gets it by using the helper.

## Affected files
- `packages/cli/src/cli.ts`: a small module-level helper `withPlural(group)` that calls
  `group.alias(`${group.name()}s`)` and returns the group; applied where the groups are made.
- `packages/cli/test/cli.test.ts` (or `tasks.test.ts`): tests.

## Steps
1. Add `withPlural(command: Command): Command` (works only on a group, a command with subcommands).
2. Wrap the `task` group and the `pipeline` group (`pipeline` -> `pipelines`) with it. The chain
   `program.command("pipeline").description(..).command("changes")` is split so the alias lands on
   `pipeline`, not on `changes`.
3. Decision for the rest: `status`, `report`, `gate`, `resume`, `ack`, `seal`, `mcp` are leaf commands
   and/or verbs or mass nouns; no plural. `changes` is already plural.

## Test strategy
- `kodel tasks add/list/show` give the same result as `kodel task ...`.
- `kodel pipelines changes ...` is accepted like `kodel pipeline changes ...`.
- Help of the program lists `task|tasks` once (the alias does not add a second entry); `tasks --help` works.
- Helper applied to a fresh Commander group gives `<name>s`, so a later group gets the same.

## Risks
- Another task edits cli.ts (table headers): the change is a helper plus two call sites, to merge easily.
- Splitting the `pipeline` chain touches a few lines near the `changes` group.
