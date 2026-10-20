import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDb } from './db.js';

const config = loadConfig();
const db = await connectDb(config.mongodbUri, config.mongoDataDir);
const app = await buildApp(config);

if (db.localDataDir) {
  app.log.info(`MongoDB local de desarrollo, datos en ${db.localDataDir}. Define MONGODB_URI en .env para usar otro.`);
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} recibido, cerrando…`);
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
