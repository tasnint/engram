/**
 * Engram in one object: Track A's write path (MemoryService) and Track B's
 * read path (recall), sharing one database and one embedding model. The REST
 * API, MCP server and demo agent all build on this.
 */
import type { Db } from "mongodb";
import { z } from "zod";
import { MEMORIES_COLLECTION, VECTOR_INDEX_NAME } from "./config.js";
import type { StoredMemory } from "./database.js";
import { recall, type RecallOptions } from "./read/recall.js";
import type {
  EmbeddingProvider,
  EngramApi,
  ListMemoriesInput,
  MemoryDoc,
  MemoryPage,
} from "./types.js";
import { VectorDuplicateDetector, type DuplicateDetector } from "./write/dedup.js";
import { MemoryService } from "./write/service.js";

export interface EngramDeps {
  db: Db;
  embeddings: EmbeddingProvider;
  /** Near-duplicate detection (A3). Omit for exact-match dedup only. */
  duplicates?: DuplicateDetector;
  recallOptions?: RecallOptions;
  now?: () => Date;
}

export interface Engram extends EngramApi {
  list(input: ListMemoriesInput): Promise<MemoryPage>;
  /** The underlying write service, for scoped deletes and other Track A specifics. */
  service: MemoryService;
}

export function createEngram(deps: EngramDeps): Engram {
  const service = new MemoryService(deps.db, {
    embeddings: deps.embeddings,
    duplicates: deps.duplicates,
    now: deps.now,
  });
  // Same collection, viewed as the shared document shape (recall doesn't touch storage-only fields).
  const memories = deps.db.collection<MemoryDoc>(MEMORIES_COLLECTION);
  const readDeps = { memories, embedder: deps.embeddings, now: deps.now };
  return {
    service,
    remember: (input) => service.remember(input),
    recall: (input) => recall(readDeps, input, deps.recallOptions),
    forget: (input) => service.forget(input),
    list: (input) => service.list(input),
  };
}

/** Builds the duplicate detector DEDUP_MODE asks for (exact needs none). */
export function duplicatesFromEnvironment(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): DuplicateDetector | undefined {
  const mode = z
    .enum(["exact", "vector"])
    .default("exact")
    .parse(env.DEDUP_MODE || undefined);
  if (mode === "exact") return undefined;
  return new VectorDuplicateDetector(db.collection<StoredMemory>(MEMORIES_COLLECTION), {
    index: VECTOR_INDEX_NAME,
    threshold: env.DEDUP_THRESHOLD
      ? z.coerce.number().min(0).max(1).parse(env.DEDUP_THRESHOLD)
      : undefined,
  });
}
