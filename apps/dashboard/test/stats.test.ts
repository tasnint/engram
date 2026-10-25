import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { buildStatsPipeline, statsWindowStart, toStats, STATS_DAYS } from "../server/stats.js";

const now = new Date("2026-10-25T15:00:00Z");

describe("stats", () => {
  it("scopes the match to namespace and optional user", () => {
    expect(buildStatsPipeline({ namespace: "bot" }, now)[0]).toEqual({
      $match: { namespace: "bot" },
    });
    expect(buildStatsPipeline({ namespace: "bot", userId: "u1" }, now)[0]).toEqual({
      $match: { namespace: "bot", userId: "u1" },
    });
  });

  it("starts the window at midnight UTC, 29 days before today", () => {
    expect(statsWindowStart(now).toISOString()).toBe("2026-09-26T00:00:00.000Z");
  });

  it("fills empty days and shapes facets", () => {
    const id = new ObjectId();
    const stats = toStats(
      {
        totals: [{ total: 5, active: 4, avgImportance: 0.55, totalRecalls: 9 }],
        byType: [{ _id: "fact", count: 3 }],
        perDay: [
          { _id: "2026-10-25", count: 2 },
          { _id: "2026-09-26", count: 1 },
        ],
        topTags: [{ _id: "work", count: 2 }],
        mostRecalled: [{ _id: id, content: "x", type: "fact", accessCount: 4 }],
      },
      now,
    );
    expect(stats.perDay).toHaveLength(STATS_DAYS);
    expect(stats.perDay[0]).toEqual({ day: "2026-09-26", count: 1 });
    expect(stats.perDay.at(-1)).toEqual({ day: "2026-10-25", count: 2 });
    expect(stats.perDay.reduce((s, d) => s + d.count, 0)).toBe(3);
    expect(stats.archived).toBe(1);
    expect(stats.mostRecalled[0]?.id).toBe(id.toHexString());
  });

  it("handles an empty collection", () => {
    const stats = toStats(
      { totals: [], byType: [], perDay: [], topTags: [], mostRecalled: [] },
      now,
    );
    expect(stats).toMatchObject({
      total: 0,
      active: 0,
      archived: 0,
      avgImportance: 0,
      totalRecalls: 0,
    });
  });
});
