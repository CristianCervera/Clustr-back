import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../http-errors.js';
import { User } from '../models/user.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: exige un token válido. */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    signToken(userId: string): string;
  }
  interface FastifyRequest {
    viewerId?: string;
  }
}

export default fp<{ secret: string }>(async (app, opts) => {
  await app.register(jwt, { secret: opts.secret, sign: { expiresIn: '30d' } });

  app.decorateRequest('viewerId', undefined);

  app.decorate('signToken', (userId: string) => app.jwt.sign({ sub: userId }));

  /** Id del usuario del token, o undefined si el token no vale o su cuenta ya no existe. */
  async function viewerOf(request: FastifyRequest): Promise<string | undefined> {
    try {
      const { sub } = await request.jwtVerify<{ sub: string }>();
      return (await User.exists({ _id: sub })) ? sub : undefined;
    } catch {
      return undefined;
    }
  }

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const viewerId = await viewerOf(request);
    if (!viewerId) throw unauthorized('Tu sesión ha caducado o no es válida. Vuelve a iniciar sesión.');
    request.viewerId = viewerId;
  });
});
