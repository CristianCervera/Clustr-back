import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { GroupPreferences } from '../grouping.js';
import { GroupSet } from '../models/group-set.js';
import { Person } from '../models/person.js';
import { LOCALES, THEMES, User } from '../models/user.js';
import { HttpError, badRequest, conflict, notFound, unauthorized } from '../http-errors.js';
import { userDto } from '../serialize.js';

const email = z.string().trim().toLowerCase().email('Escribe un email válido.');
const newPassword = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200);

const Register = z.object({
  email,
  password: newPassword,
  name: z.string().trim().min(1, 'Escribe tu nombre.').max(60),
  locale: z.enum(LOCALES).optional(),
});

const Login = z.object({ email, password: z.string().min(1, 'Escribe tu contraseña.') });

const Google = z.object({ credential: z.string().min(1), locale: z.enum(LOCALES).optional() });

const UpdateMe = z.object({
  name: z.string().trim().min(1, 'Escribe tu nombre.').max(60).optional(),
  locale: z.enum(LOCALES).optional(),
  theme: z.enum(THEMES).optional(),
  preferences: GroupPreferences.optional(),
});

const ChangePassword = z.object({
  /** No hace falta si la cuenta se creó con Google y aún no tiene contraseña. */
  currentPassword: z.string().optional(),
  newPassword,
});

/** Hash precalculado para igualar el tiempo de respuesta cuando el email no existe. */
const DUMMY_HASH = bcrypt.hashSync('clustr-dummy-password', 10);

const findMe = (id?: string) => User.findById(id).select('+passwordHash');

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const google = app.config.googleClientId ? new OAuth2Client(app.config.googleClientId) : undefined;

  app.post('/auth/register', { schema: { body: Register } }, async (request, reply) => {
    const { email, password, name, locale } = request.body;
    if (await User.exists({ email })) throw conflict('Ya existe una cuenta con ese email.');
    const user = await User.create({ email, name, locale, passwordHash: await bcrypt.hash(password, 10) });
    return reply.code(201).send({ token: app.signToken(user.id), user: userDto(user) });
  });

  app.post('/auth/login', { schema: { body: Login } }, async (request) => {
    const { email, password } = request.body;
    const user = await User.findOne({ email }).select('+passwordHash');
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !ok) throw unauthorized('El email o la contraseña no son correctos.');
    return { token: app.signToken(user.id), user: userDto(user) };
  });

  /** Recibe el ID token de Google Identity Services, lo verifica y entra (o crea la cuenta). */
  app.post('/auth/google', { schema: { body: Google } }, async (request) => {
    if (!google) throw new HttpError(503, 'GOOGLE_UNAVAILABLE', 'El acceso con Google no está configurado.');
    let payload;
    try {
      const ticket = await google.verifyIdToken({ idToken: request.body.credential, audience: app.config.googleClientId });
      payload = ticket.getPayload();
    } catch (cause) {
      throw new HttpError(401, 'GOOGLE_INVALID', 'No se ha podido verificar tu cuenta de Google. Inténtalo de nuevo.', { cause });
    }
    if (!payload?.email || !payload.email_verified) throw unauthorized('Tu cuenta de Google no tiene un email verificado.');

    const googleId = payload.sub;
    const mail = payload.email.toLowerCase();
    // Si ya había una cuenta con ese email, se vincula a Google.
    let user = (await User.findOne({ googleId }).select('+passwordHash')) ?? (await User.findOne({ email: mail }).select('+passwordHash'));
    if (user) {
      user.googleId = googleId;
      if (!user.picture && payload.picture) user.picture = payload.picture;
      await user.save();
    } else {
      user = await User.create({
        email: mail,
        googleId,
        name: (payload.name ?? mail.split('@')[0]!).slice(0, 60),
        picture: payload.picture,
        locale: request.body.locale,
      });
    }
    return { token: app.signToken(user.id), user: userDto(user) };
  });

  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
    const user = await findMe(request.viewerId);
    if (!user) throw notFound('Tu cuenta');
    return userDto(user);
  });

  /** Datos de la cuenta, idioma, tema y criterios de los grupos. */
  app.patch('/auth/me', { preHandler: app.authenticate, schema: { body: UpdateMe } }, async (request) => {
    const user = await User.findByIdAndUpdate(request.viewerId, request.body, { returnDocument: 'after', runValidators: true }).select(
      '+passwordHash',
    );
    if (!user) throw notFound('Tu cuenta');
    return userDto(user);
  });

  app.get('/auth/me/stats', { preHandler: app.authenticate }, async (request) => {
    const owner = request.viewerId;
    const [people, married, linked, occasional, active, groupSets] = await Promise.all([
      Person.countDocuments({ owner }),
      Person.countDocuments({ owner, married: true }),
      Person.countDocuments({ owner, spouse: { $ne: null } }),
      Person.countDocuments({ owner, occasional: true }),
      Person.countDocuments({ owner, active: true }),
      GroupSet.countDocuments({ owner }),
    ]);
    // Un matrimonio vinculado son dos personas; quien está casado sin su pareja en la lista cuenta como uno.
    const couples = linked / 2 + (married - linked);
    return { people, married, couples, occasional, active, groupSets };
  });

  app.put('/auth/me/password', { preHandler: app.authenticate, schema: { body: ChangePassword } }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body;
    const user = await findMe(request.viewerId);
    if (!user) throw notFound('Tu cuenta');
    if (user.passwordHash) {
      // 400 (no 401) para no cerrar la sesión en el cliente.
      if (!currentPassword || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw badRequest('La contraseña actual no es correcta.', 'WRONG_PASSWORD');
      }
      if (currentPassword === newPassword) throw badRequest('La contraseña nueva debe ser distinta de la actual.');
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    return reply.code(204).send();
  });

  /** Borra la cuenta con todas sus personas y grupos guardados. */
  app.delete('/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    const owner = request.viewerId;
    await Promise.all([Person.deleteMany({ owner }), GroupSet.deleteMany({ owner })]);
    await User.deleteOne({ _id: owner });
    return reply.code(204).send();
  });
};
