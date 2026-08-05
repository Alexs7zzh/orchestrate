# Orchestrate contributor guide

These instructions apply to every contributor and coding agent in this repository.

## Source and verification

All TypeScript source lives in `scripts/` and uses Bun.

```bash
cd scripts
bun run verify          # format check, lint, typecheck, dependency check, full test suite
bun run build:compile   # compiled CLI at scripts/dist/orchestrate
bun run schema          # regenerate references/*.schema.json from source types
```

Use the narrowest verification appropriate to the change, then run `bun run verify` before shipping
runtime changes. Do not commit generated bundles or release archives.

## Documentation authority

- `references/*.schema.json` are generated from source; never hand-edit them. Edit source
  types/schema code, then run `bun run schema`. `workflow.schema.json` defines workflow structure.
- `references/workflow-format.md` is the semantic authoring contract for cross-field workflow rules.
- `references/cli-spec.md` is the public command, JSON, and exit-code contract. Keep its command
  table synchronized with `PUBLIC_COMMAND_HELP` and the flag sets in `scripts/src/cli.ts`.
- `references/guarantees.md` is the normative reliability and ownership contract. Never promise a
  guarantee there that the runtime cannot keep.
- `references/runtime-operations.md` explains implementation and recovery mechanics. It must not
  imply a stronger guarantee than `references/guarantees.md`.
- `references/examples.md` contains illustrative, schema-valid patterns; it is not an exhaustive
  statement of product semantics.
- `README.md` is the human entry point. `SKILL.md` is the concise agent operating contract and
  should route to references instead of repeating their mechanics.

The authoritative minimum Herdr version is `MINIMUM_HERDR_VERSION` in
`scripts/src/herdr-contract.ts`, mirrored by `min_herdr_version` in
`herdr-plugin/herdr-plugin.toml`. Update the README requirement and `herdr-plugin/README.md` when it
changes.

## Packaging

The release contract in `scripts/src/release.ts` pins the packaged payload. Adding or removing files
under `references/`, `agents/`, or `herdr-plugin/` requires updating that contract. Root contributor
files such as this guide are not installed product assets.
