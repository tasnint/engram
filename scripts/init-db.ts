import { MongoClient } from 'mongodb';
import { embeddingFromEnvironment, initializeDatabase } from '@engram/core';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const provider = embeddingFromEnvironment();
  await initializeDatabase(client.db(process.env.MONGODB_DATABASE ?? 'engram'), provider);
  console.log(`Database initialized for ${provider.model} (${provider.dimensions} dimensions).`);
} finally {
  await client.close();
}
