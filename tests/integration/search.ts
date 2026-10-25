/** Helpers for integration tests that need mongot. */
import { MongoClient, type Collection } from "mongodb";
import {
  TEXT_INDEX_NAME,
  VECTOR_INDEX_NAME,
  type EmbeddingProvider,
  type MemoryDoc,
} from "@engram/core";

/** True if the database at `uri` has search (mongot). Logs why tests will skip if not. */
export async function canUseSearch(uri: string): Promise<boolean> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const probe = client.db("engram_probe").collection("probe");
    await probe.insertOne({});
    await probe.listSearchIndexes().toArray();
    await client.db("engram_probe").dropDatabase();
    return true;
  } catch (error) {
    // CI sets this so missing search fails the build instead of silently skipping.
    if (process.env.ENGRAM_REQUIRE_SEARCH) {
      throw new Error("ENGRAM_REQUIRE_SEARCH is set but search isn't available", { cause: error });
    }
    console.warn(
      "Skipping search tests: this database has no mongot. Run them with " +
        "MONGODB_TEST_URI=mongodb://localhost:27017/?directConnection=true after `pnpm db:up`.",
    );
    return false;
  } finally {
    await client.close();
  }
}

/** mongot syncs from the oplog, so new documents take a moment to become searchable. */
export async function waitUntilSearchable(
  memories: Collection<MemoryDoc>,
  embedder: EmbeddingProvider,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  const [probe] = await embedder.embed(["probe"], "query");
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
            queryVector: probe!,
            limit: 1000,
            numCandidates: 1000,
          },
        },
        { $count: "n" },
      ])
      .toArray();
    const vectorCount = vec?.n ?? 0;
    if (textCount === expected && vectorCount === expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Searchable so far: text ${textCount}/${expected}, vector ${vectorCount}/${expected}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
