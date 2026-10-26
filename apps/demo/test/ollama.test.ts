import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { Engram, Memory } from "@engram/core";
import { createOllamaConversation } from "../src/ollama.js";

const memory = {
  _id: new ObjectId("65f000000000000000000001"),
  type: "fact",
  content: "Allergic to shellfish",
  createdAt: new Date("2026-10-01"),
} as Memory;

function fakeEngram() {
  return {
    recall: vi.fn(async () => [
      {
        memory,
        score: 0.9,
        signals: { relevance: 1, importance: 1, recency: 1, vectorRank: 1, textRank: null },
      },
    ]),
    remember: vi.fn(async () => memory),
    forget: vi.fn(async () => ({ deleted: 1 })),
    list: vi.fn(),
    service: {},
  } as unknown as Engram & { recall: ReturnType<typeof vi.fn>; remember: ReturnType<typeof vi.fn> };
}

/** A fake Ollama chat endpoint that plays back assistant messages and records requests. */
function fakeOllama(replies: object[]) {
  const requests: Array<{
    url: string;
    body: { model: string; messages: Array<Record<string, unknown>>; tools: unknown[] };
  }> = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const message = replies.shift();
    if (!message) throw new Error("No more fake replies");
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

const call = (id: string, name: string, args: object | string) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

const options = (engram: Engram, fetch: typeof globalThis.fetch) => ({
  engram,
  fetch,
  namespace: "demo-agent",
  userId: "u1",
  sessionId: "s1",
  model: "qwen2.5:3b",
});

describe("Ollama backend", () => {
  it("runs memory tools, then answers, keeping the whole conversation", async () => {
    const engram = fakeEngram();
    const { fetch, requests } = fakeOllama([
      {
        content: null,
        tool_calls: [call("c1", "recall_memories", { query: "food restrictions" })],
      },
      { content: "Avoid the seafood place, you're allergic to shellfish." },
      { content: "Anytime!" },
    ]);
    const conversation = createOllamaConversation(options(engram, fetch));

    expect((await conversation.send("Where should we eat?")).text).toMatch(/shellfish/);
    expect(engram.recall).toHaveBeenCalledWith({
      namespace: "demo-agent",
      userId: "u1",
      query: "food restrictions",
      k: undefined,
    });
    expect(requests[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(requests[0]!.body.model).toBe("qwen2.5:3b");
    expect(requests[0]!.body.tools).toHaveLength(3);
    expect(requests[1]!.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(requests[1]!.body.messages.at(-1)!.content)).toContain("Allergic to shellfish");

    await conversation.send("Thanks");
    expect(requests[2]!.body.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
  });

  it("tells the model when its tool arguments are wrong instead of crashing", async () => {
    const engram = fakeEngram();
    const { fetch, requests } = fakeOllama([
      {
        content: null,
        tool_calls: [call("c1", "remember", { content: "Writes Go", type: "opinion" })],
      },
      { content: null, tool_calls: [call("c2", "remember", "{not json")] },
      {
        content: null,
        tool_calls: [call("c3", "remember", { content: "Writes Go", type: "preference" })],
      },
      { content: "Got it." },
    ]);
    const conversation = createOllamaConversation(options(engram, fetch));
    expect((await conversation.send("I write Go")).text).toBe("Got it.");
    expect(String(requests[1]!.body.messages.at(-1)!.content)).toMatch(/Invalid arguments: type/);
    expect(String(requests[2]!.body.messages.at(-1)!.content)).toMatch(/valid JSON/);
    expect(engram.remember).toHaveBeenCalledTimes(1);
    expect(engram.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Writes Go",
        type: "preference",
        source: { sessionId: "s1", messageId: null },
      }),
    );
  });

  it("explains how to start Ollama when it isn't running", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(createOllamaConversation(options(fakeEngram(), fetch)).send("hi")).rejects.toThrow(
      /pnpm llm:up/,
    );
  });

  it("explains how to download a missing model", async () => {
    const fetch = vi.fn(
      async () => new Response('{"error":"model \\"qwen2.5:3b\\" not found"}', { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(createOllamaConversation(options(fakeEngram(), fetch)).send("hi")).rejects.toThrow(
      /Download it with `pnpm llm:up`/,
    );
  });
});
