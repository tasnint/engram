# @engram/mcp

Engram as an MCP server. It gives any MCP-capable agent three tools: `recall_memories`, `remember` and `forget_memory`.

Each server is locked to one agent namespace and one user, set when it starts. The agent can't read or write another user's memories through tool arguments.

## Use with Claude Desktop

Build first (`pnpm build` at the repo root), then add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/absolute/path/to/engram/packages/mcp/dist/bin.js"],
      "env": {
        "ENGRAM_NAMESPACE": "claude-desktop",
        "ENGRAM_USER_ID": "me",
        "MONGODB_URI": "mongodb://localhost:27017/?directConnection=true",
        "EMBEDDING_PROVIDER": "local",
        "DEDUP_MODE": "vector"
      }
    }
  }
}
```

Use the same `EMBEDDING_PROVIDER` as the rest of your setup. A database is bound to one embedding model.
