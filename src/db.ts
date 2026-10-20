import { mkdir } from 'node:fs/promises';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';

export interface Database {
  uri: string;
  /** Carpeta del MongoDB local de desarrollo, si se usa. */
  localDataDir?: string;
  close(): Promise<void>;
}

/**
 * Conecta Mongoose. Sin URI (solo fuera de producción) arranca un MongoDB local:
 * - con `localDataDir`, los datos se guardan en esa carpeta y sobreviven a los reinicios;
 * - sin ella, la base vive en memoria (tests).
 */
export async function connectDb(uri?: string, localDataDir?: string): Promise<Database> {
  let local: MongoMemoryServer | undefined;
  if (!uri) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    if (localDataDir) await mkdir(localDataDir, { recursive: true });
    local = await MongoMemoryServer.create(
      localDataDir ? { instance: { dbPath: localDataDir, storageEngine: 'wiredTiger' } } : undefined,
    );
    uri = local.getUri('clustr');
  }

  await mongoose.connect(uri);
  await mongoose.syncIndexes();

  return {
    uri,
    localDataDir: local ? localDataDir : undefined,
    async close() {
      await mongoose.disconnect();
      // doCleanup: false conserva la carpeta de datos local.
      await local?.stop({ doCleanup: !localDataDir });
    },
  };
}
