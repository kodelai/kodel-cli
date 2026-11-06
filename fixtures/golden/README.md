# Goldens of decisions

`existing-runs/` holds what the engine decided for the scripted runs of
`packages/pipeline-core/test/golden-scenarios.ts` (a consecutive pause and its resume, an accept on a
consecutive pause, a join refused in a run of format 1, ticks, a plain run to its end), one line per
decision: what the store writes (`encoded`) and the effects, or the refusal. It was written by the engine
of commit `2aeae3a` (before engine steps, T-42) from a temporary checkout of that commit with the same
scenario file; `t42_existing_runs_decide_the_same` replays the scenarios on the current build, with and
without engine steps, and compares byte for byte, and `t42_golden_is_pinned` pins the sha256 of the
directory. Never write it again from a later build: a difference is a change of behaviour to look at.
