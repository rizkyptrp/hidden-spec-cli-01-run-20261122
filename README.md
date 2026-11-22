[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rizkyptrp/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rizkyptrp/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all four to one written contract (`SPEC.md`):

- unified diffs, often with wrong line numbers,
- SEARCH/REPLACE blocks,
- V4A patches,
- text-editor tool calls as JSON.

It finds the lines an edit names at the first of three matching tiers — exact, then
trailing-whitespace tolerant, then indentation-drift tolerant — and changes every file
or none, printing what it changed or why it failed.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree).
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) and
`ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 prints one usage, no-patch,
format or parse error line.

## Layout

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's runner: in a trial it reads the checks from the env and runs
  `main.ts` on each one.
- `check.ts` — run the public practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the whole contract.

## License

MIT. See `LICENSE`.
