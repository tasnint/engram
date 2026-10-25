import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { publicMemory, type StoredMemory } from '../database.js';
import { validateEmbeddings } from '../embeddings.js';
import { EngramError } from '../errors.js';
import type { EmbeddingProvider, Memory, Summarizer } from '../types.js';
import { contentHash, unexpired } from './service.js';

export async function decayImportance(
  db: Db,
  options: { halfLifeDays?: number; now?: Date } = {},
): Promise<number> {
  const halfLifeDays = options.halfLifeDays ?? 90;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0)
    throw new Error('Half-life must be positive.');
  const now = options.now ?? new Date();
  const result = await db
    .collection<StoredMemory>('memories')
    .updateMany({ status: 'active', decayAt: { $lt: now }, ...unexpired(now) }, [
      {
        $set: {
          importance: {
            $multiply: [
              '$importance',
              {
                $pow: [
                  0.5,
                  { $divide: [{ $subtract: [now, '$decayAt'] }, halfLifeDays * 86400000] },
                ],
              },
            ],
          },
          decayAt: now,
        },
      },
    ]);
  return result.modifiedCount;
}

export function startDecayJob(
  run: () => Promise<unknown>,
  options: { intervalMs: number; onError: (error: unknown) => void },
): () => Promise<void> {
  if (
    !Number.isFinite(options.intervalMs) ||
    options.intervalMs < 1000 ||
    options.intervalMs > 2147483647
  )
    throw new Error('Decay interval must be between 1000 and 2147483647 ms.');
  let running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = run()
      .catch(options.onError)
      .finally(() => {
        running = undefined;
      });
  }, options.intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}

export async function consolidateEpisodes(options: {
  client: MongoClient;
  db: Db;
  embeddings: EmbeddingProvider;
  summarizer: Summarizer;
  namespace: string;
  olderThan: Date;
  now?: Date;
  minEpisodes?: number;
  maxEpisodes?: number;
  maxGroups?: number;
}): Promise<Memory[]> {
  const { client, db, embeddings, summarizer } = options;
  const now = options.now ?? new Date();
  const minEpisodes = options.minEpisodes ?? 2;
  const maxEpisodes = options.maxEpisodes ?? 20;
  const maxGroups = options.maxGroups ?? 100;
  if (
    !options.namespace.trim() ||
    !Number.isFinite(options.olderThan.getTime()) ||
    options.olderThan > now ||
    ![minEpisodes, maxEpisodes, maxGroups].every(Number.isInteger) ||
    minEpisodes < 2 ||
    maxEpisodes < minEpisodes ||
    maxEpisodes > 100 ||
    maxGroups < 1 ||
    maxGroups > 1000
  )
    throw new Error('Invalid consolidation options.');
  const collection = db.collection<StoredMemory>('memories');
  const match = {
    namespace: options.namespace,
    status: 'active' as const,
    type: 'episode' as const,
    createdAt: { $lt: options.olderThan },
    ...unexpired(now),
  };
  const groups = await collection
    .aggregate<{ _id: { userId: string; day: Date }; count: number }>([
      { $match: match },
      {
        $group: {
          _id: {
            userId: '$userId',
            day: { $dateTrunc: { date: '$createdAt', unit: 'day', timezone: 'UTC' } },
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gte: minEpisodes } } },
      { $sort: { '_id.day': 1, '_id.userId': 1 } },
      { $limit: maxGroups },
    ])
    .toArray();
  const summaries: Memory[] = [];
  for (const group of groups) {
    const episodes = await collection
      .find({
        ...match,
        userId: group._id.userId,
        createdAt: {
          $gte: group._id.day,
          $lt: new Date(Math.min(group._id.day.getTime() + 86400000, options.olderThan.getTime())),
        },
      })
      .sort({ createdAt: 1, _id: 1 })
      .limit(maxEpisodes)
      .toArray();
    if (episodes.length < minEpisodes) continue;
    const content = (await summarizer.summarize(episodes)).trim();
    if (!content || content.length > 16000)
      throw new EngramError(
        'INVALID_SUMMARY',
        'The summarizer must return between 1 and 16000 characters.',
        502,
      );
    const [embedding] = validateEmbeddings(
      await embeddings.embed([content], 'document'),
      1,
      embeddings.dimensions,
    );
    const expirations = episodes.flatMap((episode) =>
      episode.expiresAt ? [episode.expiresAt.getTime()] : [],
    );
    const summary: StoredMemory = {
      _id: new ObjectId(),
      namespace: options.namespace,
      userId: group._id.userId,
      type: 'summary',
      content,
      embedding: embedding!,
      tags: [...new Set(episodes.flatMap((episode) => episode.tags))].slice(0, 64),
      importance: Math.max(...episodes.map((episode) => episode.importance)),
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      expiresAt: expirations.length ? new Date(Math.min(...expirations)) : null,
      status: 'active',
      source: { sessionId: null, messageId: null },
      consolidatedInto: null,
      contentHash: contentHash(content),
      decayAt: now,
    };
    const session = client.startSession();
    try {
      const committed = await session.withTransaction(
        async () => {
          const fresh = await collection
            .find(
              {
                _id: { $in: episodes.map((episode) => episode._id) },
                status: 'active',
                ...unexpired(new Date()),
              },
              { session },
            )
            .toArray();
          if (
            fresh.length !== episodes.length ||
            fresh.some((episode) => {
              const original = episodes.find((item) => item._id.equals(episode._id));
              return !original || JSON.stringify(episode) !== JSON.stringify(original);
            })
          )
            return false;
          await collection.insertOne(summary, { session });
          const result = await collection.updateMany(
            { _id: { $in: episodes.map((episode) => episode._id) }, status: 'active' },
            { $set: { status: 'archived', consolidatedInto: summary._id } },
            { session },
          );
          if (result.modifiedCount !== episodes.length)
            throw new EngramError(
              'CONSOLIDATION_CONFLICT',
              'Episodes changed during consolidation.',
              409,
            );
          return true;
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
      if (committed) summaries.push(publicMemory(summary));
    } finally {
      await session.endSession();
    }
  }
  return summaries;
}
