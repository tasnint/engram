/**
 * End to end across both tracks: remember (A) → recall (B) → forget (A),
 * on a database set up exactly like production (schema validation from A1,
 * search indexes from B1), plus the REST API's /recall wired to Track B.
 */
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEngram,
  ensureSearchIndexes,
  HashEmbedder,
  initializeDatabase,
  MEMORIES_COLLECTION,
  VectorDuplicateDetector,
  waitForSearchIndexes,
  type Engram,
  type MemoryDoc,
  type StoredMemory,
} from "@engram/core";
import { buildApp } from "@engram/server";
import { canUseSearch, waitUntilSearchable } from "./search.js";

const uri = process.env.MONGODB_TEST_URI!;
const searchAvailable = await canUseSearch(uri);
const embeddings = new HashEmbedder(64);
const scope = { namespace: "support", userId: "u1" };

describe.skipIf(!searchAvailable)("remember → recall → forget", () => {
  let client: MongoClient;
  let db: Db;
  let engram: Engram;
  let count = 0;

  const remember = async (content: string, extra: object = {}) => {
    const memory = await engram.remember({ ...scope, content, ...extra });
    return memory;
  };
  const settle = async (expected: number) => {
    count = expected;
    await waitUntilSearchable(db.collection<MemoryDoc>(MEMORIES_COLLECTION), embeddings, expected);
  };

  beforeAll(async () => {
    client = await new MongoClient(uri).connect();
    db = client.db(`engram_e2e_${Date.now()}`);
    await initializeDatabase(db, embeddings);
    await ensureSearchIndexes(db, { dimensions: embeddings.dimensions });
    await waitForSearchIndexes(db.collection<MemoryDoc>(MEMORIES_COLLECTION));
    engram = createEngram({
      db,
      embeddings,
      duplicates: new VectorDuplicateDetector(db.collection<StoredMemory>(MEMORIES_COLLECTION), {
        threshold: 0.9,
      }),
    });
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  it("recalls what was remembered, with storage fields hidden", async () => {
    await remember("Prefers code examples in Python", { type: "preference" });
    await remember("Deploy failed because the Helm chart pinned an old image tag", {
      type: "episode",
    });
    await remember("Has a corgi named Biscuit");
    await settle(3);

    const [top] = await engram.recall({ ...scope, query: "why did the deploy fail" });
    expect(top?.memory.content).toMatch(/Helm chart/);
    expect(top?.memory).not.toHaveProperty("embedding");
    expect(top?.memory).not.toHaveProperty("contentHash");
    expect(top?.memory).not.toHaveProperty("decayAt");
  });

  it("merges a near-duplicate instead of storing it twice (A3 on B1's index)", async () => {
    const before = await db.collection(MEMORIES_COLLECTION).countDocuments();
    const merged = await remember("Prefers code examples in Python!", {
      type: "preference",
      tags: ["coding"],
    });
    expect(await db.collection(MEMORIES_COLLECTION).countDocuments()).toBe(before);
    expect(merged.content).toBe("Prefers code examples in Python!");
    expect(merged.tags).toContain("coding");
  });

  it("counts recalls on the stored memory (B4) without breaking schema validation", async () => {
    const stored = () =>
      db.collection<StoredMemory>(MEMORIES_COLLECTION).findOne({ content: /Biscuit/ });
    const before = (await stored())!.accessCount;
    const [hit] = await engram.recall({ ...scope, query: "corgi Biscuit", k: 1 });
    expect(hit?.memory.content).toMatch(/Biscuit/);
    expect((await stored())!.accessCount).toBe(before + 1);
  });

  it("stops recalling a memory once it's forgotten", async () => {
    const [hit] = await engram.recall({ ...scope, query: "corgi Biscuit", k: 1 });
    expect(await engram.forget({ id: hit!.memory._id.toHexString() })).toEqual({ deleted: 1 });
    await settle(count - 1);
    const results = await engram.recall({ ...scope, query: "corgi Biscuit", k: 5 });
    expect(results.some((r) => /Biscuit/.test(r.memory.content))).toBe(false);
  });

  it("serves recall over the REST API, scoped to the API key's namespace", async () => {
    const key = "k".repeat(32);
    const app = await buildApp({
      service: engram.service,
      recall: engram.recall,
      apiKeys: { support: key, other: "o".repeat(32) },
    });
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/recall",
        headers: { "x-api-key": key },
        payload: { ...scope, query: "Python examples", k: 2, mode: "hybrid" },
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json();
      expect(body[0].memory.content).toMatch(/Python/);
      expect(body[0].signals).toMatchObject({ relevance: expect.any(Number) });

      const wrongNamespace = await app.inject({
        method: "POST",
        url: "/recall",
        headers: { "x-api-key": "o".repeat(32) },
        payload: { ...scope, query: "Python" },
      });
      expect(wrongNamespace.statusCode).toBe(403);

      const badK = await app.inject({
        method: "POST",
        url: "/recall",
        headers: { "x-api-key": key },
        payload: { ...scope, query: "Python", k: 500 },
      });
      expect(badK.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
