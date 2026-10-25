import { describe, expect, it } from "vitest";
import { minMaxNormalize, rankCandidates, recencyScore } from "../../src/read/ranking.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-25T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);

describe("recencyScore", () => {
  it("is 1 now and halves every half-life", () => {
    expect(recencyScore(now, now)).toBe(1);
    expect(recencyScore(daysAgo(30), now, 30)).toBeCloseTo(0.5);
    expect(recencyScore(daysAgo(60), now, 30)).toBeCloseTo(0.25);
  });

  it("treats future timestamps as now", () => {
    expect(recencyScore(new Date(now.getTime() + DAY), now)).toBe(1);
  });

  it("rejects a non-positive half-life", () => {
    expect(() => recencyScore(now, now, 0)).toThrow();
  });
});

describe("minMaxNormalize", () => {
  it("scales to 0..1", () => {
    expect(minMaxNormalize([2, 4, 6])).toEqual([0, 0.5, 1]);
  });
  it("gives equal values 1", () => {
    expect(minMaxNormalize([3, 3])).toEqual([1, 1]);
    expect(minMaxNormalize([])).toEqual([]);
  });
});

describe("rankCandidates", () => {
  it("lets importance and recency reorder close matches", () => {
    const ranked = rankCandidates(
      [
        { item: "stale", rawRelevance: 1.0, importance: 0.1, lastUsed: daysAgo(365) },
        { item: "fresh", rawRelevance: 0.95, importance: 0.9, lastUsed: daysAgo(1) },
        { item: "weak", rawRelevance: 0.0, importance: 1, lastUsed: now },
      ],
      { now },
    );
    expect(ranked.map((r) => r.item)).toEqual(["fresh", "stale", "weak"]);
  });

  it("follows relevance alone when the other weights are 0", () => {
    const ranked = rankCandidates(
      [
        { item: "b", rawRelevance: 0.2, importance: 1, lastUsed: now },
        { item: "a", rawRelevance: 0.9, importance: 0, lastUsed: daysAgo(500) },
      ],
      { now, weights: { importance: 0, recency: 0 } },
    );
    expect(ranked.map((r) => r.item)).toEqual(["a", "b"]);
    expect(ranked[0]?.score).toBe(0.6);
  });

  it("clamps bad importance values", () => {
    const [r] = rankCandidates([{ item: "x", rawRelevance: 1, importance: 7, lastUsed: now }], {
      now,
    });
    expect(r?.importance).toBe(1);
    const [s] = rankCandidates([{ item: "x", rawRelevance: 1, importance: NaN, lastUsed: now }], {
      now,
    });
    expect(s?.importance).toBe(0);
  });
});
