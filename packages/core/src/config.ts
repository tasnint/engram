import { z } from 'zod';
import { LocalEmbeddingProvider, VoyageEmbeddingProvider } from './embeddings.js';
import type { EmbeddingProvider } from './types.js';

export function embeddingFromEnvironment(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = z.enum(['local', 'voyage']).default('local').parse(env.EMBEDDING_PROVIDER);
  const dimensions = env.EMBEDDING_DIMENSIONS
    ? z.coerce.number().int().positive().parse(env.EMBEDDING_DIMENSIONS)
    : undefined;
  if (provider === 'voyage')
    return new VoyageEmbeddingProvider({
      apiKey: env.VOYAGE_API_KEY ?? '',
      model: env.VOYAGE_MODEL || undefined,
      dimensions,
    });
  return new LocalEmbeddingProvider({
    model: env.LOCAL_MODEL || undefined,
    dimensions,
    offline: z.enum(['true', 'false']).default('false').parse(env.LOCAL_OFFLINE) === 'true',
    localModelPath: env.LOCAL_MODEL_PATH || undefined,
  });
}
