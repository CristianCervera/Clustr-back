import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const DEV_JWT_SECRET = 'clustr-dev-secret-no-usar-en-produccion-00000';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  HOST: z.string().default('0.0.0.0'),
  MONGODB_URI: z.string().trim().optional().transform((v) => v || undefined),
  JWT_SECRET: z.string().trim().optional().transform((v) => v || undefined),
  CORS_ORIGIN: z.string().default('http://localhost:5180'),
  MONGO_DATA_DIR: z.string().default(join(homedir(), '.clustr', 'mongo')),
  GOOGLE_CLIENT_ID: z.string().trim().optional().transform((v) => v || undefined),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  mongodbUri?: string;
  jwtSecret: string;
  corsOrigins: string[];
  /** Carpeta del MongoDB local de desarrollo (cuando no hay MONGODB_URI). */
  mongoDataDir: string;
  /** ID de cliente OAuth de Google. Sin él no hay login con Google. */
  googleClientId?: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = Env.parse(source);

  if (env.NODE_ENV === 'production') {
    if (!env.MONGODB_URI) throw new Error('MONGODB_URI es obligatorio en producción.');
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
      throw new Error('JWT_SECRET es obligatorio en producción y debe tener al menos 32 caracteres.');
  }

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    mongodbUri: env.MONGODB_URI,
    jwtSecret: env.JWT_SECRET ?? DEV_JWT_SECRET,
    corsOrigins: env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
    mongoDataDir: env.MONGO_DATA_DIR,
    googleClientId: env.GOOGLE_CLIENT_ID,
  };
}
