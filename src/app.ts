import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import mongoose from 'mongoose';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { HttpError } from './http-errors.js';
import auth from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { groupRoutes } from './routes/groups.js';
import { peopleRoutes } from './routes/people.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export async function buildApp(config: Config) {
  const app = Fastify({
    // Las importaciones de Excel grandes superan el límite por defecto de 1 MB.
    bodyLimit: 5 * 1024 * 1024,
    logger:
      config.env === 'test'
        ? false
        : config.env === 'production'
          ? { level: 'info' }
          : { level: 'debug', transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
  }).withTypeProvider<ZodTypeProvider>();

  // Acepta JSON vacío: algunos clientes envían Content-Type JSON en POST/DELETE sin cuerpo.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('El cuerpo de la petición no es JSON válido.'), { statusCode: 400, code: 'INVALID_JSON' }), undefined);
    }
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('config', config);

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(auth, { secret: config.jwtSecret });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const first = error.validation[0];
      return reply.code(400).send({
        error: 'VALIDATION',
        message: first?.message ?? 'Datos no válidos.',
        issues: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (error instanceof HttpError) {
      if (error.cause) request.log.error(error.cause);
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof mongoose.Error.ValidationError) {
      return reply.code(400).send({ error: 'VALIDATION', message: Object.values(error.errors)[0]?.message ?? 'Datos no válidos.' });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.code ?? 'BAD_REQUEST', message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL', message: 'Algo ha fallado en el servidor. Inténtalo de nuevo.' });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'NOT_FOUND', message: `No existe la ruta ${request.method} ${request.url}.` }),
  );

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true, db: mongoose.connection.readyState === 1, google: Boolean(config.googleClientId) }));
      await api.register(authRoutes);
      await api.register(peopleRoutes);
      await api.register(groupRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
