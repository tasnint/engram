/**
 * B3: reciprocal rank fusion (RRF).
 *
 * Keyword scores and vector scores are on different scales, so they can't be
 * added directly. RRF ignores the raw scores and uses each item's position:
 *
 *   score(item) = sum over lists of  weight / (k + rank)
 *
 * An item ranked 1st in both lists beats one ranked 1st in only one. k (60 by
 * convention, from Cormack et al. 2009) controls how much the top few
 * positions dominate: a smaller k rewards being near the top more strongly.
 */

export interface RankedList<T> {
  name: string;
  /** Best match first. */
  items: T[];
  weight?: number;
}

export interface FusedItem<T> {
  item: T;
  score: number;
  /** 1-based rank in each input list, or null where the item wasn't present. */
  ranks: Record<string, number | null>;
}

export const DEFAULT_RRF_K = 60;

export function reciprocalRankFusion<T>(
  lists: RankedList<T>[],
  getId: (item: T) => string,
  k: number = DEFAULT_RRF_K,
): FusedItem<T>[] {
  if (!(k >= 0)) throw new Error(`RRF k must be 0 or more, got ${k}`);

  const names = lists.map((l) => l.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`List names must be unique, got ${names.join(", ")}`);
  }

  const fused = new Map<string, FusedItem<T>>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.items.forEach((item, index) => {
      const id = getId(item);
      let entry = fused.get(id);
      if (!entry) {
        entry = { item, score: 0, ranks: Object.fromEntries(names.map((n) => [n, null])) };
        fused.set(id, entry);
      }
      // If a list contains the same item twice, keep its best (first) rank.
      if (entry.ranks[list.name] !== null) return;
      const rank = index + 1;
      entry.ranks[list.name] = rank;
      entry.score += weight / (k + rank);
    });
  }

  return [...fused.values()].sort(
    (a, b) => b.score - a.score || bestRank(a.ranks) - bestRank(b.ranks),
  );
}

function bestRank(ranks: Record<string, number | null>): number {
  let best = Infinity;
  for (const r of Object.values(ranks)) if (r !== null && r < best) best = r;
  return best;
}

/**
 * Relative score fusion: the same idea as MongoDB's $scoreFusion with min-max
 * normalization. Each list's raw scores are scaled to 0..1 within that list
 * (see `floor`),
 * then combined as a weighted average (an item missing from a list scores 0
 * there).
 *
 * Unlike RRF, this keeps how much better one match is than the next: if the
 * best vector match scores 0.67 and the rest 0.56, it stays clearly ahead
 * instead of being one rank step above.
 */
export interface ScoredList<T> extends RankedList<T> {
  /** Raw score of an item in this list. Higher is better; any scale. */
  score: (item: T) => number;
  /**
   * What counts as a score of 0 after scaling:
   * - "min":  the lowest score in the list (default). Right for vector search,
   *           which always returns neighbors, so its lowest score is noise.
   * - "zero": a raw score of 0. Right for keyword search, where every hit
   *           matched the query words, so even the last hit deserves credit.
   */
  floor?: "min" | "zero";
}

export function relativeScoreFusion<T>(
  lists: ScoredList<T>[],
  getId: (item: T) => string,
): FusedItem<T>[] {
  const names = lists.map((l) => l.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`List names must be unique, got ${names.join(", ")}`);
  }
  const totalWeight = lists.reduce((sum, l) => sum + (l.weight ?? 1), 0);
  const fused = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    const scores = list.items.map(list.score);
    const min = list.floor === "zero" ? 0 : Math.min(...scores);
    const max = Math.max(...scores);
    const weight = (list.weight ?? 1) / (totalWeight || 1);
    list.items.forEach((item, index) => {
      const id = getId(item);
      let entry = fused.get(id);
      if (!entry) {
        entry = { item, score: 0, ranks: Object.fromEntries(names.map((n) => [n, null])) };
        fused.set(id, entry);
      }
      if (entry.ranks[list.name] !== null) return;
      entry.ranks[list.name] = index + 1;
      // A list with one hit, or all-equal scores, gives each hit full credit.
      const normalized = max === min ? 1 : (scores[index]! - min) / (max - min);
      entry.score += weight * normalized;
    });
  }

  return [...fused.values()].sort(
    (a, b) => b.score - a.score || bestRank(a.ranks) - bestRank(b.ranks),
  );
}
