import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { DEFAULT_PREFERENCES, GroupPreferences, groupsWithHeads, makeGroups, type Gender } from '../grouping.js';
import { GroupSet, type GroupSetDoc } from '../models/group-set.js';
import { Person } from '../models/person.js';
import { User } from '../models/user.js';
import { badRequest, notFound } from '../http-errors.js';
import { groupSetDto, personDto } from '../serialize.js';
import { IdParams, objectId } from './shared.js';

const Generate = z.object({
  preferences: GroupPreferences,
  /** Personas a repartir. Sin ella, todas las marcadas como activas. */
  personIds: z.array(objectId).max(5000).optional(),
});

/** Nombre de cada grupo, en orden; vacío para «Grupo N». */
const GroupNames = z.array(z.string().trim().max(40, 'Nombre de grupo demasiado largo.')).max(500);

const SaveSet = z.object({
  name: z.string().trim().min(1, 'Ponle un nombre.').max(80),
  preferences: GroupPreferences,
  /** Ids de las personas de cada grupo, en orden. */
  groups: z.array(z.array(objectId).min(1)).min(1).max(500),
  groupNames: GroupNames.optional(),
});

/** Cambia el nombre del reparto, el de sus grupos o quién va en cada grupo. */
const UpdateSet = z
  .object({
    name: z.string().trim().min(1, 'Ponle un nombre.').max(80).optional(),
    groupNames: GroupNames.optional(),
    /**
     * Nueva composición: para cada grupo, las posiciones de sus miembros en la lista actual de todos
     * los miembros (grupo a grupo, en orden). Cada miembro aparece una sola vez.
     */
    layout: z.array(z.array(z.number().int().min(0)).min(1)).min(1).max(500).optional(),
  })
  .refine((body) => body.name !== undefined || body.groupNames !== undefined || body.layout !== undefined, 'Nada que cambiar.');

/** Reparto «por cabezas»: los miembros de un grupo encabezan cada uno un grupo nuevo con el resto. */
const HeadsSet = z.object({
  /** Posición del grupo cuyos miembros serán los cabezas. */
  group: z.number().int().min(0),
  name: z.string().trim().min(1, 'Ponle un nombre.').max(80),
});

type Snapshot = Record<string, unknown> & { person?: unknown; spouse?: unknown; gender?: string | null; age?: number | null; married?: boolean; occasional?: boolean };

/** Los miembros del reparto, en orden, como copias sueltas. */
const membersOf = (set: GroupSetDoc) => set.groups.flatMap((g) => g.members.map((m) => m.toObject() as Snapshot));

/**
 * Reparte a los miembros de un reparto con los cabezas dados (posiciones en `members`).
 * Trabaja con la copia guardada, así que sirve aunque alguien se haya borrado de la lista.
 */
function headsLayout(members: Snapshot[], heads: number[], preferences: unknown): number[][] {
  const indexOfPerson = new Map(members.flatMap((m, i) => (m.person ? [[String(m.person), String(i)] as const] : [])));
  const people = members.map((m, i) => ({
    id: String(i),
    gender: (m.gender as Gender | null) ?? null,
    age: m.age ?? null,
    married: Boolean(m.married),
    occasional: Boolean(m.occasional),
    spouseId: m.spouse ? (indexOfPerson.get(String(m.spouse)) ?? null) : null,
  }));
  const prefs = GroupPreferences.parse({ ...DEFAULT_PREFERENCES, ...(preferences as object) });
  return groupsWithHeads(people, heads.map(String), prefs).map((g) => g.map(Number));
}

export const groupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /** Calcula un reparto sin guardarlo. Guarda los criterios como preferencias de la cuenta. */
  app.post('/groups/generate', { schema: { body: Generate } }, async (request) => {
    const owner = request.viewerId;
    const { preferences, personIds } = request.body;
    const people = await Person.find(personIds ? { owner, _id: { $in: personIds } } : { owner, active: true });
    if (people.length < 2) throw badRequest('Necesitas al menos 2 personas para hacer grupos.', 'NOT_ENOUGH_PEOPLE');
    await User.updateOne({ _id: owner }, { preferences });

    const ids = makeGroups(
      people.map((p) => ({
        id: p.id,
        gender: p.gender as Gender | null,
        age: p.age,
        married: p.married,
        occasional: p.occasional,
        spouseId: p.spouse?.toString() ?? null,
      })),
      preferences,
    );
    const byId = new Map(people.map((p) => [p.id, personDto(p)]));
    return { groups: ids.map((group) => group.map((id) => byId.get(id)!)) };
  });

  app.get('/group-sets', async (request) => {
    const sets = await GroupSet.find({ owner: request.viewerId }).sort({ createdAt: -1 }).limit(200);
    return sets.map(groupSetDto);
  });

  app.get('/group-sets/:id', { schema: { params: IdParams } }, async (request) => {
    const set = await GroupSet.findOne({ _id: request.params.id, owner: request.viewerId });
    if (!set) throw notFound('El reparto');
    return groupSetDto(set);
  });

  /** Guarda un reparto (quizá retocado a mano) con una copia de los datos de cada persona. */
  app.post('/group-sets', { schema: { body: SaveSet } }, async (request, reply) => {
    const owner = request.viewerId;
    const { name, preferences, groups, groupNames = [] } = request.body;
    const ids = groups.flat();
    if (new Set(ids).size !== ids.length) throw badRequest('Una persona aparece en más de un grupo.');
    const people = new Map((await Person.find({ owner, _id: { $in: ids } })).map((p) => [p.id, p]));
    if (people.size !== ids.length) throw badRequest('Alguna persona del reparto ya no existe. Vuelve a generar los grupos.');

    const set = await GroupSet.create({
      owner,
      name,
      preferences,
      groups: groups.map((group, i) => ({
        name: groupNames[i] ?? '',
        members: group.map((id) => {
          const p = people.get(id)!;
          return { person: p._id, firstName: p.firstName, lastName: p.lastName, gender: p.gender, age: p.age, married: p.married, occasional: p.occasional, spouse: p.spouse };
        }),
      })),
    });
    return reply.code(201).send(groupSetDto(set));
  });

  /** Crea un reparto nuevo en el que cada miembro del grupo elegido encabeza un grupo con el resto. */
  app.post('/group-sets/:id/heads', { schema: { params: IdParams, body: HeadsSet } }, async (request, reply) => {
    const source = await GroupSet.findOne({ _id: request.params.id, owner: request.viewerId });
    if (!source) throw notFound('El reparto');
    const { group, name } = request.body;
    const chosen = source.groups[group];
    if (!chosen) throw badRequest('Ese grupo no existe.');
    const members = membersOf(source);
    const start = source.groups.slice(0, group).reduce((n, g) => n + g.members.length, 0);
    const heads = chosen.members.map((_, i) => start + i);
    if (heads.length < 2) throw badRequest('El grupo necesita al menos 2 personas para repartir por cabezas.', 'NOT_ENOUGH_HEADS');
    if (members.length === heads.length) throw badRequest('No queda nadie fuera de ese grupo para repartir.', 'NOT_ENOUGH_PEOPLE');

    const preferences = { ...DEFAULT_PREFERENCES, ...(source.preferences as object), mode: 'count', value: heads.length };
    const layout = headsLayout(members, heads, preferences);
    const set = await GroupSet.create({
      owner: request.viewerId,
      name,
      preferences,
      groups: layout.map((g) => ({ name: '', members: g.map((j, pos) => ({ ...members[j], head: pos === 0 })) })),
    });
    return reply.code(201).send(groupSetDto(set));
  });

  /** Vuelve a mezclar un reparto por cabezas: los cabezas se quedan y cada grupo conserva el nombre de su cabeza. */
  app.post('/group-sets/:id/remix', { schema: { params: IdParams } }, async (request) => {
    const set = await GroupSet.findOne({ _id: request.params.id, owner: request.viewerId });
    if (!set) throw notFound('El reparto');
    const members = membersOf(set);
    const heads = members.flatMap((m, i) => (m.head ? [i] : []));
    if (!heads.length) throw badRequest('Este reparto no tiene cabezas.', 'NO_HEADS');
    if (members.length === heads.length) throw badRequest('No queda nadie para repartir.', 'NOT_ENOUGH_PEOPLE');

    // El nombre de cada grupo sigue a su cabeza (al primero, si alguien juntó a dos).
    const nameOfHead = new Map<number, string>();
    let i = 0;
    for (const g of set.groups) {
      const head = g.members.findIndex((m) => m.head);
      if (head >= 0) nameOfHead.set(i + head, g.name ?? '');
      i += g.members.length;
    }
    const layout = headsLayout(members, heads, { ...(set.preferences as object), mode: 'count', value: heads.length });
    set.set('groups', layout.map((g) => ({ name: nameOfHead.get(g[0]!) ?? '', members: g.map((j) => members[j]) })));
    await set.save();
    return groupSetDto(set);
  });

  app.patch('/group-sets/:id', { schema: { params: IdParams, body: UpdateSet } }, async (request) => {
    const { name, groupNames, layout } = request.body;
    const set = await GroupSet.findOne({ _id: request.params.id, owner: request.viewerId });
    if (!set) throw notFound('El reparto');
    if (layout) {
      const members = set.groups.flatMap((g) => g.members.map((m) => m.toObject()));
      const used = layout.flat();
      if (used.length !== members.length || new Set(used).size !== used.length || used.some((i) => i >= members.length))
        throw badRequest('La nueva composición no coincide con los miembros del reparto.');
      // Los nombres siguen a la posición del grupo.
      const names = set.groups.map((g) => g.name ?? '');
      set.set('groups', layout.map((group, i) => ({ name: names[i] ?? '', members: group.map((j) => members[j]) })));
    }
    if (groupNames && groupNames.length !== set.groups.length) throw badRequest('El número de nombres no coincide con el de grupos.');
    if (name !== undefined) set.name = name;
    groupNames?.forEach((groupName, i) => (set.groups[i]!.name = groupName));
    await set.save();
    return groupSetDto(set);
  });

  app.delete('/group-sets/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const { deletedCount } = await GroupSet.deleteOne({ _id: request.params.id, owner: request.viewerId });
    if (!deletedCount) throw notFound('El reparto');
    return reply.code(204).send();
  });
};
