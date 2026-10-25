import type { ObjectId } from 'mongodb';

export type MemoryType = 'fact' | 'preference' | 'episode' | 'summary';

export interface Memory {
  _id: ObjectId;
  namespace: string;
  userId: string;
  type: MemoryType;
  content: string;
  embedding: number[];
  tags: string[];
  importance: number;
  accessCount: number;
  lastAccessedAt: Date;
  createdAt: Date;
  expiresAt: Date | null;
  status: 'active' | 'archived';
  source: { sessionId: string | null; messageId: string | null };
  consolidatedInto: ObjectId | null;
}

export interface RememberInput {
  namespace: string;
  userId: string;
  content: string;
  type?: MemoryType;
  tags?: string[];
  importance?: number;
  ttlDays?: number;
  source?: Memory['source'];
}

export type ForgetInput = { id: string } | { namespace: string; userId: string };

export interface RecallInput {
  namespace: string;
  userId: string;
  query: string;
  k?: number;
  types?: MemoryType[];
  since?: Date;
}

export interface RecallResult {
  memory: Memory;
  score: number;
}

export type Remember = (input: RememberInput) => Promise<Memory>;
export type Forget = (input: ForgetInput) => Promise<{ deleted: number }>;
export type Recall = (input: RecallInput) => Promise<RecallResult[]>;

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], inputType?: 'document' | 'query'): Promise<number[][]>;
}

export interface Summarizer {
  summarize(episodes: readonly Pick<Memory, 'content' | 'createdAt'>[]): Promise<string>;
}

export interface ListMemoriesInput {
  namespace: string;
  userId: string;
  type?: MemoryType;
  status?: 'active' | 'archived';
  limit?: number;
  cursor?: string;
}

export interface MemoryPage {
  memories: Memory[];
  nextCursor: string | null;
}
