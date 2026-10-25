import type { Collection } from "mongodb";
import { VECTOR_INDEX_NAME } from "../config.js";
import type { StoredMemory } from "../database.js";
import { EngramError } from "../errors.js";

export interface DuplicateQuery {
  namespace: string;
  userId: string;
  type: StoredMemory["type"];
  embedding: number[];
  now: Date;
}

export interface DuplicateDetector {
  find(query: DuplicateQuery): Promise<StoredMemory | null>;
}

export class VectorDuplicateDetector implements DuplicateDetector {
  constructor(
    private readonly collection: Collection<StoredMemory>,
    private readonly options: { index?: string; threshold?: number } = {},
  ) {
    const threshold = options.threshold ?? 0.92;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      throw new Error("Invalid duplicate threshold.");
  }

  async find(query: DuplicateQuery): Promise<StoredMemory | null> {
    try {
      const hits = await this.collection
        .aggregate<StoredMemory>([
          {
            $vectorSearch: {
              index: this.options.index ?? VECTOR_INDEX_NAME,
              path: "embedding",
              queryVector: query.embedding,
              numCandidates: 200,
              limit: 10,
              filter: {
                namespace: query.namespace,
                userId: query.userId,
                status: "active",
                type: query.type,
              },
            },
          },
          { $set: { similarity: { $meta: "vectorSearchScore" } } },
          {
            $match: {
              similarity: { $gte: this.options.threshold ?? 0.92 },
              $or: [{ expiresAt: null }, { expiresAt: { $gt: query.now } }],
            },
          },
          { $limit: 1 },
          { $unset: "similarity" },
        ])
        .toArray();
      return hits[0] ?? null;
    } catch {
      throw new EngramError(
        "VECTOR_SEARCH_UNAVAILABLE",
        "Duplicate search failed. Check mongot and the Track B vector index, or explicitly configure exact-only deduplication.",
        503,
      );
    }
  }
}
