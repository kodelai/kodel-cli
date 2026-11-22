# Task files of the `local` adapter, format 1

One YAML file per task in `.kodel/tasks/` (`v: 1`). Every file was written by the real adapter;
the titles and texts are invented.

- `person-before-marks.yaml`: written by the adapter as it was before tasks carried a mark
  (TASK-G8KM, T-44): created, then moved to `progress` with a run attached. It has none of the four
  keys and reads as a person's task: it does not wait for an approval.
- `agent-with-marks.yaml`: written by the adapter with the mark: made by an agent in a run
  (`created_by`, `created_in_run`), approved by a person (`approved_at`), then changed by an agent
  (`agent_edited_at` later than `approved_at`), so it waits for an approval again.
- `with-links.yaml`: written by the adapter with links (TASK-9RZD, T-45): made with `depends_on` and
  `conflicts_with`. The two tasks it names are not in this folder, so read alone its dependency is
  `missing`.

The four keys are optional additions to format 1, not a new version: a file without them is a
person's task, and an older kodel keeps them when it rewrites the file (its schema passes unknown
keys through). `packages/local/test/task-mark.test.ts` (`t44_task_mark_round_trip`) reads the first
two and writes them back.

`depends_on` and `conflicts_with` are optional additions to format 1 in the same way: a file without
them has no links, and an older kodel keeps them when it rewrites the file (after the keys it knows)
but does not act on them. `packages/local/test/task-links.test.ts` (`t45_task_file_links_round_trip`,
`t45_older_writer_keeps_the_link_keys`) reads all three files and writes them back.
