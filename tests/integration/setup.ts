import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { MongoClient } from 'mongodb';

export default async function setup() {
  if (process.env.MONGODB_TEST_URI) return;
  const executable =
    process.env.MONGOD_BINARY ?? execFileSync('which', ['mongod'], { encoding: 'utf8' }).trim();
  const directory = await mkdtemp(join(tmpdir(), 'engram-test-'));
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No free port.'));
      server.close(() => resolve(address.port));
    });
  });
  const child = spawn(
    executable,
    [
      '--dbpath',
      directory,
      '--port',
      String(port),
      '--bind_ip',
      '127.0.0.1',
      '--replSet',
      'engramTest',
      '--quiet',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '';
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-10000);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-10000);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`mongod exited: ${logs}`);
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
      try {
        await client.connect();
        try {
          await client.db('admin').command({
            replSetInitiate: {
              _id: 'engramTest',
              members: [{ _id: 0, host: `127.0.0.1:${port}` }],
            },
          });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 23)) throw error;
        }
        const hello = await client.db('admin').command({ hello: 1 });
        if (hello.isWritablePrimary) {
          ready = true;
          break;
        }
      } catch {
        await setTimeout(250);
      } finally {
        await client.close();
      }
    }
    if (!ready) throw new Error(`MongoDB replica set did not become ready: ${logs}`);
    process.env.MONGODB_TEST_URI = `${uri}&replicaSet=engramTest`;
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
