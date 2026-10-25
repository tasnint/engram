import { MongoClient } from 'mongodb';
import { z } from 'zod';
import {
  MemoryService,
  VectorDuplicateDetector,
  decayImportance,
  embeddingFromEnvironment,
  initializeDatabase,
  startDecayJob,
  type StoredMemory,
} from '@engram/core';
import { buildApp } from './app.js';

const config = z
  .object({
    MONGODB_URI: z.string().min(1),
    MONGODB_DATABASE: z.string().default('engram'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),
    API_KEYS: z.string().transform((value) => JSON.parse(value) as Record<string, string>),
    DEDUP_MODE: z.enum(['exact', 'vector']).default('exact'),
    DEDUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
    VECTOR_INDEX_NAME: z.string().default('memories_vector'),
    DECAY_INTERVAL_MS: z.coerce.number().int().min(1000).max(2147483647).default(86400000),
    IMPORTANCE_HALF_LIFE_DAYS: z.coerce.number().positive().default(90),
  })
  .parse(process.env);
const client = new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
  const db = client.db(config.MONGODB_DATABASE);
  const embeddings = embeddingFromEnvironment();
  await initializeDatabase(db, embeddings);
  const duplicates =
    config.DEDUP_MODE === 'vector'
      ? new VectorDuplicateDetector(db.collection<StoredMemory>('memories'), {
          index: config.VECTOR_INDEX_NAME,
          threshold: config.DEDUP_THRESHOLD,
        })
      : undefined;
  const service = new MemoryService(db, { embeddings, duplicates });
  const app = await buildApp({ service, apiKeys: config.API_KEYS, logger: true });
  const stopDecay = startDecayJob(
    () => decayImportance(db, { halfLifeDays: config.IMPORTANCE_HALF_LIFE_DAYS }),
    { intervalMs: config.DECAY_INTERVAL_MS, onError: (error) => app.log.error(error) },
  );
  app.addHook('onClose', async () => {
    await stopDecay();
    await client.close();
  });
  const shutdown = async () => {
    await app.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  await client.close();
  throw error;
}
