/**
 * Default backend: a free open model running locally in Ollama (`pnpm llm:up`).
 * No account or API key. Uses Ollama's OpenAI-compatible chat endpoint with
 * tool calling, and runs the tool loop here.
 */
import { z } from "zod";
import { memoryTools, SYSTEM_PROMPT, type Conversation, type MemoryToolOptions } from "./tools.js";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";
const MAX_TOOL_ROUNDS = 6;

export interface OllamaOptions extends MemoryToolOptions {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function").default("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
});

export function createOllamaConversation(options: OllamaOptions): Conversation {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;
  const doFetch = options.fetch ?? fetch;
  const tools = memoryTools(options);
  const toolSpecs = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.inputSchema, { target: "draft-7" }),
    },
  }));
  const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  async function complete(): Promise<z.infer<typeof responseSchema>["choices"][number]["message"]> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: history, tools: toolSpecs, temperature: 0.2 }),
      });
    } catch (error) {
      throw new Error(`Couldn't reach Ollama at ${baseUrl}. Start it with \`pnpm llm:up\`.`, {
        cause: error,
      });
    }
    if (!response.ok) {
      const body = await response.text();
      const hint = /not found/i.test(body) ? ` Download it with \`pnpm llm:up\`.` : "";
      throw new Error(`Ollama returned HTTP ${response.status}: ${body.slice(0, 200)}${hint}`);
    }
    return responseSchema.parse(await response.json()).choices[0]!.message;
  }

  async function runTool(call: ToolCall): Promise<string> {
    const tool = tools.find((t) => t.name === call.function.name);
    if (!tool) return `Unknown tool "${call.function.name}".`;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return "The arguments weren't valid JSON. Try again.";
    }
    // Small models sometimes send the wrong shape, so check before running.
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
    }
    try {
      return await tool.run(parsed.data as never);
    } catch (error) {
      return `The tool failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    async send(text: string) {
      history.push({ role: "user", content: text });
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const message = await complete();
        const calls = (message.tool_calls ?? []) as ToolCall[];
        history.push({
          role: "assistant",
          content: message.content ?? null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
        if (calls.length === 0) return { text: (message.content ?? "").trim() };
        for (const call of calls) {
          history.push({ role: "tool", tool_call_id: call.id, content: await runTool(call) });
        }
      }
      return { text: "(Stopped after too many tool calls.)" };
    },
  };
}
