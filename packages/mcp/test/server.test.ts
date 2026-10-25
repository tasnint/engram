import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { EngramApi, Memory, RecallResult } from "@engram/core";
import { createEngramMcpServer } from "../src/server.js";

const memory: Memory = {
  _id: new ObjectId("65f000000000000000000001"),
  namespace: "bot",
  userId: "u1",
  type: "preference",
  content: "Prefers Python",
  tags: ["coding"],
  importance: 0.8,
  accessCount: 0,
  lastAccessedAt: new Date("2026-10-01T00:00:00Z"),
  createdAt: new Date("2026-10-01T00:00:00Z"),
  expiresAt: null,
  status: "active",
  source: {},
  consolidatedInto: null,
};
const hit: RecallResult = {
  memory,
  score: 0.91234,
  signals: { relevance: 1, importance: 0.8, recency: 0.9, vectorRank: 1, textRank: 2 },
};

async function setup(overrides: Partial<EngramApi> = {}) {
  const api: EngramApi = {
    recall: vi.fn(async () => [hit]),
    remember: vi.fn(async () => memory),
    forget: vi.fn(async () => ({ deleted: 1 })),
    ...overrides,
  };
  const server = createEngramMcpServer({ api, namespace: "bot", userId: "u1" });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { api, client };
}

describe("engram MCP server", () => {
  it("lists the three tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "forget_memory",
      "recall_memories",
      "remember",
    ]);
    expect(tools.find((t) => t.name === "recall_memories")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "forget_memory")?.annotations?.destructiveHint).toBe(true);
  });

  it("recalls with the server's namespace and user, never the caller's", async () => {
    const { api, client } = await setup();
    const res = await client.callTool({
      name: "recall_memories",
      arguments: { query: "language", k: 3, since: "2026-01-01T00:00:00Z", userId: "someone-else" },
    });
    expect(api.recall).toHaveBeenCalledWith({
      namespace: "bot",
      userId: "u1",
      query: "language",
      k: 3,
      types: undefined,
      since: new Date("2026-01-01T00:00:00Z"),
    });
    expect(res.content).toEqual([
      {
        type: "text",
        text: "1. [preference] Prefers Python (id 65f000000000000000000001, saved 2026-10-01)",
      },
    ]);
    expect(res.structuredContent).toMatchObject({
      memories: [{ id: "65f000000000000000000001", score: 0.9123 }],
    });
  });

  it("saves memories for the server's user", async () => {
    const { api, client } = await setup();
    await client.callTool({
      name: "remember",
      arguments: { content: "Likes tea", type: "preference" },
    });
    expect(api.remember).toHaveBeenCalledWith({
      namespace: "bot",
      userId: "u1",
      content: "Likes tea",
      type: "preference",
    });
  });

  it("rejects bad input before calling Engram", async () => {
    const { api, client } = await setup();
    const res = await client.callTool({ name: "forget_memory", arguments: { id: "not-an-id" } });
    expect(res.isError).toBe(true);
    expect(api.forget).not.toHaveBeenCalled();
  });

  it("returns errors as tool errors the agent can read", async () => {
    const { client } = await setup({
      remember: async () => {
        throw new Error("remember() isn't implemented yet (Track A, A2)");
      },
    });
    const res = await client.callTool({ name: "remember", arguments: { content: "x" } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([
      { type: "text", text: "remember() isn't implemented yet (Track A, A2)" },
    ]);
  });

  it("says so when nothing matches", async () => {
    const { client } = await setup({ recall: async () => [] });
    const res = await client.callTool({ name: "recall_memories", arguments: { query: "x" } });
    expect(res.content).toEqual([{ type: "text", text: "No matching memories." }]);
  });
});
