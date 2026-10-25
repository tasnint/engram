import type { Embedder } from "../types.js";
import { HashEmbedder } from "./hash-embedder.js";

export { HashEmbedder } from "./hash-embedder.js";

/**
 * Picks an embedder from ENGRAM_EMBEDDER / ENGRAM_EMBEDDING_DIMS.
 * TODO(P4, Neha): add "voyage" and "local" providers here.
 */
export function createEmbedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  const kind = env.ENGRAM_EMBEDDER ?? "hash";
  const dims = env.ENGRAM_EMBEDDING_DIMS ? Number(env.ENGRAM_EMBEDDING_DIMS) : undefined;
  switch (kind) {
    case "hash":
      return new HashEmbedder(dims);
    default:
      throw new Error(`Unknown ENGRAM_EMBEDDER "${kind}". Supported: hash`);
  }
}
