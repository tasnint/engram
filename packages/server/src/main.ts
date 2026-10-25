/** Starts the REST API. Configure with .env (see .env.example). */
import { z } from "zod";
import {
  connect,
  createEngram,
  decayImportance,
  duplicatesFromEnvironment,
  embeddingFromEnvironment,
  initializeDatabase,
  startDecayJob,
} from "@engram/core";
import { buildApp } from "./app.js";

const config = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default("127.0.0.1"),
    API_KEYS: z.string().transform((value) => JSON.parse(value) as Record<string, string>),
    DECAY_INTERVAL_MS: z.coerce.number().int().min(1000).max(2147483647).default(86400000),
    IMPORTANCE_HALF_LIFE_DAYS: z.coerce.number().positive().default(90),
  })
  .parse(process.env);

const engram = await connect();
try {
  const embeddings = embeddingFromEnvironment();
  await initializeDatabase(engram.db, embeddings);
  const api = createEngram({
    db: engram.db,
    embeddings,
    duplicates: duplicatesFromEnvironment(engram.db),
  });
  const app = await buildApp({
    service: api.service,
    recall: api.recall,
    apiKeys: config.API_KEYS,
    logger: true,
  });
  const stopDecay = startDecayJob(
    () => decayImportance(engram.db, { halfLifeDays: config.IMPORTANCE_HALF_LIFE_DAYS }),
    { intervalMs: config.DECAY_INTERVAL_MS, onError: (error) => app.log.error(error) },
  );
  app.addHook("onClose", async () => {
    await stopDecay();
    await engram.close();
  });
  const shutdown = async () => {
    await app.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  await engram.close();
  throw error;
}
