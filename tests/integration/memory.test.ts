import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import {
  MemoryService,
  consolidateEpisodes,
  decayImportance,
  initializeDatabase,
  type EmbeddingProvider,
  type StoredMemory,
} from '../../packages/core/src/index.js';
import { buildApp } from '../../packages/server/src/app.js';

const embeddings: EmbeddingProvider = {
  model: 'test-model',
  dimensions: 3,
  embed: async (texts) => texts.map(() => [1, 0, 0]),
};
let client: MongoClient;
let db: Db;
let service: MemoryService;
const base = { namespace: 'support', userId: 'u1', content: 'Prefers Python answers' };

beforeAll(async () => {
  client = new MongoClient(process.env.MONGODB_TEST_URI!);
  await client.connect();
  db = client.db(`engram_test_${Date.now()}`);
  await initializeDatabase(db, embeddings);
});
beforeEach(async () => {
  await db.collection('memories').deleteMany({});
  service = new MemoryService(db, { embeddings });
});
afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

describe('MongoDB write path', () => {
  it('persists derived metadata and enforces schema and index configuration', async () => {
    const memory = await service.remember(base);
    expect(memory.tags).toContain('language');
    expect(memory.importance).toBe(0.5);
    expect(memory).not.toHaveProperty('contentHash');
    await expect(
      db.collection('memories').updateOne({ _id: memory._id }, { $set: { importance: 2 } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      db.collection('memories').updateOne({ _id: memory._id }, { $set: { embedding: [1, 2] } }),
    ).rejects.toMatchObject({ code: 121 });
    const indexes = await db.collection('memories').indexes();
    expect(indexes.find((index) => index.name === 'memory_expiry')?.expireAfterSeconds).toBe(0);
    await expect(
      initializeDatabase(db, { model: 'another-model', dimensions: 3 }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_CONFIG_MISMATCH' });
  });

  it('deduplicates simultaneous identical writes while isolating users and namespaces', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => service.remember(base)));
    expect(new Set(results.map((memory) => memory._id.toString())).size).toBe(1);
    await service.remember({ ...base, userId: 'u2' });
    await service.remember({ ...base, namespace: 'other' });
    expect(await db.collection('memories').countDocuments()).toBe(3);
  });

  it('updates a semantic duplicate without resetting access history', async () => {
    const original = await service.remember(base);
    await db.collection('memories').updateOne({ _id: original._id }, { $set: { accessCount: 4 } });
    const stored = await db.collection<StoredMemory>('memories').findOne({ _id: original._id });
    const semantic = new MemoryService(db, {
      embeddings,
      duplicates: { find: async () => stored },
    });
    const next = await semantic.remember({
      ...base,
      content: 'Use Python in responses',
      tags: ['preference'],
    });
    expect(next._id).toEqual(original._id);
    expect(next.accessCount).toBe(4);
    expect(next.tags).toEqual(expect.arrayContaining(['language', 'preference']));
    expect(await db.collection('memories').countDocuments()).toBe(1);
  });

  it('hides expired data before TTL cleanup and replaces an expired exact duplicate', async () => {
    const old = new MemoryService(db, {
      embeddings,
      now: () => new Date(Date.now() - 3 * 86400000),
    });
    await old.remember({ ...base, ttlDays: 1 });
    expect(
      (await service.list({ namespace: base.namespace, userId: base.userId })).memories,
    ).toEqual([]);
    const fresh = await service.remember(base);
    expect(fresh.expiresAt).toBeNull();
    expect(
      (await service.list({ namespace: base.namespace, userId: base.userId })).memories,
    ).toHaveLength(1);
  });

  it('paginates tied timestamps without leaks or repeated rows', async () => {
    const fixed = new MemoryService(db, {
      embeddings,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    for (let index = 0; index < 5; index++)
      await fixed.remember({ ...base, content: `Memory ${index}` });
    await fixed.remember({ ...base, userId: 'another', content: 'Private memory' });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list({
        namespace: base.namespace,
        userId: base.userId,
        limit: 2,
        cursor,
      });
      ids.push(...page.memories.map((memory) => memory._id.toString()));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('decays by elapsed time and does not apply decay twice', async () => {
    const start = new Date(Date.now() - 90 * 86400000);
    const old = new MemoryService(db, { embeddings, now: () => start });
    const memory = await old.remember({ ...base, importance: 0.8 });
    const now = new Date(start.getTime() + 90 * 86400000);
    await decayImportance(db, { now, halfLifeDays: 90 });
    await decayImportance(db, { now, halfLifeDays: 90 });
    const stored = await db.collection('memories').findOne({ _id: memory._id });
    expect(stored?.importance).toBeCloseTo(0.4);
  });

  it('scopes deletion by ID and removes both active and archived user data', async () => {
    const memory = await service.remember(base);
    expect(await service.forget({ id: memory._id.toString() }, { namespace: 'other' })).toEqual({
      deleted: 0,
    });
    await db
      .collection('memories')
      .updateOne({ _id: memory._id }, { $set: { status: 'archived' } });
    await service.remember({ ...base, content: 'Second memory' });
    expect(await service.forget({ namespace: 'support', userId: 'u1' })).toEqual({ deleted: 2 });
  });
});

async function episodes() {
  const date = new Date(Date.now() - 10 * 86400000);
  date.setUTCHours(12, 0, 0, 0);
  const old = new MemoryService(db, { embeddings, now: () => date });
  await old.remember({ ...base, content: 'Discussed Python', type: 'episode', ttlDays: 30 });
  await old.remember({ ...base, content: 'Selected Fastify', type: 'episode' });
}
const consolidationOptions = () => ({
  client,
  db,
  embeddings,
  namespace: 'support',
  olderThan: new Date(Date.now() - 7 * 86400000),
  summarizer: { summarize: async () => 'Selected Python and Fastify.' },
});

describe('transactional consolidation', () => {
  it('writes a summary and archives originals together, preserving the earliest expiry', async () => {
    await episodes();
    const [summary] = await consolidateEpisodes(consolidationOptions());
    expect(summary?.type).toBe('summary');
    expect(summary?.expiresAt).toBeInstanceOf(Date);
    expect(
      await db
        .collection('memories')
        .countDocuments({ status: 'archived', consolidatedInto: summary?._id }),
    ).toBe(2);
    expect(await consolidateEpisodes(consolidationOptions())).toEqual([]);
  });

  it('rolls back the summary insertion when archiving fails validation', async () => {
    await episodes();
    const [info] = await db.listCollections({ name: 'memories' }, { nameOnly: false }).toArray();
    const validator = info!.options!.validator;
    await db.command({
      collMod: 'memories',
      validator: { $and: [validator, { status: { $ne: 'archived' } }] },
    });
    try {
      await expect(consolidateEpisodes(consolidationOptions())).rejects.toMatchObject({
        code: 121,
      });
      expect(await db.collection('memories').countDocuments({ type: 'summary' })).toBe(0);
      expect(
        await db.collection('memories').countDocuments({ type: 'episode', status: 'active' }),
      ).toBe(2);
    } finally {
      await db.command({ collMod: 'memories', validator });
    }
  });

  it('leaves data untouched when the summarizer fails', async () => {
    await episodes();
    await expect(
      consolidateEpisodes({
        ...consolidationOptions(),
        summarizer: {
          summarize: async () => {
            throw new Error('offline');
          },
        },
      }),
    ).rejects.toThrow('offline');
    expect(await db.collection('memories').countDocuments({ status: 'active' })).toBe(2);
  });

  it('does not resurrect a user deleted while the summary is being generated', async () => {
    await episodes();
    const summaries = await consolidateEpisodes({
      ...consolidationOptions(),
      summarizer: {
        summarize: async () => {
          await service.forget({ namespace: 'support', userId: 'u1' });
          return 'Deleted memory';
        },
      },
    });
    expect(summaries).toEqual([]);
    expect(await db.collection('memories').countDocuments()).toBe(0);
  });
});

it('isolates API namespaces, validates inputs, and exposes the recall integration boundary', async () => {
  const key = 'a'.repeat(32);
  const app = await buildApp({ service, apiKeys: { support: key, other: 'b'.repeat(32) } });
  try {
    const headers = { 'x-api-key': key };
    expect((await app.inject({ method: 'POST', url: '/remember', payload: base })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/remember',
          headers,
          payload: { ...base, namespace: 'other' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/remember',
          headers,
          payload: { ...base, importance: 2 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/remember',
          headers,
          payload: { ...base, extra: true },
        })
      ).statusCode,
    ).toBe(400);
    const saved = await app.inject({ method: 'POST', url: '/remember', headers, payload: base });
    expect(saved.statusCode).toBe(200);
    expect(typeof saved.json()._id).toBe('string');
    const denied = await app.inject({
      method: 'POST',
      url: '/forget',
      headers: { 'x-api-key': 'b'.repeat(32) },
      payload: { id: saved.json()._id },
    });
    expect(denied.json()).toEqual({ deleted: 0 });
    const listed = await app.inject({
      url: '/memories?namespace=support&userId=u1&limit=1',
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().memories).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/recall',
          headers,
          payload: { namespace: 'support', userId: 'u1', query: 'Python' },
        })
      ).statusCode,
    ).toBe(501);
    expect((await app.inject('/docs/json')).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
