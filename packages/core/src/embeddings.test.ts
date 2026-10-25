import { describe, expect, it, vi } from 'vitest';
import { VoyageEmbeddingProvider, validateEmbeddings } from './embeddings.js';
import { rememberSchema, forgetSchema } from './validation.js';
import { ChatCompletionSummarizer } from './summarizer.js';
import { VectorDuplicateDetector } from './write/dedup.js';
import type { Collection } from 'mongodb';
import type { StoredMemory } from './database.js';

describe('embedding providers', () => {
  it('rejects wrong dimensions, missing vectors, zero vectors and non-finite values', () => {
    for (const vectors of [[], [[1, 2]], [[0, 0, 0]], [[1, NaN, 0]], [[1, Infinity, 0]]])
      expect(() => validateEmbeddings(vectors, 1, 3)).toThrow();
    expect(validateEmbeddings([[1, 0, 0]], 1, 3)).toEqual([[1, 0, 0]]);
  });

  it('sends Voyage dimensions and purpose and restores response ordering', async () => {
    const first = Array.from({ length: 256 }, () => 0.1);
    const second = Array.from({ length: 256 }, () => 0.2);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: second },
            { index: 0, embedding: first },
          ],
        }),
      ),
    );
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'test',
      dimensions: 256,
      fetch: fetcher,
    });
    expect(await provider.embed(['one', 'two'], 'query')).toEqual([first, second]);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
      output_dimension: 256,
      input_type: 'query',
      truncation: false,
    });
  });

  it('rejects provider failures and duplicated response indices', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 1, embedding: Array(256).fill(1) }] })),
      );
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'test',
      dimensions: 256,
      fetch: fetcher,
    });
    await expect(provider.embed(['one'])).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
    await expect(provider.embed(['one'])).rejects.toMatchObject({ code: 'INVALID_EMBEDDING' });
  });
});

it('rejects empty content, invalid TTL and ambiguous destructive requests', () => {
  expect(() => rememberSchema.parse({ namespace: 'a', userId: 'b', content: ' ' })).toThrow();
  expect(() =>
    rememberSchema.parse({ namespace: 'a', userId: 'b', content: 'ok', ttlDays: -1 }),
  ).toThrow();
  expect(() => forgetSchema.parse({ id: 'a'.repeat(24), namespace: 'a', userId: 'b' })).toThrow();
  expect(() => forgetSchema.parse({ namespace: 'a' })).toThrow();
});

it('pre-filters vector duplicate candidates by tenant, user, state and type', async () => {
  const aggregate = vi.fn().mockReturnValue({ toArray: async () => [] });
  const detector = new VectorDuplicateDetector({
    aggregate,
  } as unknown as Collection<StoredMemory>);
  await detector.find({
    namespace: 'a',
    userId: 'b',
    type: 'fact',
    embedding: [1, 0, 0],
    now: new Date(),
  });
  expect(aggregate.mock.calls[0]![0][0].$vectorSearch.filter).toEqual({
    namespace: 'a',
    userId: 'b',
    status: 'active',
    type: 'fact',
  });
  aggregate.mockImplementation(() => {
    throw new Error('Missing index');
  });
  await expect(
    detector.find({
      namespace: 'a',
      userId: 'b',
      type: 'fact',
      embedding: [1, 0, 0],
      now: new Date(),
    }),
  ).rejects.toMatchObject({ code: 'VECTOR_SEARCH_UNAVAILABLE' });
});

it('passes episodes to an actual configured summarizer endpoint and rejects empty output', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Summary.' } }] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })),
    );
  const provider = new ChatCompletionSummarizer({
    url: 'http://localhost:11434/v1/chat/completions',
    model: 'local-model',
    fetch: fetcher,
  });
  const input = [{ content: 'Episode', createdAt: new Date('2026-01-01') }];
  expect(await provider.summarize(input)).toBe('Summary.');
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).messages[1].content).toContain(
    'Episode',
  );
  await expect(provider.summarize(input)).rejects.toThrow();
});
