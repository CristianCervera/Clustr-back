import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { GENDERS } from '../grouping.js';
import { Person } from '../models/person.js';
import { badRequest, notFound } from '../http-errors.js';
import { personDto } from '../serialize.js';
import { IdParams, nameKey, objectId } from './shared.js';

const fields = {
  firstName: z.string().trim().min(1, 'Escribe el nombre.').max(60),
  lastName: z.string().trim().max(80),
  gender: z.enum(GENDERS).nullable(),
  age: z.number().int().min(0).max(120).nullable(),
  married: z.boolean(),
  occasional: z.boolean(),
  phone: z.string().trim().max(40),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Escribe un email válido.')]),
  notes: z.string().trim().max(500),
  active: z.boolean(),
};

const CreatePerson = z.object({
  ...fields,
  lastName: fields.lastName.default(''),
  gender: fields.gender.default(null),
  age: fields.age.default(null),
  married: fields.married.default(false),
  occasional: fields.occasional.default(false),
  phone: fields.phone.default(''),
  email: fields.email.default(''),
  notes: fields.notes.default(''),
  active: fields.active.default(true),
  spouseId: objectId.nullable().optional(),
});

const UpdatePerson = z.object({ ...fields, spouseId: objectId.nullable() }).partial();

const ImportRow = CreatePerson.omit({ spouseId: true }).extend({
  /** Nombre completo del cónyuge tal y como aparece en el Excel. */
  spouseName: z.string().trim().max(140).optional(),
});

const Import = z.object({
  people: z.array(ImportRow).min(1, 'El archivo no tiene personas.').max(2000, 'Como máximo 2000 personas por importación.'),
  /** Borra antes todas las personas de la cuenta. */
  replace: z.boolean().default(false),
});

const SetActive = z.object({ ids: z.array(objectId).max(5000), active: z.boolean() });

/**
 * Vincula a dos personas como matrimonio (o desvincula a `id` si `spouseId` es null).
 * Rompe los vínculos anteriores de ambas para que nunca haya parejas a medias.
 */
async function linkSpouses(owner: string, id: string, spouseId: string | null) {
  if (spouseId === id) throw badRequest('Una persona no puede ser su propio cónyuge.');
  if (spouseId && !(await Person.exists({ _id: spouseId, owner }))) throw notFound('El cónyuge');
  const affected = [id, ...(spouseId ? [spouseId] : [])];
  await Person.updateMany({ owner, spouse: { $in: affected } }, { spouse: null });
  if (!spouseId) {
    await Person.updateOne({ _id: id, owner }, { spouse: null });
    return;
  }
  await Person.updateOne({ _id: id, owner }, { spouse: spouseId, married: true });
  await Person.updateOne({ _id: spouseId, owner }, { spouse: id, married: true });
}

/** Un matrimonio comparte la asistencia: el cónyuge pasa a ser ocasional (o habitual) como `id`. */
async function shareAttendance(owner: string, id: string) {
  const person = await Person.findOne({ _id: id, owner });
  if (person?.spouse) await Person.updateOne({ _id: person.spouse, owner }, { occasional: person.occasional });
}

export const peopleRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/people', async (request) => {
    const people = await Person.find({ owner: request.viewerId }).sort({ firstName: 1, lastName: 1 }).collation({ locale: 'es' });
    return people.map(personDto);
  });

  app.post('/people', { schema: { body: CreatePerson } }, async (request, reply) => {
    const owner = request.viewerId!;
    const { spouseId, ...data } = request.body;
    const person = await Person.create({ ...data, owner });
    if (spouseId) await linkSpouses(owner, person.id, spouseId);
    if (spouseId && data.occasional) await shareAttendance(owner, person.id);
    // Devuelve también al cónyuge, que ha cambiado.
    const changed = await Person.find({ owner, _id: { $in: [person._id, ...(spouseId ? [spouseId] : [])] } });
    return reply.code(201).send({ person: personDto(changed.find((p) => p.id === person.id)!), changed: changed.map(personDto) });
  });

  app.patch('/people/:id', { schema: { params: IdParams, body: UpdatePerson } }, async (request) => {
    const owner = request.viewerId!;
    const { id } = request.params;
    const { spouseId, ...data } = request.body;
    const before = await Person.findOne({ _id: id, owner });
    if (!before) throw notFound('La persona');

    await Person.updateOne({ _id: id, owner }, data, { runValidators: true });
    // Si deja de estar casada, se rompe el vínculo con su cónyuge.
    const nextSpouse = data.married === false ? null : spouseId;
    if (nextSpouse !== undefined) await linkSpouses(owner, id, nextSpouse);
    // Al marcarla (o desmarcarla) como ocasional, o al casarla siendo ocasional, su cónyuge la sigue.
    const occasional = data.occasional ?? before.occasional;
    const newSpouse = Boolean(nextSpouse) && nextSpouse !== before.spouse?.toString();
    if (occasional !== before.occasional || (newSpouse && occasional)) await shareAttendance(owner, id);

    const ids = [id, before.spouse?.toString(), nextSpouse].filter((x): x is string => Boolean(x));
    const changed = await Person.find({ owner, _id: { $in: ids } });
    return { person: personDto(changed.find((p) => p.id === id)!), changed: changed.map(personDto) };
  });

  app.delete('/people/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const owner = request.viewerId;
    const person = await Person.findOneAndDelete({ _id: request.params.id, owner });
    if (!person) throw notFound('La persona');
    await Person.updateMany({ owner, spouse: person._id }, { spouse: null });
    return reply.code(204).send();
  });

  /** Borra todas las personas de la cuenta. */
  app.delete('/people', async (request, reply) => {
    await Person.deleteMany({ owner: request.viewerId });
    return reply.code(204).send();
  });

  /** Marca qué personas participan al generar grupos. */
  app.post('/people/active', { schema: { body: SetActive } }, async (request) => {
    const { ids, active } = request.body;
    const { modifiedCount } = await Person.updateMany({ owner: request.viewerId, _id: { $in: ids } }, { active });
    return { updated: modifiedCount };
  });

  /**
   * Alta masiva desde un Excel ya leído en el cliente. Los matrimonios siempre quedan vinculados:
   * el cónyuge se busca por nombre entre las filas importadas y las personas que ya existían, y si
   * no aparece en ningún sitio se añade a la lista con el nombre escrito en la columna «Cónyuge».
   */
  app.post('/people/import', { schema: { body: Import } }, async (request) => {
    const owner = request.viewerId!;
    const { people, replace } = request.body;
    if (replace) await Person.deleteMany({ owner });

    const created = await Person.insertMany(people.map(({ spouseName: _s, ...p }) => ({ ...p, owner })));
    const all = await Person.find({ owner });
    // Antes las del archivo que las que ya estaban, para no casar a alguien con un homónimo antiguo.
    const createdIds = new Set(created.map((p) => p.id));
    all.sort((a, b) => Number(createdIds.has(b.id)) - Number(createdIds.has(a.id)));

    const done = new Set<string>();
    const free = (p: (typeof all)[number], self: string) => p.id !== self && !done.has(p.id);
    /** Nombre completo exacto; si no, solo el nombre o el principio del nombre completo, cuando no hay dudas. */
    function findSpouse(name: string, self: string) {
      const key = nameKey(name);
      const exact = all.filter((p) => free(p, self) && nameKey(p.firstName, p.lastName) === key);
      if (exact.length) return exact[0];
      for (const match of [
        (p: (typeof all)[number]) => nameKey(p.firstName) === key,
        (p: (typeof all)[number]) => nameKey(p.firstName, p.lastName).startsWith(`${key} `),
      ]) {
        const candidates = all.filter((p) => free(p, self) && match(p));
        if (candidates.length === 1) return candidates[0];
      }
      return undefined;
    }

    let linked = 0;
    const addedSpouses: string[] = [];
    for (const [i, row] of people.entries()) {
      const person = created[i]!;
      if (!row.spouseName || done.has(person.id)) continue;
      let spouse = findSpouse(row.spouseName, person.id);
      if (!spouse) {
        const [firstName = row.spouseName, ...rest] = row.spouseName.split(/\s+/);
        spouse = await Person.create({ owner, firstName: firstName.slice(0, 60), lastName: rest.join(' ').slice(0, 80), married: true });
        addedSpouses.push(row.spouseName);
      }
      await linkSpouses(owner, person.id, spouse.id);
      if (person.occasional || spouse.occasional) await Person.updateMany({ owner, _id: { $in: [person._id, spouse._id] } }, { occasional: true });
      done.add(person.id).add(spouse.id);
      linked++;
    }

    const result = await Person.find({ owner }).sort({ firstName: 1, lastName: 1 }).collation({ locale: 'es' });
    return { created: created.length + addedSpouses.length, couples: linked, addedSpouses, people: result.map(personDto) };
  });
};
