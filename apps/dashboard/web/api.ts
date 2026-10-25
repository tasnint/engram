/** Types as they arrive over JSON: ids are hex strings, dates are ISO strings. */
export type MemoryType = "fact" | "preference" | "episode" | "summary";

export interface Memory {
  _id: string;
  namespace: string;
  userId: string;
  type: MemoryType;
  content: string;
  tags: string[];
  importance: number;
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
  status: "active" | "archived";
}

export interface Scope {
  namespace: string;
  userId: string;
  count: number;
}

export interface Stats {
  total: number;
  active: number;
  archived: number;
  avgImportance: number;
  totalRecalls: number;
  byType: Array<{ type: MemoryType; count: number }>;
  perDay: Array<{ day: string; count: number }>;
  topTags: Array<{ tag: string; count: number }>;
  mostRecalled: Array<{ id: string; content: string; type: MemoryType; accessCount: number }>;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  signals: {
    relevance: number;
    importance: number;
    recency: number;
    vectorRank: number | null;
    textRank: number | null;
  };
}

export type SearchMode = "hybrid" | "vector" | "text";

export type FeedEvent =
  | { kind: "insert" | "update"; id: string; at: string; memory: Memory; changed?: string[] }
  | { kind: "delete"; id: string; at: string };

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  );
  const res = await fetch(`${path}?${qs}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  scopes: () => get<{ scopes: Scope[] }>("/api/scopes", {}).then((r) => r.scopes),
  stats: (namespace: string, userId: string) => get<Stats>("/api/stats", { namespace, userId }),
  memories: (namespace: string, userId: string) =>
    get<{ memories: Memory[] }>("/api/memories", { namespace, userId, limit: "100" }).then(
      (r) => r.memories,
    ),
  forget: async (id: string) => {
    const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Delete failed (${res.status})`);
    return body as { deleted: number };
  },
  search: (namespace: string, userId: string, q: string, mode: SearchMode) =>
    get<{ results: SearchResult[] }>("/api/search", { namespace, userId, q, mode }).then(
      (r) => r.results,
    ),
};
