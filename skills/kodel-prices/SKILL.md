---
name: kodel-prices
description: Check the shipped token price table of Kodel against the published price lists and against Claude Code's own cost entries, and update it. For maintainers of Kodel, for example "/kodel-prices" or "/kodel-prices local". Use when a model was released, a price changed, or a cost in a report looks wrong.
argument-hint: "[local]"
---

# Keep the price table right

The table that turns tokens into an estimated cost is `packages/pipeline-core/src/price-table.json`
(dollars per million tokens; `revision`, and per model a list of dated entries with `input`, `output`,
`cache_read`, `cache_write`, `cache_write_1h`, `long_context_tokens`, `effectiveFrom`, `sourceUrl`, `checkedAt`). A cost is
stored with the `revision` it was computed with and is never recomputed, so a change to the table
affects only runs that start afterwards. This skill is for the people who maintain Kodel; it is not
installed by `kodel init`.

1. Run `node scripts/check-prices.mjs` from the repository root. It fetches each `sourceUrl` and
   compares the dollar amounts after the model's name with the entry. Read its answer:
   - exit 0: the page agrees with the table;
   - exit 1: a price differs (the model and the amounts that are not on the page are named);
   - exit 2: a page is unreachable, or no longer names a model (the page format may have changed). Do
     not edit the table from a page you could not read; say what failed.
   The line `not yet checked (checkedAt null)` lists entries nobody has compared with a price list.
2. With the argument `local`, run `node scripts/check-prices.mjs --local`. It reads the sessions of this
   Kodel project only and compares the table's cost with the `cost-state` entry Claude Code writes at the
   end of a session. A difference over 10% is shown. Expect `cost-state` to be a little higher (it counts
   requests the transcript does not hold); a session with `hasUnknownModelCost` is skipped. It is a hint,
   not a verdict: read the price list before you change a price.
3. When a price changed, do not edit the entry in place: add a new entry with `effectiveFrom` set to the
   day the new price began, so older events still use the price they had. When a model is new, add it with
   all its prices (`input`, `output`, `cache_read`, `cache_write`, `cache_write_1h`) and, where the vendor prices large prompts
   differently, its own `long_context_tokens`. Set `checkedAt` to today only for an entry you compared with the price list yourself,
   and set a new `revision` (today's date).
4. Run `bun test packages/local/test/check-prices.test.ts packages/pipeline-core/test/usage.test.ts`, then
   the whole suite, and show the person the diff of the table. Never commit a price you could not confirm.

Long-context pricing is not modelled; the report flags the requests whose prompt is over the model's `long_context_tokens` (200 000
unless the entry says otherwise, 100 000 for Haiku 5.5).
