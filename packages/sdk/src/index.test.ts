import { expect, it, vi } from "vitest";
import { EngramClient } from "./index.js";

const options = { baseUrl: "http://localhost:3000", namespace: "support", apiKey: "key" };

it("sets namespace and authentication and serializes timestamps", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]"));
  const client = new EngramClient({ ...options, fetch: fetcher });
  await client.recall({ userId: "u1", query: "Python", since: new Date("2026-01-01") });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("http://localhost:3000/recall");
  expect(init?.headers).toMatchObject({ "x-api-key": "key" });
  expect(JSON.parse(init!.body as string)).toMatchObject({
    namespace: "support",
    since: "2026-01-01T00:00:00.000Z",
  });
});

it("retries transient reads while preserving server errors", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "0" } }))
    .mockResolvedValueOnce(new Response('{"memories":[],"nextCursor":null}'));
  const client = new EngramClient({ ...options, fetch: fetcher });
  expect(await client.list({ userId: "a b" })).toEqual({ memories: [], nextCursor: null });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[0]![0])).toContain("userId=a+b");
});

it("does not replay writes or retry authentication failures", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('{"error":{"code":"UNAUTHORIZED","message":"Bad key"}}', { status: 401 }),
    );
  const client = new EngramClient({ ...options, fetch: fetcher });
  await expect(client.list({ userId: "u1" })).rejects.toMatchObject({
    status: 401,
    code: "UNAUTHORIZED",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockReset().mockRejectedValue(new TypeError("Connection lost"));
  await expect(client.remember({ userId: "u1", content: "hello" })).rejects.toThrow(
    "Connection lost",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("honors cancellation before sending and during retry delays", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("{}", { status: 503, headers: { "retry-after": "10" } }));
  const client = new EngramClient({ ...options, fetch: fetcher });
  const controller = new AbortController();
  controller.abort();
  await expect(client.list({ userId: "u1" }, controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  const later = new AbortController();
  const request = client.list({ userId: "u1" }, later.signal);
  setTimeout(() => later.abort(), 10);
  await expect(request).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
