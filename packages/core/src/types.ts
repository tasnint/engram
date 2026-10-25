/**
 * The shared contract. Both tracks build against these types, so change them
 * only with both Tanisha and Neha approving the PR.
 */
import type { ObjectId } from "mongodb";

// ---------------------------------------------------------------------------
// The memory document
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = ["fact", "preference", "episode", "summary"] as const;

/**
 * - fact:       something true about the user or the world ("works at Acme")
 * - preference: how the user likes things done ("answers in Python")
 * - episode:    something that happened in a session ("deploy failed on Tuesday")
 * - summary:    written only by consolidation (A5), merging older episodes
 */
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryStatus = "active" | "archived";

export interface MemorySource {
  sessionId: string | null;
  messageId: string | null;
}

/** A document in the `memories` collection, as both tracks see it. */
export interface MemoryDoc {
  _id: ObjectId;
  /** Which agent owns the memory, e.g. "support-bot". */
  namespace: string;
  /** Whose memory it is. Every query filters on namespace + userId. */
  userId: string;
  type: MemoryType;
  content: string;
  /** Length must match the vector index (see EmbeddingProvider.dimensions). */
  embedding: number[];
  tags: string[];
  /** 0 to 1. Set on write (A2), lowered over time by decay (A4). */
  importance: number;
  /** Bumped every time recall returns this memory (B4). */
  accessCount: number;
  lastAccessedAt: Date;
  createdAt: Date;
  /** A TTL index deletes the document after this time. null keeps it forever. */
  expiresAt: Date | null;
  /** Archived memories were merged into a summary and are hidden from recall. */
  status: MemoryStatus;
  source: MemorySource;
  /** Set on archived memories: the summary that replaced them. */
  consolidatedInto: ObjectId | null;
}

/** A memory as returned to callers. The embedding is large and internal, so it's left out. */
export type Memory = Omit<MemoryDoc, "embedding">;

// ---------------------------------------------------------------------------
// remember / recall / forget / list
// ---------------------------------------------------------------------------

/** Track A (Neha). */
export interface RememberInput {
  namespace: string;
  userId: string;
  content: string;
  type?: MemoryType;
  tags?: string[];
  importance?: number;
  /** Delete the memory after this many days. Omit to keep it. */
  ttlDays?: number;
  source?: MemorySource;
}

/**
 * - hybrid: keyword search and meaning search, merged (default)
 * - vector: meaning only
 * - text:   keywords only
 */
export type RecallMode = "hybrid" | "vector" | "text";

/** Track B (Tanisha). */
export interface RecallInput {
  namespace: string;
  userId: string;
  query: string;
  /** How many memories to return. Default 5, max 50. */
  k?: number;
  /** Only return these types. */
  types?: MemoryType[];
  /** Only return memories created at or after this time. */
  since?: Date;
  mode?: RecallMode;
}

/** Why a memory was ranked where it was. Each value is 0 to 1 unless noted. */
export interface RecallSignals {
  /** How well it matched the query, relative to the other candidates. */
  relevance: number;
  importance: number;
  /** 1 if used just now, 0.5 after one half-life, and so on. */
  recency: number;
  /** 1-based position in the meaning search, or null if it wasn't found there. */
  vectorRank: number | null;
  /** 1-based position in the keyword search, or null if it wasn't found there. */
  textRank: number | null;
}

export interface RecallResult {
  memory: Memory;
  /** Final ranking score. Higher is better. */
  score: number;
  signals: RecallSignals;
}

/** Track A (Neha). Pass an id to delete one memory, or namespace + userId to delete all of a user's memories. */
export type ForgetInput = { id: string } | { namespace: string; userId: string };

export interface ForgetResult {
  deleted: number;
}

export interface ListMemoriesInput {
  namespace: string;
  userId: string;
  type?: MemoryType;
  status?: MemoryStatus;
  limit?: number;
  /** From the previous page's nextCursor. */
  cursor?: string;
}

export interface MemoryPage {
  memories: Memory[];
  nextCursor: string | null;
}

export type Remember = (input: RememberInput) => Promise<Memory>;
export type Recall = (input: RecallInput) => Promise<RecallResult[]>;
export type Forget = (input: ForgetInput) => Promise<ForgetResult>;

/** What the REST API, SDK and MCP server expose. */
export interface EngramApi {
  remember: Remember;
  recall: Recall;
  forget: Forget;
}

// ---------------------------------------------------------------------------
// Embeddings (P4) and summaries (A5)
// ---------------------------------------------------------------------------

/** Some providers (Voyage AI) embed stored text and search queries differently. */
export type EmbedKind = "document" | "query";

export interface EmbeddingProvider {
  /** e.g. "Xenova/all-MiniLM-L6-v2". A database is bound to one model. */
  readonly model: string;
  /** Vector length. The vector search index is built for exactly this length. */
  readonly dimensions: number;
  embed(texts: string[], kind?: EmbedKind): Promise<number[][]>;
}

/** Older name for EmbeddingProvider. */
export type Embedder = EmbeddingProvider;

export interface Summarizer {
  summarize(episodes: readonly Pick<MemoryDoc, "content" | "createdAt">[]): Promise<string>;
}
