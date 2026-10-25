/**
 * The live feed: a MongoDB change stream on `memories`, forwarded to the
 * browser as server-sent events (SSE).
 *
 * Change streams read the oplog, which is why they need a replica set. Each
 * event carries a resume token. We send it as the SSE event id, so when the
 * browser reconnects it sends the token back (Last-Event-ID) and the stream
 * picks up where it left off, without missing changes in between.
 */
import type { ChangeStreamDocument, Collection, Document, ResumeToken } from "mongodb";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryDoc } from "@engram/core";

export type FeedEvent =
  | { kind: "insert" | "update"; id: string; at: string; memory: Document; changed?: string[] }
  | { kind: "delete"; id: string; at: string };

/** Change stream pipeline: only this namespace, and never ship embeddings. */
export function changeStreamPipeline(namespace: string): Document[] {
  return [
    {
      $match: {
        $or: [
          {
            operationType: { $in: ["insert", "update", "replace"] },
            "fullDocument.namespace": namespace,
          },
          // A deleted document is gone, so there's no namespace to match on. The
          // browser ignores deletes for ids it isn't showing.
          { operationType: "delete" },
        ],
      },
    },
    { $project: { "fullDocument.embedding": 0, "updateDescription.updatedFields.embedding": 0 } },
  ];
}

export function toFeedEvent(change: ChangeStreamDocument<MemoryDoc>): FeedEvent | null {
  // wallTime is when the write happened on the server (MongoDB 6.0+).
  const wallTime = (change as { wallTime?: Date }).wallTime;
  const at = (wallTime instanceof Date ? wallTime : new Date()).toISOString();
  switch (change.operationType) {
    case "insert":
    case "replace":
      return {
        kind: "insert",
        id: change.documentKey._id.toHexString(),
        at,
        memory: change.fullDocument,
      };
    case "update":
      if (!change.fullDocument) return null; // deleted again before the lookup ran
      return {
        kind: "update",
        id: change.documentKey._id.toHexString(),
        at,
        memory: change.fullDocument,
        changed: Object.keys(change.updateDescription.updatedFields ?? {}),
      };
    case "delete":
      return { kind: "delete", id: change.documentKey._id.toHexString(), at };
    default:
      return null;
  }
}

export function encodeResumeToken(token: ResumeToken): string {
  return Buffer.from(JSON.stringify(token)).toString("base64url");
}

export function decodeResumeToken(id: string | undefined): ResumeToken | undefined {
  if (!id) return undefined;
  try {
    return JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as ResumeToken;
  } catch {
    return undefined;
  }
}

export function streamEvents(
  memories: Collection<MemoryDoc>,
  namespace: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Tell the browser to retry after 2s if the connection drops.
  res.write("retry: 2000\n\n");

  const lastEventId = req.headers["last-event-id"];
  const resumeAfter = decodeResumeToken(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
  const stream = memories.watch(changeStreamPipeline(namespace), {
    fullDocument: "updateLookup",
    ...(resumeAfter ? { resumeAfter } : {}),
  });

  stream.on("change", (change) => {
    const event = toFeedEvent(change);
    if (!event) return;
    res.write(
      `id: ${encodeResumeToken(change._id)}\nevent: memory\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });
  stream.on("error", (error) => {
    // Most often: the resume token is older than the oplog keeps. Tell the
    // browser to reload its data and reconnect without a token.
    res.write(`event: reset\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    res.end();
  });

  // Comments keep proxies from closing an idle connection.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    void stream.close();
  });
}
