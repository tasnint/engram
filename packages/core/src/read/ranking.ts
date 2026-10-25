/**
 * B4: final ranking.
 *
 * Search finds memories that match the query. Ranking then decides which of
 * those matter most right now, combining three signals, each scaled to 0..1
 * (the approach from the Generative Agents paper, Park et al. 2023):
 *
 *   score = w_relevance * relevance + w_importance * importance + w_recency * recency
 *
 * - relevance:  the search score, min-max scaled across this query's candidates
 * - importance: stored on the memory (0..1)
 * - recency:    exponential decay since the memory was last used
 */

export interface RankingWeights {
  relevance: number;
  importance: number;
  recency: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = { relevance: 0.6, importance: 0.2, recency: 0.2 };

/** After this many days unused, a memory's recency score halves. */
export const DEFAULT_HALF_LIFE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function recencyScore(
  lastUsed: Date,
  now: Date,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (!(halfLifeDays > 0)) throw new Error(`halfLifeDays must be positive, got ${halfLifeDays}`);
  // Clock skew can put lastUsed slightly in the future. Treat that as "just now".
  const ageDays = Math.max(0, now.getTime() - lastUsed.getTime()) / DAY_MS;
  return 0.5 ** (ageDays / halfLifeDays);
}

/** Scales values to 0..1. If they're all equal, they all get 1. */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

export interface RankInput<T> {
  item: T;
  /** Raw search score. Any scale; only the order and spacing between candidates matter. */
  rawRelevance: number;
  importance: number;
  lastUsed: Date;
}

export interface Ranked<T> {
  item: T;
  score: number;
  relevance: number;
  importance: number;
  recency: number;
}

export function rankCandidates<T>(
  candidates: RankInput<T>[],
  options: { now: Date; weights?: Partial<RankingWeights>; halfLifeDays?: number },
): Ranked<T>[] {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const relevance = minMaxNormalize(candidates.map((c) => c.rawRelevance));

  return candidates
    .map((c, i) => {
      const rel = relevance[i] ?? 0;
      const importance = clamp01(c.importance);
      const recency = recencyScore(c.lastUsed, options.now, options.halfLifeDays);
      return {
        item: c.item,
        relevance: rel,
        importance,
        recency,
        score:
          weights.relevance * rel + weights.importance * importance + weights.recency * recency,
      };
    })
    .sort((a, b) => b.score - a.score || b.relevance - a.relevance);
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
