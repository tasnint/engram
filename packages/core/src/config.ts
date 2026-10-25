export const DEFAULT_MONGODB_URI = "mongodb://localhost:27017/?directConnection=true";
export const DEFAULT_DB_NAME = "engram";

export const MEMORIES_COLLECTION = "memories";

/** Search index names. Created by `pnpm db:init` (B1). */
export const VECTOR_INDEX_NAME = "memories_vector";
export const TEXT_INDEX_NAME = "memories_text";

/**
 * Fields only the storage layer uses (A2 dedup hash, A4 decay clock) plus the
 * embedding. Every read that returns memories to callers projects these out.
 */
export const HIDDEN_FIELDS = { embedding: 0, contentHash: 0, decayAt: 0 } as const;
