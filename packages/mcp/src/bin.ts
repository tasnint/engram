#!/usr/bin/env node
/**
 * Runs Engram as an MCP server over stdio. Configure with environment variables:
 *   ENGRAM_NAMESPACE  which agent's memories to use (default "default")
 *   ENGRAM_USER_ID    whose memories (required)
 *   MONGODB_URI, ENGRAM_DB, ENGRAM_EMBEDDER, ENGRAM_EMBEDDING_DIMS  as in .env.example
 *
 * Logs go to stderr, because stdout carries the MCP protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect, createEmbedderFromEnv, createEngram } from "@engram/core";
import { createEngramMcpServer } from "./server.js";

const userId = process.env.ENGRAM_USER_ID;
if (!userId) {
  console.error("engram-mcp: set ENGRAM_USER_ID to the user whose memories this server manages.");
  process.exit(1);
}
const namespace = process.env.ENGRAM_NAMESPACE ?? "default";

const db = await connect();
const api = createEngram({ memories: db.memories, embedder: createEmbedderFromEnv() });
const server = createEngramMcpServer({ api, namespace, userId });

const shutdown = async () => {
  await server.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error(`engram-mcp: serving memories for ${namespace}/${userId}`);
