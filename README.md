# Engram

Long-term memory for AI agents, built on MongoDB Community Server and MongoDB Search (`mongot`).

An agent saves what it learns ("prefers Python", "the deploy failed because of the Helm chart") and later recalls the memories that matter for the task at hand. Recall combines keyword search and meaning (vector) search, then ranks results by relevance, importance and recency.

## Quick start

Requires Node 22 (`nvm use`), pnpm, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up        # MongoDB 9 replica set + mongot
pnpm db:indexes   # create the search indexes
pnpm db:seed      # load sample memories
pnpm --filter @engram/dashboard dev   # http://localhost:4317
```

On Windows with WSL, turn on WSL integration in Docker Desktop (Settings → Resources → WSL integration) so `docker` works inside WSL.

## Layout

| Path              | What                                                                                | Owner                      |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| `packages/core`   | The engine. `src/read/` is search and ranking, `src/write/` is saving and lifecycle | read: Tanisha, write: Neha |
| `packages/mcp`    | MCP server, so Claude Desktop or any MCP agent can use Engram                       | Tanisha                    |
| `packages/server` | REST API                                                                            | Neha                       |
| `packages/sdk`    | TypeScript client                                                                   | Neha                       |
| `apps/dashboard`  | Live dashboard: stats, explained search, change stream feed                         | Tanisha                    |
| `docker/`         | Local MongoDB + mongot config                                                       | Tanisha                    |

## How recall works

1. **Search** with two indexes in parallel. `$vectorSearch` finds memories with similar meaning, and `$search` (Lucene, English stemming) finds keyword matches. Both pre-filter inside the index to one user's active memories.
2. **Fuse** the two ranked lists with reciprocal rank fusion: `score = Σ weight / (60 + rank)`. It runs in the app by default, or in the database with `$rankFusion` (`fusion: "server"`).
3. **Rank** with `0.6 × relevance + 0.2 × importance + 0.2 × recency`, where recency halves every 30 days unused (after Park et al., _Generative Agents_, 2023).
4. **Track** use: one `updateMany` bumps `accessCount` and `lastAccessedAt` on the results.

## Tests

```bash
pnpm test               # unit tests, no database needed
pnpm test:integration   # needs pnpm db:up; skips itself if no database is reachable
pnpm lint && pnpm typecheck
```

## Embeddings

`ENGRAM_EMBEDDER=hash` (the default) is a free offline stand-in. It matches shared words, not meaning, so "what food should I avoid" won't find "allergic to peanuts". Real providers (Voyage AI, local model) come with P4. If you change models, re-run `pnpm db:indexes`, which rebuilds the vector index for the new vector length.
