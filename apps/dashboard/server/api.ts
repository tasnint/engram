import type { IncomingMessage, ServerResponse } from "node:http";
import type { Document } from "mongodb";
import {
  MEMORY_TYPES,
  recall,
  RecallInputError,
  type EngramDb,
  type Embedder,
  type MemoryType,
  type RecallMode,
} from "@engram/core";
import { streamEvents } from "./events.js";
import { buildStatsPipeline, toStats } from "./stats.js";

class BadRequest extends Error {}

const MAX_LIST = 200;

/** Returns false for paths it doesn't own, so the caller can serve the web app instead. */
export function createApi(engram: EngramDb, embedder: Embedder) {
  const { memories } = engram;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Only GET is supported. Edits go through the Engram API (A6)." });
      return true;
    }
    const q = url.searchParams;

    try {
      switch (url.pathname) {
        case "/api/scopes": {
          // Every namespace/user pair, for the picker.
          const scopes = await memories
            .aggregate([
              {
                $group: { _id: { namespace: "$namespace", userId: "$userId" }, count: { $sum: 1 } },
              },
              { $sort: { "_id.namespace": 1, "_id.userId": 1 } },
              {
                $project: { _id: 0, namespace: "$_id.namespace", userId: "$_id.userId", count: 1 },
              },
            ])
            .toArray();
          sendJson(res, 200, { scopes });
          return true;
        }

        case "/api/stats": {
          const now = new Date();
          const scope = {
            namespace: required(q, "namespace"),
            userId: q.get("userId") || undefined,
          };
          const [raw] = await memories.aggregate(buildStatsPipeline(scope, now)).toArray();
          sendJson(res, 200, toStats(raw as Parameters<typeof toStats>[0], now));
          return true;
        }

        case "/api/memories": {
          const filter: Document = { namespace: required(q, "namespace") };
          const userId = q.get("userId");
          if (userId) filter.userId = userId;
          const type = q.get("type");
          if (type) filter.type = memoryType(type);
          const limit = Math.min(Number(q.get("limit") ?? 50) || 50, MAX_LIST);
          const items = await memories
            .find(filter, { projection: { embedding: 0 } })
            .sort({ createdAt: -1, _id: -1 })
            .limit(limit)
            .toArray();
          sendJson(res, 200, { memories: items });
          return true;
        }

        case "/api/search": {
          const mode = (q.get("mode") ?? "hybrid") as RecallMode;
          const results = await recall(
            { memories, embedder },
            {
              namespace: required(q, "namespace"),
              userId: required(q, "userId"),
              query: required(q, "q"),
              k: Number(q.get("k") ?? 10),
              mode,
            },
            // Browsing from the dashboard shouldn't count as the agent using a memory.
            { trackAccess: false },
          );
          sendJson(res, 200, { results });
          return true;
        }

        case "/api/events":
          streamEvents(memories, required(q, "namespace"), req, res);
          return true;

        default:
          sendJson(res, 404, { error: `No route ${url.pathname}` });
          return true;
      }
    } catch (error) {
      if (error instanceof BadRequest || error instanceof RecallInputError) {
        sendJson(res, 400, { error: error.message });
      } else {
        console.error(error);
        sendJson(res, 500, {
          error: "Something went wrong on the dashboard server. Check its logs.",
        });
      }
      return true;
    }
  };
}

function required(q: URLSearchParams, name: string): string {
  const value = q.get(name);
  if (!value) throw new BadRequest(`Missing query parameter "${name}"`);
  return value;
}

function memoryType(value: string): MemoryType {
  if (!MEMORY_TYPES.includes(value as MemoryType)) {
    throw new BadRequest(`Unknown type "${value}". Use ${MEMORY_TYPES.join(", ")}`);
  }
  return value as MemoryType;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
