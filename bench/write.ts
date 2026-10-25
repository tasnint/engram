import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import {
  MemoryService,
  VectorDuplicateDetector,
  embeddingFromEnvironment,
  initializeDatabase,
  type StoredMemory,
} from '@engram/core';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const count = Number(process.argv[2] ?? 100);
if (!Number.isInteger(count) || count < 1 || count > 10000)
  throw new Error('Choose a count from 1 to 10000.');
const client = new MongoClient(process.env.MONGODB_URI);
const namespace = `benchmark-${randomUUID()}`;
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE ?? 'engram');
  const embeddings = embeddingFromEnvironment();
  await initializeDatabase(db, embeddings);
  await embeddings.embed(['Warm up the embedding provider.']);
  const results = [];
  for (const mode of process.env.BENCH_VECTOR === 'true' ? ['exact', 'vector'] : ['exact']) {
    const collection = db.collection<StoredMemory>('memories');
    const service = new MemoryService(db, {
      embeddings,
      duplicates:
        mode === 'vector'
          ? new VectorDuplicateDetector(collection, { index: process.env.VECTOR_INDEX_NAME })
          : undefined,
    });
    const durations: number[] = [];
    const started = performance.now();
    for (let index = 0; index < count; index++) {
      const start = performance.now();
      await service.remember({
        namespace,
        userId: `bench-${mode}-${index}`,
        content: `Project ${index} selected configuration ${index} for deployment.`,
      });
      durations.push(performance.now() - start);
    }
    const elapsed = performance.now() - started;
    durations.sort((a, b) => a - b);
    const percentile = (p: number) =>
      Number(durations[Math.max(0, Math.ceil(count * p) - 1)]!.toFixed(2));
    results.push({
      mode,
      count,
      writesPerSecond: Number((count / (elapsed / 1000)).toFixed(2)),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
    });
  }
  console.log(
    JSON.stringify(
      {
        model: embeddings.model,
        dimensions: embeddings.dimensions,
        includesEmbeddingLatency: true,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await client
    .db(process.env.MONGODB_DATABASE ?? 'engram')
    .collection('memories')
    .deleteMany({ namespace });
  await client.close();
}
