# Changesets

This repo uses Changesets to drive releases for the published `executor` CLI.

## What to put in a changeset

Only `executor` is managed directly by Changesets.

Release PRs should only version the published CLI package instead of the rest of the workspace.

## Beta releases

Use prerelease mode for beta trains:

- `bun run release:beta:start`
- merge release PRs while prerelease mode is active
- `bun run release:beta:stop` when you want to return to stable releases
