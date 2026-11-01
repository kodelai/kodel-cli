Saved, sanitized copy of the shape of the pricing page, used by the tests of `scripts/check-prices.mjs` so that no test
needs the network. The file name is `encodeURIComponent(sourceUrl)` plus `.html`. It is made by hand from the layout of the
published page (a table with one row per model); the numbers are the ones in `price-table.json`.
