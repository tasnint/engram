/**
 * Dashboard numbers, computed in one round trip with $facet: each facet is a
 * separate sub-pipeline over the same matched documents.
 */
import type { Document } from "mongodb";

export interface StatsScope {
  namespace: string;
  userId?: string;
}

export interface Stats {
  total: number;
  active: number;
  archived: number;
  avgImportance: number;
  totalRecalls: number;
  byType: Array<{ type: string; count: number }>;
  perDay: Array<{ day: string; count: number }>;
  topTags: Array<{ tag: string; count: number }>;
  mostRecalled: Array<{ id: string; content: string; type: string; accessCount: number }>;
}

export const STATS_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export function statsWindowStart(now: Date, days = STATS_DAYS): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(start.getTime() - (days - 1) * DAY);
}

export function buildStatsPipeline(scope: StatsScope, now: Date): Document[] {
  const match: Document = { namespace: scope.namespace };
  if (scope.userId) match.userId = scope.userId;
  const active = { $match: { status: "active" } };

  return [
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
              avgImportance: { $avg: "$importance" },
              totalRecalls: { $sum: "$accessCount" },
            },
          },
        ],
        byType: [
          active,
          { $group: { _id: "$type", count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
        ],
        perDay: [
          { $match: { createdAt: { $gte: statsWindowStart(now) } } },
          {
            $group: {
              _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        topTags: [
          active,
          { $unwind: "$tags" },
          { $group: { _id: "$tags", count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 8 },
        ],
        mostRecalled: [
          { $match: { status: "active", accessCount: { $gt: 0 } } },
          { $sort: { accessCount: -1, _id: 1 } },
          { $limit: 5 },
          { $project: { content: 1, type: 1, accessCount: 1 } },
        ],
      },
    },
  ];
}

interface FacetResult {
  totals: Array<{
    total: number;
    active: number;
    avgImportance: number | null;
    totalRecalls: number;
  }>;
  byType: Array<{ _id: string; count: number }>;
  perDay: Array<{ _id: string; count: number }>;
  topTags: Array<{ _id: string; count: number }>;
  mostRecalled: Array<{
    _id: { toHexString(): string };
    content: string;
    type: string;
    accessCount: number;
  }>;
}

/** Shapes the $facet output for the UI, filling in days with no new memories. */
export function toStats(raw: FacetResult | undefined, now: Date): Stats {
  const totals = raw?.totals[0];
  const counts = new Map((raw?.perDay ?? []).map((d) => [d._id, d.count]));
  const start = statsWindowStart(now);
  const perDay = Array.from({ length: STATS_DAYS }, (_, i) => {
    const day = new Date(start.getTime() + i * DAY).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
  return {
    total: totals?.total ?? 0,
    active: totals?.active ?? 0,
    archived: (totals?.total ?? 0) - (totals?.active ?? 0),
    avgImportance: totals?.avgImportance ?? 0,
    totalRecalls: totals?.totalRecalls ?? 0,
    byType: (raw?.byType ?? []).map((t) => ({ type: t._id, count: t.count })),
    perDay,
    topTags: (raw?.topTags ?? []).map((t) => ({ tag: t._id, count: t.count })),
    mostRecalled: (raw?.mostRecalled ?? []).map((m) => ({
      id: m._id.toHexString(),
      content: m.content,
      type: m.type,
      accessCount: m.accessCount,
    })),
  };
}
