/**
 * recall() against a real MongoDB + mongot. Start one with `pnpm db:up`.
 * Skips itself (with a message) if no search-capable database is reachable.
 */
import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MONGODB_URI,
  ensureSearchIndexes,
  HashEmbedder,
  MEMORIES_COLLECTION,
  recall,
  TEXT_INDEX_NAME,
  VECTOR_INDEX_NAME,
  waitForSearchIndexes,
  type MemoryDoc,
  type MemoryType,
  type RecallInput,
} from "../../src/index.js";

const uri = process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI;
const searchAvailable = await canUseSearch(uri);
if (!searchAvailable) {
  console.warn(`Skipping integration tests: no MongoDB with search at ${uri}. Run \`pnpm db:up\`.`);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-25T12:00:00Z");
const embedder = new HashEmbedder(64);

interface Fixture {
  content: string;
  namespace?: string;
  userId?: string;
  type?: MemoryType;
  status?: "active" | "archived";
  daysAgo?: number;
  importance?: number;
}

const fixtures: Fixture[] = [
  {
    content: "Deploy failed on Tuesday because the Helm chart pinned an old image tag",
    type: "episode",
    daysAgo: 2,
  },
  { content: "Their team deploys to Kubernetes with Helm", type: "fact", daysAgo: 40 },
  { content: "Prefers code examples in Python", type: "preference", daysAgo: 10 },
  { content: "Has a corgi named Biscuit", type: "fact", daysAgo: 100 },
  {
    content: "Deploy failed last year because of an expired certificate",
    type: "episode",
    daysAgo: 400,
  },
  // Must never show up for u1 in bot-a:
  { content: "Deploy failed because the Helm chart was wrong", userId: "u2" },
  { content: "Deploy failed because the Helm chart was wrong", namespace: "bot-b" },
  { content: "Deploy failed: Helm chart merged into a summary", status: "archived" },
];

describe.skipIf(!searchAvailable)("recall (integration)", () => {
  let client: MongoClient;
  let db: Db;
  let memories: Collection<MemoryDoc>;
  const deps = () => ({ memories, embedder, now: () => NOW });
  const ask = (input: Partial<RecallInput> & { query: string }) =>
    recall(deps(), { namespace: "bot-a", userId: "u1", ...input }, { trackAccess: false });

  beforeAll(async () => {
    client = await new MongoClient(uri).connect();
    db = client.db(`engram_test_${Date.now()}`);
    await ensureSearchIndexes(db, { dimensions: embedder.dimensions });
    memories = db.collection<MemoryDoc>(MEMORIES_COLLECTION);
    await waitForSearchIndexes(memories);

    const vectors = await embedder.embed(
      fixtures.map((f) => f.content),
      "document",
    );
    await memories.insertMany(
      fixtures.map((f, i) => {
        const createdAt = new Date(NOW.getTime() - (f.daysAgo ?? 5) * DAY);
        return {
          _id: new ObjectId(),
          namespace: f.namespace ?? "bot-a",
          userId: f.userId ?? "u1",
          type: f.type ?? "episode",
          content: f.content,
          embedding: vectors[i]!,
          tags: [],
          importance: f.importance ?? 0.5,
          accessCount: 0,
          lastAccessedAt: createdAt,
          createdAt,
          expiresAt: null,
          status: f.status ?? "active",
          source: {},
          consolidatedInto: null,
        };
      }),
    );
    await waitUntilSearchable(memories, fixtures.length);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  it("finds the best match with hybrid search", async () => {
    const [top] = await ask({ query: "why did the deploy fail", k: 3 });
    expect(top?.memory.content).toMatch(/Helm chart pinned an old image tag/);
    expect(top?.signals.vectorRank).not.toBeNull();
    expect(top?.signals.textRank).not.toBeNull();
  });

  it("only returns this user's active memories in this namespace", async () => {
    const results = await ask({ query: "deploy failed helm chart", k: 20 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.memory.namespace).toBe("bot-a");
      expect(r.memory.userId).toBe("u1");
      expect(r.memory.status).toBe("active");
    }
  });

  it("never returns embeddings or internal score fields", async () => {
    const [top] = await ask({ query: "deploy" });
    expect(Object.keys(top!.memory).sort()).toEqual(
      [
        "_id",
        "namespace",
        "userId",
        "type",
        "content",
        "tags",
        "importance",
        "accessCount",
        "lastAccessedAt",
        "createdAt",
        "expiresAt",
        "status",
        "source",
        "consolidatedInto",
      ].sort(),
    );
  });

  it("filters by type", async () => {
    const results = await ask({ query: "deploy helm", types: ["fact"], k: 10 });
    // Meaning search always returns the nearest facts, even weak ones, so check
    // the filter held and the right fact won, not the exact list.
    expect(results.every((r) => r.memory.type === "fact")).toBe(true);
    expect(results[0]?.memory.content).toBe("Their team deploys to Kubernetes with Helm");
  });

  it("filters by creation date", async () => {
    const results = await ask({
      query: "deploy failed",
      since: new Date(NOW.getTime() - 30 * DAY),
      k: 10,
    });
    expect(results.every((r) => r.memory.createdAt.getTime() >= NOW.getTime() - 30 * DAY)).toBe(
      true,
    );
    expect(results.some((r) => /certificate/.test(r.memory.content))).toBe(false);
  });

  it("supports keyword-only and meaning-only modes", async () => {
    const text = await ask({ query: "corgi", mode: "text" });
    expect(text[0]?.memory.content).toMatch(/Biscuit/);
    expect(text[0]?.signals.vectorRank).toBeNull();

    const vector = await ask({ query: "corgi named Biscuit", mode: "vector" });
    expect(vector[0]?.memory.content).toMatch(/Biscuit/);
    expect(vector[0]?.signals.textRank).toBeNull();
  });

  it("ranks recent memories above old ones that match equally", async () => {
    const results = await ask({ query: "deploy failed because", k: 5 });
    const recent = results.findIndex((r) => /image tag/.test(r.memory.content));
    const old = results.findIndex((r) => /certificate/.test(r.memory.content));
    expect(recent).toBeGreaterThanOrEqual(0);
    expect(old === -1 || recent < old).toBe(true);
  });

  it("gives the same top result with server-side $rankFusion", async () => {
    const input = { namespace: "bot-a", userId: "u1", query: "why did the deploy fail", k: 3 };
    const server = await recall(deps(), input, { fusion: "server", trackAccess: false });
    const app = await recall(deps(), input, { fusion: "app", trackAccess: false });
    expect(server[0]?.memory._id.toHexString()).toBe(app[0]?.memory._id.toHexString());
    expect(server[0]?.signals.vectorRank).not.toBeNull();
  });

  it("records access on returned memories only", async () => {
    const results = await recall(deps(), {
      namespace: "bot-a",
      userId: "u1",
      query: "corgi",
      k: 1,
      mode: "text",
    });
    const id = results[0]!.memory._id;
    const updated = await memories.findOne({ _id: id });
    expect(updated?.accessCount).toBe(1);
    expect(updated?.lastAccessedAt).toEqual(NOW);
    const untouched = await memories.countDocuments({ _id: { $ne: id }, accessCount: { $gt: 0 } });
    expect(untouched).toBe(0);
  });
});

async function canUseSearch(uri: string): Promise<boolean> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const probe = client.db("engram_probe").collection("probe");
    await probe.insertOne({});
    await probe.listSearchIndexes().toArray();
    await client.db("engram_probe").dropDatabase();
    return true;
  } catch {
    return false;
  } finally {
    await client.close();
  }
}

/** mongot syncs from the oplog, so new documents take a moment to become searchable. */
async function waitUntilSearchable(
  memories: Collection<MemoryDoc>,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [meta] = await memories
      .aggregate<{ count: { total: number } }>([
        {
          $searchMeta: {
            index: TEXT_INDEX_NAME,
            exists: { path: "content" },
            count: { type: "total" },
          },
        },
      ])
      .toArray();
    const textCount = meta?.count.total ?? 0;
    // The vector index syncs separately, so check it too.
    const [vec] = await memories
      .aggregate<{ n: number }>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX_NAME,
            path: "embedding",
            queryVector: (await embedder.embed(["probe"], "query"))[0]!,
            limit: 100,
            numCandidates: 100,
          },
        },
        { $count: "n" },
      ])
      .toArray();
    const vectorCount = vec?.n ?? 0;
    if (textCount >= expected && vectorCount >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Searchable so far: text ${textCount}/${expected}, vector ${vectorCount}/${expected}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
