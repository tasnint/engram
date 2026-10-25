/**
 * B1: search index definitions and setup.
 *
 * Two indexes live in mongot (not in mongod's normal B-tree indexes):
 * - a vector index on `embedding`, for meaning search ($vectorSearch)
 * - a full-text index on `content`, for keyword search ($search)
 *
 * Every field recall filters on is declared in both, so filtering happens
 * inside the index before results are ranked (pre-filtering), not after.
 */
import type { Collection, Db, SearchIndexDescription } from "mongodb";
import { MEMORIES_COLLECTION, TEXT_INDEX_NAME, VECTOR_INDEX_NAME } from "../config.js";
import type { MemoryDoc } from "../types.js";

/** Fields recall filters on. Must match the filters built in pipelines.ts. */
export const FILTER_FIELDS = ["namespace", "userId", "status", "type", "createdAt"] as const;

export function vectorIndexDefinition(dimensions: number): SearchIndexDescription {
  return {
    name: VECTOR_INDEX_NAME,
    type: "vectorSearch",
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
        ...FILTER_FIELDS.map((path) => ({ type: "filter", path })),
      ],
    },
  };
}

export function textIndexDefinition(): SearchIndexDescription {
  return {
    name: TEXT_INDEX_NAME,
    type: "search",
    definition: {
      mappings: {
        // Only index what we query. Dynamic mapping would also index the
        // 1000-number embedding arrays, which wastes space.
        dynamic: false,
        fields: {
          // lucene.english stems words, so "deploys" matches "deployment".
          content: { type: "string", analyzer: "lucene.english" },
          tags: { type: "token" },
          namespace: { type: "token" },
          userId: { type: "token" },
          status: { type: "token" },
          type: { type: "token" },
          createdAt: { type: "date" },
        },
      },
    },
  };
}

interface ListedSearchIndex {
  name: string;
  type?: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: { fields?: Array<{ type: string; numDimensions?: number }> };
}

export type IndexAction = "created" | "updated" | "unchanged";

export interface EnsureIndexesResult {
  vector: IndexAction;
  text: IndexAction;
}

/**
 * Creates the collection and both search indexes if they're missing. If the
 * vector index exists with a different vector length (you switched embedding
 * models), it's rebuilt for the new length. Safe to run repeatedly.
 */
export async function ensureSearchIndexes(
  db: Db,
  options: { dimensions: number },
): Promise<EnsureIndexesResult> {
  const memories = await ensureCollection(db);
  const existing = (await memories.listSearchIndexes().toArray()) as ListedSearchIndex[];
  const byName = new Map(existing.map((i) => [i.name, i]));

  const vectorDef = vectorIndexDefinition(options.dimensions);
  const textDef = textIndexDefinition();
  const result: EnsureIndexesResult = { vector: "unchanged", text: "unchanged" };

  const currentVector = byName.get(VECTOR_INDEX_NAME);
  if (!currentVector) {
    await memories.createSearchIndex(vectorDef);
    result.vector = "created";
  } else if (vectorDimensions(currentVector) !== options.dimensions) {
    await memories.updateSearchIndex(VECTOR_INDEX_NAME, vectorDef.definition);
    result.vector = "updated";
  }

  if (!byName.has(TEXT_INDEX_NAME)) {
    await memories.createSearchIndex(textDef);
    result.text = "created";
  }
  return result;
}

/**
 * Waits until both indexes can serve queries. A new index takes a few seconds
 * to build after creation.
 */
export async function waitForSearchIndexes(
  memories: Collection<MemoryDoc>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 60_000, pollMs = 500 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const indexes = (await memories.listSearchIndexes().toArray()) as ListedSearchIndex[];
    const ready = [VECTOR_INDEX_NAME, TEXT_INDEX_NAME].every(
      (name) => indexes.find((i) => i.name === name)?.queryable === true,
    );
    if (ready) return;
    if (Date.now() > deadline) {
      const states = indexes.map((i) => `${i.name}=${i.status}`).join(", ") || "none found";
      throw new Error(`Search indexes not ready after ${timeoutMs}ms (${states})`);
    }
    await sleep(pollMs);
  }
}

async function ensureCollection(db: Db): Promise<Collection<MemoryDoc>> {
  const found = await db
    .listCollections({ name: MEMORIES_COLLECTION }, { nameOnly: true })
    .toArray();
  if (found.length === 0) {
    await db.createCollection(MEMORIES_COLLECTION);
  }
  return db.collection<MemoryDoc>(MEMORIES_COLLECTION);
}

function vectorDimensions(index: ListedSearchIndex): number | undefined {
  return index.latestDefinition?.fields?.find((f) => f.type === "vector")?.numDimensions;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
