/**
 * recall(): find the memories that matter for a query.
 *
 *   1. Search: run meaning search and keyword search in parallel (or one of them).
 *   2. Fuse:   merge the two lists (B3), by relative score (default) or by rank (RRF).
 *   3. Rank:   re-score with relevance, importance and recency (B4).
 *   4. Track:  bump accessCount / lastAccessedAt on what was returned (B4).
 */
import type { Collection, Document, ObjectId } from "mongodb";
import type {
  Embedder,
  Memory,
  MemoryDoc,
  MemoryType,
  RecallInput,
  RecallMode,
  RecallResult,
} from "../types.js";
import { MEMORY_TYPES } from "../types.js";
import { HIDDEN_FIELDS } from "../config.js";
import { EngramError } from "../errors.js";
import {
  DEFAULT_RRF_K,
  reciprocalRankFusion,
  relativeScoreFusion,
  type ScoredList,
} from "./fusion.js";
import {
  buildRankFusionPipeline,
  buildTextPipeline,
  buildVectorPipeline,
  FUSION_DETAILS_FIELD,
  TEXT_SCORE_FIELD,
  VECTOR_SCORE_FIELD,
  type SearchScope,
} from "./pipelines.js";
import { DEFAULT_HALF_LIFE_DAYS, rankCandidates, type RankingWeights } from "./ranking.js";

export const DEFAULT_K = 5;
export const MAX_K = 50;

export interface RecallDeps {
  memories: Collection<MemoryDoc>;
  embedder: Embedder;
  /** Injectable clock, for tests. */
  now?: () => Date;
}

export interface RecallOptions {
  /**
   * Where the two result lists are merged:
   * - "app":    in this process with fusion.ts (default; works on any server version)
   * - "server": inside MongoDB with $rankFusion (MongoDB 8.0+)
   */
  fusion?: "app" | "server";
  /**
   * How the app merges keyword and meaning results (fusion: "app" only):
   * - "score": relative score fusion, keeps score gaps (default)
   * - "rank":  reciprocal rank fusion, uses positions only
   * See bench/recall.ts for how they compare.
   */
  fusionMethod?: "score" | "rank";
  /** Each search fetches k × this many candidates for ranking to choose from. Default 4. */
  candidateMultiplier?: number;
  rrfK?: number;
  /** How much each search counts in fusion. Default 1 each. */
  listWeights?: { vector: number; text: number };
  weights?: Partial<RankingWeights>;
  halfLifeDays?: number;
  /** Record that returned memories were used. Default true. */
  trackAccess?: boolean;
}

/** A search hit before final ranking. */
interface Candidate {
  doc: Memory & Document;
  fusedScore: number;
  vectorRank: number | null;
  textRank: number | null;
}

export async function recall(
  deps: RecallDeps,
  input: RecallInput,
  options: RecallOptions = {},
): Promise<RecallResult[]> {
  const { k, mode, query, scope } = validate(input);
  const now = deps.now?.() ?? new Date();
  const fetchLimit = k * (options.candidateMultiplier ?? 4);

  const candidates =
    mode === "hybrid" && options.fusion === "server"
      ? await searchWithServerFusion(deps, scope, query, fetchLimit, options)
      : await searchWithAppFusion(deps, scope, query, mode, fetchLimit, options);

  // MongoDB's TTL monitor deletes expired memories about once a minute, so
  // skip any that have expired but haven't been removed yet.
  const live = candidates.filter((c) => !c.doc.expiresAt || c.doc.expiresAt > now);

  const ranked = rankCandidates(
    live.map((c) => ({
      item: c,
      rawRelevance: c.fusedScore,
      importance: c.doc.importance,
      lastUsed: c.doc.lastAccessedAt ?? c.doc.createdAt,
    })),
    { now, weights: options.weights, halfLifeDays: options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS },
  ).slice(0, k);

  if (options.trackAccess !== false && ranked.length > 0) {
    await recordAccess(
      deps.memories,
      ranked.map((r) => r.item.doc._id),
      now,
    );
  }

  return ranked.map((r) => ({
    memory: toMemory(r.item.doc),
    score: r.score,
    signals: {
      relevance: r.relevance,
      importance: r.importance,
      recency: r.recency,
      vectorRank: r.item.vectorRank,
      textRank: r.item.textRank,
    },
  }));
}

/**
 * One update for all returned memories, instead of one write per memory.
 * Runs after ranking, so it never changes the results of the call that triggered it.
 */
export async function recordAccess(
  memories: Collection<MemoryDoc>,
  ids: ObjectId[],
  now: Date,
): Promise<void> {
  await memories.updateMany(
    { _id: { $in: ids } },
    { $inc: { accessCount: 1 }, $set: { lastAccessedAt: now } },
  );
}

async function searchWithAppFusion(
  deps: RecallDeps,
  scope: SearchScope,
  query: string,
  mode: RecallMode,
  limit: number,
  options: RecallOptions,
): Promise<Candidate[]> {
  const runVector = mode !== "text";
  const runText = mode !== "vector";

  const [vectorHits, textHits] = await Promise.all([
    runVector
      ? embedQuery(deps.embedder, query).then((vector) =>
          deps.memories
            .aggregate<Memory & Document>(buildVectorPipeline(scope, vector, { limit }))
            .toArray(),
        )
      : Promise.resolve([]),
    runText
      ? deps.memories.aggregate<Memory & Document>(buildTextPipeline(scope, query, limit)).toArray()
      : Promise.resolve([]),
  ]);

  const lists: ScoredList<Memory & Document>[] = [];
  if (runVector) {
    lists.push({
      name: "vector",
      items: vectorHits,
      weight: options.listWeights?.vector,
      score: (m) => Number(m[VECTOR_SCORE_FIELD] ?? 0),
    });
  }
  if (runText) {
    lists.push({
      name: "text",
      items: textHits,
      weight: options.listWeights?.text,
      score: (m) => Number(m[TEXT_SCORE_FIELD] ?? 0),
      floor: "zero",
    });
  }

  const id = (m: Memory) => m._id.toHexString();
  const fused =
    options.fusionMethod === "rank"
      ? reciprocalRankFusion(lists, id, options.rrfK ?? DEFAULT_RRF_K)
      : relativeScoreFusion(lists, id);
  return fused.map((f) => ({
    doc: f.item,
    fusedScore: f.score,
    vectorRank: f.ranks.vector ?? null,
    textRank: f.ranks.text ?? null,
  }));
}

async function searchWithServerFusion(
  deps: RecallDeps,
  scope: SearchScope,
  query: string,
  limit: number,
  options: RecallOptions,
): Promise<Candidate[]> {
  const vector = await embedQuery(deps.embedder, query);
  const docs = await deps.memories
    .aggregate<Memory & Document>(
      buildRankFusionPipeline(scope, query, vector, { limit, weights: options.listWeights }),
    )
    .toArray();

  return docs.map((doc) => {
    const details = doc[FUSION_DETAILS_FIELD] as FusionDetails | undefined;
    return {
      doc,
      fusedScore: details?.value ?? 0,
      vectorRank: pipelineRank(details, "vector"),
      textRank: pipelineRank(details, "text"),
    };
  });
}

/** Shape of $meta: "scoreDetails" for $rankFusion. */
interface FusionDetails {
  value: number;
  details?: Array<{ inputPipelineName: string; rank?: number }>;
}

function pipelineRank(details: FusionDetails | undefined, name: string): number | null {
  const rank = details?.details?.find((d) => d.inputPipelineName === name)?.rank;
  // $rankFusion reports rank 0 for documents a pipeline didn't return.
  return typeof rank === "number" && rank > 0 ? rank : null;
}

async function embedQuery(embedder: Embedder, query: string): Promise<number[]> {
  const [vector] = await embedder.embed([query], "query");
  if (!vector) throw new Error("Embedder returned no vector for the query");
  return vector;
}

const INTERNAL_FIELDS = [
  VECTOR_SCORE_FIELD,
  TEXT_SCORE_FIELD,
  FUSION_DETAILS_FIELD,
  ...Object.keys(HIDDEN_FIELDS),
];

function toMemory(doc: Memory & Document): Memory {
  const copy: Document = { ...doc };
  for (const field of INTERNAL_FIELDS) delete copy[field];
  return copy as Memory;
}

/** Bad recall input. The REST API turns it into HTTP 400. */
export class RecallInputError extends EngramError {
  constructor(message: string) {
    super("INVALID_RECALL", message, 400);
    this.name = "RecallInputError";
  }
}

function validate(input: RecallInput): {
  k: number;
  mode: RecallMode;
  query: string;
  scope: SearchScope;
} {
  const query = input.query?.trim();
  if (!query) throw new RecallInputError("query must not be empty");
  if (!input.namespace) throw new RecallInputError("namespace is required");
  if (!input.userId) throw new RecallInputError("userId is required");

  const k = input.k ?? DEFAULT_K;
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
    throw new RecallInputError(`k must be a whole number from 1 to ${MAX_K}, got ${input.k}`);
  }

  const mode = input.mode ?? "hybrid";
  if (!["hybrid", "vector", "text"].includes(mode)) {
    throw new RecallInputError(`mode must be hybrid, vector or text, got ${mode}`);
  }

  const badType = input.types?.find((t) => !MEMORY_TYPES.includes(t as MemoryType));
  if (badType) {
    throw new RecallInputError(`Unknown memory type "${badType}". Use ${MEMORY_TYPES.join(", ")}`);
  }

  if (input.since && Number.isNaN(input.since.getTime())) {
    throw new RecallInputError("since is not a valid date");
  }

  return {
    k,
    mode,
    query,
    scope: {
      namespace: input.namespace,
      userId: input.userId,
      types: input.types,
      since: input.since,
    },
  };
}
