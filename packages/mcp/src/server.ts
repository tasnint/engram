/**
 * B5: Engram as an MCP server.
 *
 * Each server instance is locked to one namespace + user (set when it starts),
 * so the agent using it can only read and write that user's memories. It can't
 * pass a different userId in a tool call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MEMORY_TYPES, type EngramApi, type Memory, type RecallResult } from "@engram/core";
import { z } from "zod";

export interface EngramMcpOptions {
  api: EngramApi;
  namespace: string;
  userId: string;
}

const memoryType = z.enum(MEMORY_TYPES);

export function createEngramMcpServer({ api, namespace, userId }: EngramMcpOptions): McpServer {
  const server = new McpServer({ name: "engram", version: "0.1.0" });

  server.registerTool(
    "recall_memories",
    {
      title: "Recall memories",
      description:
        "Search long-term memory for things you learned about the user in earlier conversations: " +
        "facts, preferences and past events. Call this at the start of a task, or whenever earlier " +
        "context might change your answer.",
      inputSchema: {
        query: z.string().min(1).describe("What you're looking for, in plain words"),
        k: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many memories to return (default 5)"),
        types: z.array(memoryType).optional().describe("Only return these kinds of memory"),
        since: z.iso
          .datetime()
          .optional()
          .describe("Only memories created at or after this ISO time"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, k, types, since }) =>
      run(async () => {
        const results = await api.recall({
          namespace,
          userId,
          query,
          k,
          types,
          since: since ? new Date(since) : undefined,
        });
        return {
          content: [{ type: "text", text: formatResults(results) }],
          structuredContent: { memories: results.map(toToolResult) },
        };
      }),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Save something worth knowing in future conversations: a fact about the user, a preference, " +
        "or something that happened. Save one idea per call, written so it makes sense on its own.",
      inputSchema: {
        content: z.string().min(1).max(2000).describe("The memory, as a standalone sentence"),
        type: memoryType.exclude(["summary"]).optional().describe("fact, preference or episode"),
        tags: z.array(z.string()).max(10).optional(),
        importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("0 = trivia, 1 = critical (e.g. an allergy)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      run(async () => {
        const memory = await api.remember({ namespace, userId, ...input });
        return {
          content: [{ type: "text", text: `Saved memory ${memory._id.toHexString()}.` }],
          structuredContent: { id: memory._id.toHexString() },
        };
      }),
  );

  server.registerTool(
    "forget_memory",
    {
      title: "Forget memory",
      description:
        "Delete one memory by id, for example when the user says it's wrong or asks you to forget it.",
      inputSchema: { id: z.string().regex(/^[0-9a-f]{24}$/, "Expected a 24-character memory id") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) =>
      run(async () => {
        const { deleted } = await api.forget({ id });
        return {
          content: [
            { type: "text", text: deleted ? `Forgot memory ${id}.` : `No memory with id ${id}.` },
          ],
          structuredContent: { deleted },
        };
      }),
  );

  return server;
}

/** Turns thrown errors into tool errors the agent can read, instead of protocol failures. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

function toToolResult(r: RecallResult) {
  return {
    id: r.memory._id.toHexString(),
    type: r.memory.type,
    content: r.memory.content,
    tags: r.memory.tags,
    createdAt: r.memory.createdAt.toISOString(),
    score: Number(r.score.toFixed(4)),
  };
}

export function formatResults(results: RecallResult[]): string {
  if (results.length === 0) return "No matching memories.";
  return results
    .map((r, i) => `${i + 1}. [${r.memory.type}] ${r.memory.content} ${meta(r.memory)}`)
    .join("\n");
}

function meta(m: Memory): string {
  return `(id ${m._id.toHexString()}, saved ${m.createdAt.toISOString().slice(0, 10)})`;
}
