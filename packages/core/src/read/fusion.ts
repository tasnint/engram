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
