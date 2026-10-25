import { z } from "zod";
import type { EmbeddingProvider } from "../types.js";
import { HashEmbedder } from "./hash-embedder.js";
import { LocalEmbeddingProvider, VoyageEmbeddingProvider } from "./providers.js";

export { HashEmbedder, tokenize } from "./hash-embedder.js";
export {
  LocalEmbeddingProvider,
  VoyageEmbeddingProvider,
  validateEmbeddings,
} from "./providers.js";

/** Picks the embedding provider from EMBEDDING_PROVIDER and friends (see .env.example). */
export function embeddingFromEnvironment(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = z
    .enum(["local", "voyage", "hash"])
    .default("local")
    .parse(env.EMBEDDING_PROVIDER || undefined);
  const dimensions = env.EMBEDDING_DIMENSIONS
    ? z.coerce.number().int().positive().parse(env.EMBEDDING_DIMENSIONS)
    : undefined;
  if (provider === "voyage")
    return new VoyageEmbeddingProvider({
      apiKey: env.VOYAGE_API_KEY ?? "",
      model: env.VOYAGE_MODEL || undefined,
      dimensions,
    });
  if (provider === "hash") return new HashEmbedder(dimensions);
  return new LocalEmbeddingProvider({
    model: env.LOCAL_MODEL || undefined,
    dimensions,
    offline:
      z
        .enum(["true", "false"])
        .default("false")
        .parse(env.LOCAL_OFFLINE || undefined) === "true",
    localModelPath: env.LOCAL_MODEL_PATH || undefined,
  });
}
