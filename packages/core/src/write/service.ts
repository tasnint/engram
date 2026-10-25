import { createHash } from "node:crypto";
import { MEMORIES_COLLECTION } from "../config.js";
import { ObjectId, type Collection, type Db, type Filter } from "mongodb";
import { z } from "zod";
import { publicMemory, type StoredMemory } from "../database.js";
import { validateEmbeddings } from "../embeddings/providers.js";
import { EngramError } from "../errors.js";
import type {
  EmbeddingProvider,
  ForgetInput,
  ListMemoriesInput,
  Memory,
  MemoryPage,
  RememberInput,
} from "../types.js";
import { forgetSchema, listMemoriesSchema, rememberSchema } from "../validation.js";
import type { DuplicateDetector } from "./dedup.js";
import { extractTags, scoreImportance } from "./metadata.js";

export const contentHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");
export const unexpired = (now: Date): Filter<StoredMemory> => ({
  $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
});

export class MemoryService {
  readonly collection: Collection<StoredMemory>;

  constructor(
    db: Db,
    private readonly options: {
      embeddings: EmbeddingProvider;
      duplicates?: DuplicateDetector;
      now?: () => Date;
    },
  ) {
    this.collection = db.collection<StoredMemory>(MEMORIES_COLLECTION);
  }

  async remember(input: RememberInput): Promise<Memory> {
    const parsed = rememberSchema.parse(input);
    const now = this.options.now?.() ?? new Date();
    const [embedding] = validateEmbeddings(
      await this.options.embeddings.embed([parsed.content], "document"),
      1,
      this.options.embeddings.dimensions,
    );
    const record: StoredMemory = {
      _id: new ObjectId(),
      namespace: parsed.namespace,
      userId: parsed.userId,
      type: parsed.type,
      content: parsed.content,
      embedding: embedding!,
      tags: [...new Set(parsed.tags ?? extractTags(parsed.content))],
      importance: parsed.importance ?? scoreImportance(parsed.content, parsed.type),
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      expiresAt:
        parsed.ttlDays === undefined ? null : new Date(now.getTime() + parsed.ttlDays * 86400000),
      status: "active",
      source: parsed.source ?? { sessionId: null, messageId: null },
      consolidatedInto: null,
      contentHash: contentHash(parsed.content),
      decayAt: now,
    };
    const exactFilter = {
      namespace: record.namespace,
      userId: record.userId,
      type: record.type,
      contentHash: record.contentHash,
      status: "active" as const,
    };
    await this.collection.deleteMany({ ...exactFilter, expiresAt: { $lte: now } });
    const exact = await this.collection.findOne(exactFilter);
    const duplicate = exact ?? (await this.options.duplicates?.find({ ...record, now }));
    if (duplicate) {
      const updated = await this.updateDuplicate(duplicate, record, now);
      if (updated) return publicMemory(updated);
    }
    try {
      await this.collection.insertOne(record);
      return publicMemory(record);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === 11000)) throw error;
      const winner = await this.collection.findOne(exactFilter);
      if (!winner) throw error;
      const updated = await this.updateDuplicate(winner, record, now);
      if (!updated)
        throw new EngramError(
          "WRITE_CONFLICT",
          "Memory changed during the write. Retry the request.",
          409,
        );
      return publicMemory(updated);
    }
  }

  private async updateDuplicate(
    existing: StoredMemory,
    next: StoredMemory,
    now: Date,
  ): Promise<StoredMemory | null> {
    return this.collection.findOneAndUpdate(
      {
        _id: existing._id,
        namespace: next.namespace,
        userId: next.userId,
        type: next.type,
        status: "active",
        ...unexpired(now),
      },
      {
        $set: {
          content: next.content,
          contentHash: next.contentHash,
          embedding: next.embedding,
          tags: [...new Set([...existing.tags, ...next.tags])].slice(0, 64),
          importance: next.importance,
          expiresAt: next.expiresAt,
          source: next.source,
          decayAt: now,
        },
      },
      { returnDocument: "after" },
    );
  }

  async forget(input: ForgetInput, scope?: { namespace: string }): Promise<{ deleted: number }> {
    const parsed = forgetSchema.parse(input);
    if ("namespace" in parsed && scope && parsed.namespace !== scope.namespace)
      throw new EngramError("FORBIDDEN", "Namespace does not match the API key.", 403);
    const filter: Filter<StoredMemory> = "id" in parsed ? { _id: new ObjectId(parsed.id) } : parsed;
    if (scope) filter.namespace = scope.namespace;
    return { deleted: (await this.collection.deleteMany(filter)).deletedCount };
  }

  async list(input: ListMemoriesInput): Promise<MemoryPage> {
    const parsed = listMemoriesSchema.parse(input);
    const now = this.options.now?.() ?? new Date();
    const filters: Filter<StoredMemory>[] = [
      { namespace: parsed.namespace, userId: parsed.userId, status: parsed.status },
      unexpired(now),
    ];
    if (parsed.type) filters.push({ type: parsed.type });
    if (parsed.cursor) {
      try {
        const cursor = z
          .object({ date: z.iso.datetime(), id: z.string().regex(/^[a-f0-9]{24}$/) })
          .parse(JSON.parse(Buffer.from(parsed.cursor, "base64url").toString()));
        filters.push({
          $or: [
            { createdAt: { $lt: new Date(cursor.date) } },
            { createdAt: new Date(cursor.date), _id: { $lt: new ObjectId(cursor.id) } },
          ],
        });
      } catch {
        throw new EngramError("INVALID_CURSOR", "The pagination cursor is invalid.", 400);
      }
    }
    const rows = await this.collection
      .find({ $and: filters })
      .sort({ createdAt: -1, _id: -1 })
      .limit(parsed.limit + 1)
      .toArray();
    const selected = rows.slice(0, parsed.limit);
    const last = selected.at(-1);
    return {
      memories: selected.map(publicMemory),
      nextCursor:
        rows.length > parsed.limit && last
          ? Buffer.from(
              JSON.stringify({ date: last.createdAt.toISOString(), id: last._id.toHexString() }),
            ).toString("base64url")
          : null,
    };
  }
}
