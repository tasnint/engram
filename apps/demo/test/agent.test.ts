import Anthropic from "@anthropic-ai/sdk";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { Engram, Memory } from "@engram/core";
import { createConversation, MODEL } from "../src/agent.js";

const memory: Memory = {
  _id: new ObjectId("65f000000000000000000001"),
  namespace: "demo-agent",
  userId: "u1",
  type: "fact",
  content: "Allergic to shellfish",
  tags: [],
  importance: 0.9,
  accessCount: 0,
  lastAccessedAt: new Date("2026-10-01"),
  createdAt: new Date("2026-10-01"),
  expiresAt: null,
  status: "active",
  source: { sessionId: null, messageId: null },
  consolidatedInto: null,
};

function fakeEngram(): Engram {
  return {
    recall: vi.fn(async () => [
      {
        memory,
        score: 0.9,
        signals: { relevance: 1, importance: 0.9, recency: 1, vectorRank: 1, textRank: null },
      },
    ]),
    remember: vi.fn(async () => memory),
    forget: vi.fn(async () => ({ deleted: 1 })),
    list: vi.fn(),
    service: {} as Engram["service"],
  };
}

/** A fake Messages API: plays back the given responses and records requests. */
function fakeClaude(responses: object[]) {
  const requests: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const body = responses.shift();
    if (!body) throw new Error("No more fake responses");
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  const client = new Anthropic({
    apiKey: "test",
    fetch: fetch as unknown as typeof globalThis.fetch,
    maxRetries: 0,
  });
  return { client, requests };
}

const message = (content: object[], stop_reason: string) => ({
  id: `msg_${Math.random()}`,
  type: "message",
  role: "assistant",
  model: MODEL,
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

describe("demo agent", () => {
  it("recalls through Engram, then answers, keeping the full history", async () => {
    const engram = fakeEngram();
    const { client, requests } = fakeClaude([
      message(
        [
          {
            type: "tool_use",
            id: "tu_1",
            name: "recall_memories",
            input: { query: "dietary restrictions" },
          },
        ],
        "tool_use",
      ),
      message(
        [{ type: "text", text: "Skip the seafood place, you're allergic to shellfish." }],
        "end_turn",
      ),
      message([{ type: "text", text: "You're welcome!" }], "end_turn"),
    ]);
    const events: string[] = [];
    const conversation = createConversation({
      engram,
      client,
      namespace: "demo-agent",
      userId: "u1",
      sessionId: "s1",
      onMemory: (e) => events.push(e.tool),
    });

    const first = await conversation.send("Where should we eat?");
    expect(first.text).toMatch(/shellfish/);
    expect(engram.recall).toHaveBeenCalledWith({
      namespace: "demo-agent",
      userId: "u1",
      query: "dietary restrictions",
      k: undefined,
    });
    expect(events).toEqual(["recall"]);

    // The tool result went back to Claude with the memory and its id.
    const toolResultTurn = (
      requests[1]!.messages as Array<{ content: Array<{ type: string; content: unknown }> }>
    ).at(-1)!;
    expect(JSON.stringify(toolResultTurn.content)).toContain("Allergic to shellfish");

    await conversation.send("Thanks");
    // A new turn starts a fresh request carrying the whole conversation so far,
    // unchanged and in order (append-only), plus the new message.
    const secondTurn = requests[2]!.messages as Array<{ role: string; content: unknown }>;
    expect(secondTurn.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(secondTurn[0]).toEqual({ role: "user", content: "Where should we eat?" });
    expect(JSON.stringify(secondTurn[1]!.content)).toContain("recall_memories");
    expect(JSON.stringify(secondTurn[2]!.content)).toContain("Allergic to shellfish");
    expect(JSON.stringify(secondTurn[3]!.content)).toContain("Skip the seafood place");
    expect(secondTurn[4]).toEqual({ role: "user", content: "Thanks" });

    expect(requests[0]).toMatchObject({
      model: MODEL,
      fallbacks: "default",
      output_config: { effort: "low" },
    });
  });

  it("saves memories for this user and session", async () => {
    const engram = fakeEngram();
    const { client } = fakeClaude([
      message(
        [
          {
            type: "tool_use",
            id: "tu_1",
            name: "remember",
            input: { content: "Writes everything in Go", type: "preference" },
          },
        ],
        "tool_use",
      ),
      message([{ type: "text", text: "Noted." }], "end_turn"),
    ]);
    const conversation = createConversation({
      engram,
      client,
      namespace: "demo-agent",
      userId: "u1",
      sessionId: "s42",
    });
    await conversation.send("I write everything in Go.");
    expect(engram.remember).toHaveBeenCalledWith({
      namespace: "demo-agent",
      userId: "u1",
      content: "Writes everything in Go",
      type: "preference",
      importance: undefined,
      source: { sessionId: "s42", messageId: null },
    });
  });

  it("says so when Claude declines", async () => {
    const { client } = fakeClaude([message([], "refusal")]);
    const conversation = createConversation({
      engram: fakeEngram(),
      client,
      namespace: "n",
      userId: "u",
      sessionId: "s",
    });
    expect((await conversation.send("…")).text).toBe("(Claude declined to answer that.)");
  });
});
