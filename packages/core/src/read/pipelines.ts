/**
 * B2/B3: aggregation pipelines for meaning search, keyword search, and
 * MongoDB's built-in hybrid search ($rankFusion). Pure functions, so they're
 * unit tested without a database.
 */
import type { Document } from "mongodb";
import { HIDDEN_FIELDS, TEXT_INDEX_NAME, VECTOR_INDEX_NAME } from "../config.js";
import type { MemoryType } from "../types.js";

export interface SearchScope {
  namespace: string;
  userId: string;
  types?: MemoryType[];
  since?: Date;
}

export interface VectorSearchOptions {
  limit: number;
  /**
   * How many nearest neighbors the approximate search looks at before
   * returning `limit`. Higher is more accurate and slower. MongoDB suggests
   * 10 to 20 times the limit.
   */
  numCandidates?: number;
}

/** Score fields added to each result, read by recall.ts. */
export const VECTOR_SCORE_FIELD = "_vectorScore";
export const TEXT_SCORE_FIELD = "_textScore";
export const FUSION_DETAILS_FIELD = "_fusionDetails";

/** Pre-filter for $vectorSearch. Only active memories for this user are searched. */
export function vectorFilter(scope: SearchScope): Document {
  const clauses: Document[] = [
    { namespace: { $eq: scope.namespace } },
    { userId: { $eq: scope.userId } },
    { status: { $eq: "active" } },
  ];
  if (scope.types?.length) clauses.push({ type: { $in: scope.types } });
  if (scope.since) clauses.push({ createdAt: { $gte: scope.since } });
  return { $and: clauses };
}

export function vectorSearchStage(
  scope: SearchScope,
  queryVector: number[],
  options: VectorSearchOptions,
): Document {
  return {
    $vectorSearch: {
      index: VECTOR_INDEX_NAME,
      path: "embedding",
      queryVector,
      limit: options.limit,
      numCandidates: options.numCandidates ?? Math.max(100, options.limit * 15),
      filter: vectorFilter(scope),
    },
  };
}

/** The same scope as vectorFilter, written in $search's operator language. */
export function textFilterClauses(scope: SearchScope): Document[] {
  const clauses: Document[] = [
    { equals: { path: "namespace", value: scope.namespace } },
    { equals: { path: "userId", value: scope.userId } },
    { equals: { path: "status", value: "active" } },
  ];
  if (scope.types?.length) clauses.push({ in: { path: "type", value: scope.types } });
  if (scope.since) clauses.push({ range: { path: "createdAt", gte: scope.since } });
  return clauses;
}

export function textSearchStage(scope: SearchScope, query: string): Document {
  return {
    $search: {
      index: TEXT_INDEX_NAME,
      compound: {
        must: [{ text: { query, path: "content" } }],
        // filter clauses narrow results without changing the score.
        filter: textFilterClauses(scope),
      },
    },
  };
}

/** Never return embeddings or storage-only fields. */
const HIDE_INTERNAL = { $project: HIDDEN_FIELDS };

export function buildVectorPipeline(
  scope: SearchScope,
  queryVector: number[],
  options: VectorSearchOptions,
): Document[] {
  return [
    vectorSearchStage(scope, queryVector, options),
    { $addFields: { [VECTOR_SCORE_FIELD]: { $meta: "vectorSearchScore" } } },
    HIDE_INTERNAL,
  ];
}

export function buildTextPipeline(scope: SearchScope, query: string, limit: number): Document[] {
  return [
    textSearchStage(scope, query),
    { $limit: limit },
    { $addFields: { [TEXT_SCORE_FIELD]: { $meta: "searchScore" } } },
    HIDE_INTERNAL,
  ];
}

export interface RankFusionOptions extends VectorSearchOptions {
  weights?: { vector: number; text: number };
}

/**
 * Hybrid search done by the server with $rankFusion (MongoDB 8.0+). Same
 * algorithm as fusion.ts (reciprocal rank fusion), run inside the database.
 * scoreDetails tells us each memory's rank in each input list.
 */
export function buildRankFusionPipeline(
  scope: SearchScope,
  query: string,
  queryVector: number[],
  options: RankFusionOptions,
): Document[] {
  const weights = options.weights ?? { vector: 1, text: 1 };
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [vectorSearchStage(scope, queryVector, options)],
            text: [textSearchStage(scope, query), { $limit: options.limit }],
          },
        },
        combination: { weights },
        scoreDetails: true,
      },
    },
    { $limit: options.limit },
    { $addFields: { [FUSION_DETAILS_FIELD]: { $meta: "scoreDetails" } } },
    HIDE_INTERNAL,
  ];
}
