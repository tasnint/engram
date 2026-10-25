# Engram TypeScript SDK

Node.js 22 or newer. The package has no runtime dependencies. Build it with `pnpm --filter @engram-memory/sdk build`.

```ts
import { EngramClient } from '@engram-memory/sdk';

const client = new EngramClient({
  baseUrl: 'http://localhost:3000',
  namespace: 'support-bot',
  apiKey: process.env.ENGRAM_API_KEY!,
});

const memory = await client.remember({
  userId: 'u_123',
  content: 'Prefers answers in Python',
  type: 'preference',
});

const page = await client.list({ userId: 'u_123', limit: 25 });
await client.forget({ id: memory._id });
```

`recall()` becomes available when the server connects Track B's recall implementation. Dates and ObjectIds in responses are JSON strings. A namespace is supplied by the client configuration. `EngramApiError` exposes `status`, `code`, and optional validation `details`.

`list()` and `recall()` retry network failures and HTTP 429, 502, 503, and 504, with bounded exponential backoff and Retry-After support. Writes are not automatically retried because a disconnected response does not establish whether the server committed the write. Every method accepts an optional AbortSignal as its second argument. Defaults: two retries, 30-second timeout per attempt.

Before publishing, select an npm name or scope you own, set package metadata and a license, run the repository checks, and inspect `pnpm --filter @engram-memory/sdk pack`. This repository does not publish automatically.
