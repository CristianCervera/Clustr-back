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
  /** Responsables elegidos a mano: uno por grupo (o un matrimonio); el resto se reparte entre ellos. */
  headIds: z.array(objectId).max(500).optional(),
});

/** Nombre de cada grupo, en orden; vacío para «Grupo N». */
const GroupNames = z.array(z.string().trim().max(40, 'Nombre de grupo demasiado largo.')).max(500);

const SaveSet = z.object({
  name: z.string().trim().min(1, 'Ponle un nombre.').max(80),
  preferences: GroupPreferences,
  /** Ids de las personas de cada grupo, en orden. */
  groups: z.array(z.array(objectId).min(1)).min(1).max(500),
  groupNames: GroupNames.optional(),
  /** Personas que encabezan su grupo (responsables). */
  heads: z.array(objectId).max(5000).optional(),
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
  /**
   * Juntos: un matrimonio del grupo elegido encabeza un mismo grupo y el resto de matrimonios van juntos.
   * Separados: cada cabeza lleva su grupo y los matrimonios van en grupos distintos. Sin él, los criterios del reparto.
   */
  couples: z.enum(['together', 'apart']).optional(),
});

type Snapshot = Record<string, unknown> & { person?: unknown; spouse?: unknown; gender?: string | null; age?: number | null; married?: boolean; occasional?: boolean };

/** Los miembros del reparto, en orden, como copias sueltas. */
const membersOf = (set: GroupSetDoc) => set.groups.flatMap((g) => g.members.map((m) => m.toObject() as Snapshot));

/**
 * Reparte a los miembros de un reparto con los cabezas dados (posiciones en `members`).
 * Trabaja con la copia guardada, así que sirve aunque alguien se haya borrado de la lista.
 */
function headsLayout(members: Snapshot[], heads: number[][], preferences: unknown): number[][] {
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
  return groupsWithHeads(people, heads.map((unit) => unit.map(String)), prefs).map((g) => g.map(Number));
}

export const groupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /** Calcula un reparto sin guardarlo. Guarda los criterios como preferencias de la cuenta. */
  app.post('/groups/generate', { schema: { body: Generate } }, async (request) => {
    const owner = request.viewerId;
    const { preferences, personIds, headIds } = request.body;
    // Los responsables cuentan aunque no estén entre los participantes marcados.
    const filter = personIds ? { _id: { $in: [...personIds, ...(headIds ?? [])] } } : { $or: [{ active: true }, { _id: { $in: headIds ?? [] } }] };
    const people = await Person.find({ owner, ...filter });
    if (people.length < 2) throw badRequest('Necesitas al menos 2 personas para hacer grupos.', 'NOT_ENOUGH_PEOPLE');
    await User.updateOne({ _id: owner }, { preferences });

    const grouping = people.map((p) => ({
      id: p.id,
      gender: p.gender as Gender | null,
      age: p.age,
      married: p.married,
      occasional: p.occasional,
      spouseId: p.spouse?.toString() ?? null,
    }));
    let ids: string[][];
    if (headIds?.length) {
      const heads = [...new Set(headIds)].filter((id) => grouping.some((p) => p.id === id));
      // Un matrimonio elegido encabeza siempre un mismo grupo, sea cual sea el criterio de matrimonios.
      const units: string[][] = [];
      const placed = new Set<string>();
      for (const id of heads) {
        if (placed.has(id)) continue;
        placed.add(id);
        const spouse = grouping.find((p) => p.id === id)?.spouseId;
        const pair = spouse && heads.includes(spouse) && !placed.has(spouse) ? spouse : null;
        if (pair) placed.add(pair);
        units.push(pair ? [id, pair] : [id]);
      }
      if (units.length < 2) throw badRequest('Elige al menos 2 responsables (o dos grupos de responsables).', 'NOT_ENOUGH_HEADS');
      if (grouping.length === heads.length) throw badRequest('No queda nadie para repartir entre los responsables.', 'NOT_ENOUGH_PEOPLE');
      ids = groupsWithHeads(grouping, units, { ...preferences, mode: 'count', value: units.length });
    } else {
      ids = makeGroups(grouping, preferences);
    }
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
    const { name, preferences, groups, groupNames = [], heads = [] } = request.body;
    const isHead = new Set(heads);
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
          return { person: p._id, firstName: p.firstName, lastName: p.lastName, gender: p.gender, age: p.age, married: p.married, occasional: p.occasional, spouse: p.spouse, head: isHead.has(id) };
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

    const couples = request.body.couples ?? ((source.preferences as { couples?: string } | null)?.couples === 'apart' ? 'apart' : 'together');
    // Con «juntos», un matrimonio del grupo elegido encabeza un mismo grupo.
    const units: number[][] = [];
    const placed = new Set<number>();
    for (const h of heads) {
      if (placed.has(h)) continue;
      placed.add(h);
      const spouse = couples === 'together' ? heads.find((o) => !placed.has(o) && members[h]!.spouse && String(members[o]!.person) === String(members[h]!.spouse)) : undefined;
      if (spouse !== undefined) placed.add(spouse);
      units.push(spouse !== undefined ? [h, spouse] : [h]);
    }
    if (units.length < 2) throw badRequest('Con los matrimonios juntos solo saldría un grupo.', 'NOT_ENOUGH_HEADS');

    const preferences = { ...DEFAULT_PREFERENCES, ...(source.preferences as object), couples, mode: 'count', value: units.length };
    const isHead = new Set(heads);
    const layout = headsLayout(members, units, preferences);
    const set = await GroupSet.create({
      owner: request.viewerId,
      name,
      preferences,
      groups: layout.map((g) => ({ name: '', members: g.map((j) => ({ ...members[j], head: isHead.has(j) })) })),
    });
    return reply.code(201).send(groupSetDto(set));
  });

  /** Vuelve a mezclar un reparto por cabezas: los cabezas se quedan y cada grupo conserva el nombre de su cabeza. */
  app.post('/group-sets/:id/remix', { schema: { params: IdParams } }, async (request) => {
    const set = await GroupSet.findOne({ _id: request.params.id, owner: request.viewerId });
    if (!set) throw notFound('El reparto');
    // Los cabezas de un mismo grupo (un matrimonio responsable, p. ej.) siguen encabezando juntos.
    const members = membersOf(set);
    const units: number[][] = [];
    const names: string[] = [];
    let start = 0;
    for (const g of set.groups) {
      const unit = g.members.flatMap((m, i) => (m.head ? [start + i] : []));
      if (unit.length) {
        units.push(unit);
        names.push(g.name ?? '');
      }
      start += g.members.length;
    }
    if (!units.length) throw badRequest('Este reparto no tiene cabezas.', 'NO_HEADS');
    if (members.length === units.flat().length) throw badRequest('No queda nadie para repartir.', 'NOT_ENOUGH_PEOPLE');

    // El nombre de cada grupo sigue a sus cabezas.
    const nameOf = new Map(units.map((unit, u) => [unit[0]!, names[u]!]));
    const layout = headsLayout(members, units, { ...(set.preferences as object), mode: 'count', value: units.length });
    set.set('groups', layout.map((g) => ({ name: nameOf.get(g[0]!) ?? '', members: g.map((j) => members[j]) })));
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
