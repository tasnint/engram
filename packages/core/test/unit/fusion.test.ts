import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../../src/read/fusion.js";

const id = (s: string) => s;

describe("reciprocalRankFusion", () => {
  it("ranks items found by both searches above items found by one", () => {
    const fused = reciprocalRankFusion(
      [
        { name: "vector", items: ["a", "b", "c"] },
        { name: "text", items: ["c", "d", "a"] },
      ],
      id,
    );
    // a: 1/61 + 1/63, c: 1/63 + 1/61 (tie, broken by best rank: both 1) ... check exact order of the tie group.
    expect(
      fused
        .map((f) => f.item)
        .slice(0, 2)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(fused.map((f) => f.item).slice(2)).toEqual(["b", "d"]);
  });

  it("computes sum of weight / (k + rank)", () => {
    const [top] = reciprocalRankFusion(
      [
        { name: "vector", items: ["a"], weight: 2 },
        { name: "text", items: ["x", "a"] },
      ],
      id,
      10,
    );
    expect(top?.item).toBe("a");
    expect(top?.score).toBeCloseTo(2 / 11 + 1 / 12, 10);
    expect(top?.ranks).toEqual({ vector: 1, text: 2 });
  });

  it("records null rank for lists that missed the item", () => {
    const fused = reciprocalRankFusion(
      [
        { name: "vector", items: ["a"] },
        { name: "text", items: ["b"] },
      ],
      id,
    );
    expect(fused.find((f) => f.item === "b")?.ranks).toEqual({ vector: null, text: 1 });
  });

  it("uses the first rank when a list repeats an item", () => {
    const [only] = reciprocalRankFusion([{ name: "vector", items: ["a", "a"] }], id, 0);
    expect(only?.score).toBe(1);
  });

  it("breaks score ties by best single rank", () => {
    // b is 1st in text; a is 2nd in both. With k=0: a = 1/2 + 1/2 = 1, b = 1/1 = 1.
    const fused = reciprocalRankFusion(
      [
        { name: "vector", items: ["c", "a"] },
        { name: "text", items: ["b", "a"] },
      ],
      id,
      0,
    );
    const a = fused.find((f) => f.item === "a")!;
    const b = fused.find((f) => f.item === "b")!;
    expect(a.score).toBe(b.score);
    expect(fused.indexOf(b)).toBeLessThan(fused.indexOf(a));
  });

  it("handles empty input", () => {
    expect(reciprocalRankFusion([], id)).toEqual([]);
    expect(reciprocalRankFusion([{ name: "vector", items: [] }], id)).toEqual([]);
  });

  it("rejects duplicate list names and negative k", () => {
    expect(() =>
      reciprocalRankFusion(
        [
          { name: "x", items: [] },
          { name: "x", items: [] },
        ],
        id,
      ),
    ).toThrow();
    expect(() => reciprocalRankFusion([], id, -1)).toThrow();
  });
});
