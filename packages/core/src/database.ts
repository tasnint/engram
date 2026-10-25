import type { Db, Document } from 'mongodb';
import type { Memory } from './types.js';
import { EngramError } from './errors.js';

export interface StoredMemory extends Memory {
  contentHash: string;
  decayAt: Date;
}

export async function initializeDatabase(
  db: Db,
  embedding: { model: string; dimensions: number },
): Promise<void> {
  if (!Number.isInteger(embedding.dimensions) || embedding.dimensions < 1 || !embedding.model)
    throw new Error('Invalid embedding configuration.');
  const config = db.collection<{ _id: string; model: string; dimensions: number }>('engram_config');
  try {
    await config.updateOne({ _id: 'embedding' }, { $setOnInsert: embedding }, { upsert: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
  }
  const existing = await config.findOne({ _id: 'embedding' });
  if (existing?.model !== embedding.model || existing.dimensions !== embedding.dimensions) {
    throw new EngramError(
      'EMBEDDING_CONFIG_MISMATCH',
      'This database uses a different embedding model or dimension. Use a separate database or re-embed all memories.',
    );
  }
  const validator: Document = {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'namespace',
        'userId',
        'type',
        'content',
        'embedding',
        'tags',
        'importance',
        'accessCount',
        'lastAccessedAt',
        'createdAt',
        'expiresAt',
        'status',
        'source',
        'consolidatedInto',
        'contentHash',
        'decayAt',
      ],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'objectId' },
        namespace: { bsonType: 'string', minLength: 1, maxLength: 128 },
        userId: { bsonType: 'string', minLength: 1, maxLength: 256 },
        type: { enum: ['fact', 'preference', 'episode', 'summary'] },
        content: { bsonType: 'string', minLength: 1, maxLength: 16000 },
        embedding: {
          bsonType: 'array',
          minItems: embedding.dimensions,
          maxItems: embedding.dimensions,
          items: { bsonType: ['double', 'int', 'long', 'decimal'] },
        },
        tags: {
          bsonType: 'array',
          maxItems: 64,
          uniqueItems: true,
          items: { bsonType: 'string', minLength: 1, maxLength: 64 },
        },
        importance: { bsonType: ['double', 'int', 'long', 'decimal'], minimum: 0, maximum: 1 },
        accessCount: { bsonType: ['int', 'long', 'double'], minimum: 0, multipleOf: 1 },
        lastAccessedAt: { bsonType: 'date' },
        createdAt: { bsonType: 'date' },
        expiresAt: { bsonType: ['date', 'null'] },
        status: { enum: ['active', 'archived'] },
        source: {
          bsonType: 'object',
          required: ['sessionId', 'messageId'],
          additionalProperties: false,
          properties: {
            sessionId: { bsonType: ['string', 'null'], maxLength: 256 },
            messageId: { bsonType: ['string', 'null'], maxLength: 256 },
          },
        },
        consolidatedInto: { bsonType: ['objectId', 'null'] },
        contentHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        decayAt: { bsonType: 'date' },
      },
    },
  };
  try {
    await db.createCollection('memories', {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 48)) throw error;
    await db.command({
      collMod: 'memories',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await db.collection('memories').createIndexes([
    { key: { namespace: 1, userId: 1, status: 1, createdAt: -1, _id: -1 }, name: 'memory_listing' },
    {
      key: { namespace: 1, userId: 1, status: 1, type: 1, createdAt: -1, _id: -1 },
      name: 'memory_type_listing',
    },
    { key: { expiresAt: 1 }, name: 'memory_expiry', expireAfterSeconds: 0 },
    {
      key: { namespace: 1, userId: 1, type: 1, contentHash: 1 },
      name: 'active_exact_duplicate',
      unique: true,
      partialFilterExpression: { status: 'active' },
    },
    { key: { status: 1, type: 1, createdAt: 1 }, name: 'episode_consolidation' },
  ]);
}

export function publicMemory(record: StoredMemory): Memory {
  const { contentHash: _contentHash, decayAt: _decayAt, ...memory } = record;
  return memory;
}
