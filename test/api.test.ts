import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDb, type Database } from '../src/db.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Database;
let token: string;

const auth = (t = token) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  db = await connectDb();
  app = await buildApp(loadConfig({ NODE_ENV: 'test' }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('auth', () => {
  it('registra, inicia sesión y devuelve el perfil', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'Ana@Example.com', password: 'secreta123', name: 'Ana', locale: 'it' },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().user).toMatchObject({ email: 'ana@example.com', locale: 'it', hasPassword: true, hasGoogle: false });

    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ana@example.com', password: 'otra12345', name: 'X' } });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@example.com', password: 'mala' } });
    expect(bad.statusCode).toBe(401);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@example.com', password: 'secreta123' } });
    expect(login.statusCode).toBe(200);
    token = login.json().token;

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() });
    expect(me.json()).toMatchObject({ name: 'Ana', theme: 'system', preferences: { mode: 'count', couples: 'together' } });
  });

  it('guarda idioma, tema y preferencias', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: auth(),
      payload: { theme: 'dark', locale: 'fr', preferences: { mode: 'size', value: 5, couples: 'apart', balanceGender: false, balanceAge: true, mixMarital: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ theme: 'dark', locale: 'fr', preferences: { mode: 'size', value: 5, couples: 'apart' } });
  });

  it('sin Google configurado responde 503', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/google', payload: { credential: 'x' } });
    expect(res.statusCode).toBe(503);
  });

  it('rechaza peticiones sin token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/people' })).statusCode).toBe(401);
  });
});

describe('personas', () => {
  it('crea personas y vincula matrimonios en ambos sentidos', async () => {
    const juan = await app.inject({ method: 'POST', url: '/api/people', headers: auth(), payload: { firstName: 'Juan', lastName: 'Pérez', gender: 'male', age: 40 } });
    expect(juan.statusCode).toBe(201);
    const juanId = juan.json().person.id;

    const maria = await app.inject({
      method: 'POST',
      url: '/api/people',
      headers: auth(),
      payload: { firstName: 'María', lastName: 'López', gender: 'female', age: 38, spouseId: juanId },
    });
    const { person, changed } = maria.json();
    expect(person).toMatchObject({ married: true, spouseId: juanId });
    expect(changed.find((p: { id: string }) => p.id === juanId)).toMatchObject({ married: true, spouseId: person.id });

    // Marcar a uno como ocasional marca también a su cónyuge, y desmarcarlo lo desmarca.
    // Como lo envía la ficha: todos los campos, con el mismo cónyuge.
    const juanNow = changed.find((p: { id: string }) => p.id === juanId);
    const { id: _id, ...juanForm } = { ...juanNow, occasional: true };
    const occ = await app.inject({ method: 'PATCH', url: `/api/people/${juanId}`, headers: auth(), payload: juanForm });
    expect(occ.json().changed.find((p: { id: string }) => p.id === person.id).occasional).toBe(true);
    const reg = await app.inject({ method: 'PATCH', url: `/api/people/${person.id}`, headers: auth(), payload: { occasional: false } });
    expect(reg.json().changed.find((p: { id: string }) => p.id === juanId).occasional).toBe(false);

    // Al dejar de estar casada se rompe el vínculo en los dos.
    const single = await app.inject({ method: 'PATCH', url: `/api/people/${person.id}`, headers: auth(), payload: { married: false } });
    expect(single.json().changed.find((p: { id: string }) => p.id === juanId).spouseId).toBeNull();
  });

  it('importa desde Excel y vincula siempre a los matrimonios', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/import',
      headers: auth(),
      payload: {
        replace: true,
        people: [
          { firstName: 'Luis', lastName: 'García', gender: 'male', married: true, spouseName: 'Lucía Martín' },
          { firstName: 'Lucía', lastName: 'Martín', gender: 'female', married: true, spouseName: 'Luis Garcia' },
          // Solo el nombre basta si no hay otra Sara.
          { firstName: 'Pedro', gender: 'male', married: true, spouseName: 'Sara' },
          { firstName: 'Sara', lastName: 'Ruiz', gender: 'female', occasional: true },
          // Marta no tiene fila propia: se añade a la lista.
          { firstName: 'Tomás', gender: 'male', married: true, spouseName: 'Marta Gil Soto' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: 6, couples: 3, addedSpouses: ['Marta Gil Soto'] });
    expect(body.people).toHaveLength(6);
    const byName = (name: string) => body.people.find((p: { firstName: string }) => p.firstName === name);
    expect(byName('Luis').spouseId).toBe(byName('Lucía').id);
    expect(byName('Pedro').spouseId).toBe(byName('Sara').id);
    expect(byName('Sara')).toMatchObject({ married: true, occasional: true, spouseId: byName('Pedro').id });
    // Un matrimonio comparte la asistencia.
    expect(byName('Pedro').occasional).toBe(true);
    expect(byName('Luis').occasional).toBe(false);
    expect(byName('Marta')).toMatchObject({ lastName: 'Gil Soto', married: true, spouseId: byName('Tomás').id });
  });
});

describe('grupos', () => {
  it('genera, guarda, lista y borra un reparto', async () => {
    const gen = await app.inject({
      method: 'POST',
      url: '/api/groups/generate',
      headers: auth(),
      payload: { preferences: { mode: 'count', value: 2, couples: 'together', balanceGender: true, balanceAge: false, mixMarital: true } },
    });
    expect(gen.statusCode).toBe(200);
    const groups: { id: string; firstName: string }[][] = gen.json().groups;
    expect(groups).toHaveLength(2);
    expect(groups.flat()).toHaveLength(6);
    const withLuis = groups.find((g) => g.some((p) => p.firstName === 'Luis'))!;
    expect(withLuis.some((p) => p.firstName === 'Lucía')).toBe(true);

    const save = await app.inject({
      method: 'POST',
      url: '/api/group-sets',
      headers: auth(),
      payload: { name: 'Retiro', preferences: { mode: 'count', value: 2 }, groups: groups.map((g) => g.map((p) => p.id)), groupNames: ['Los leones', ''] },
    });
    expect(save.statusCode).toBe(201);
    const set = save.json();
    expect(set.groupNames).toEqual(['Los leones', '']);

    // Los nombres de los grupos se pueden cambiar después, con o sin el del reparto.
    const renamed = await app.inject({ method: 'PATCH', url: `/api/group-sets/${set.id}`, headers: auth(), payload: { groupNames: ['', 'Las águilas'] } });
    expect(renamed.json()).toMatchObject({ name: 'Retiro', groupNames: ['', 'Las águilas'] });
    expect(renamed.json().groups.flat()).toHaveLength(6);
    const wrong = await app.inject({ method: 'PATCH', url: `/api/group-sets/${set.id}`, headers: auth(), payload: { groupNames: ['Solo uno'] } });
    expect(wrong.statusCode).toBe(400);

    // Mover al primer miembro del grupo 1 al grupo 2: la composición se da por posiciones.
    const sizes = set.groups.map((g: unknown[]) => g.length);
    const first = Array.from({ length: sizes[0] }, (_, i) => i);
    const second = Array.from({ length: sizes[1] }, (_, i) => sizes[0] + i);
    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/group-sets/${set.id}`,
      headers: auth(),
      payload: { layout: [first.slice(1), [...second, first[0]]] },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().groups.map((g: unknown[]) => g.length)).toEqual([sizes[0] - 1, sizes[1] + 1]);
    expect(moved.json().groups[1].at(-1)).toEqual(set.groups[0][0]);
    expect(moved.json().groupNames).toEqual(['', 'Las águilas']);
    const dup = await app.inject({ method: 'PATCH', url: `/api/group-sets/${set.id}`, headers: auth(), payload: { layout: [[0, 0]] } });
    expect(dup.statusCode).toBe(400);
    expect(set.groups.flat()).toHaveLength(6);
    // La copia guardada conserva la asistencia de cada persona.
    expect(set.groups.flat().find((m: { firstName: string }) => m.firstName === 'Sara').occasional).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/group-sets', headers: auth() });
    expect(list.json()).toHaveLength(1);

    const stats = await app.inject({ method: 'GET', url: '/api/auth/me/stats', headers: auth() });
    // 6 casados forman 3 matrimonios; Sara y Pedro, ocasionales.
    expect(stats.json()).toMatchObject({ people: 6, married: 6, couples: 3, occasional: 2, groupSets: 1 });

    expect((await app.inject({ method: 'DELETE', url: `/api/group-sets/${set.id}`, headers: auth() })).statusCode).toBe(204);
  });

  it('reparte por cabezas en un reparto nuevo y vuelve a mezclar conservando a los cabezas', async () => {
    const people: { id: string; firstName: string }[] = (await app.inject({ method: 'GET', url: '/api/people', headers: auth() })).json();
    const id = (name: string) => people.find((p) => p.firstName === name)!.id;
    const rest = people.filter((p) => !['Luis', 'Pedro'].includes(p.firstName)).map((p) => p.id);
    const source = (
      await app.inject({
        method: 'POST',
        url: '/api/group-sets',
        headers: auth(),
        payload: { name: 'Base', preferences: { mode: 'count', value: 2, couples: 'together' }, groups: [[id('Luis'), id('Pedro')], rest], groupNames: ['Cabezas', ''] },
      })
    ).json();

    const res = await app.inject({ method: 'POST', url: `/api/group-sets/${source.id}/heads`, headers: auth(), payload: { group: 0, name: 'Base · por cabezas' } });
    expect(res.statusCode).toBe(201);
    const set = res.json();
    expect(set.id).not.toBe(source.id);
    expect(set.groups).toHaveLength(2);
    expect(set.groups.flat()).toHaveLength(6);
    expect(set.preferences).toMatchObject({ mode: 'count', value: 2 });
    // El cabeza va el primero y marcado; con «juntos», su cónyuge va con él.
    const groupOf = (name: string) => set.groups.find((g: { firstName: string }[]) => g.some((m) => m.firstName === name));
    for (const [head, spouse] of [['Luis', 'Lucía'], ['Pedro', 'Sara']] as const) {
      expect(groupOf(head)[0]).toMatchObject({ firstName: head, head: true });
      expect(groupOf(head).some((m: { firstName: string }) => m.firstName === spouse)).toBe(true);
    }
    expect(set.groups.flat().filter((m: { head: boolean }) => m.head)).toHaveLength(2);

    // El original no cambia.
    const original = (await app.inject({ method: 'GET', url: `/api/group-sets/${source.id}`, headers: auth() })).json();
    expect(original.groups.map((g: unknown[]) => g.length)).toEqual([2, 4]);

    // Volver a mezclar: los mismos cabezas, y el nombre de cada grupo sigue a su cabeza.
    const named = await app.inject({ method: 'PATCH', url: `/api/group-sets/${set.id}`, headers: auth(), payload: { groupNames: set.groups.map((g: { firstName: string }[]) => `Con ${g[0]!.firstName}`) } });
    expect(named.statusCode).toBe(200);
    const remix = await app.inject({ method: 'POST', url: `/api/group-sets/${set.id}/remix`, headers: auth() });
    expect(remix.statusCode).toBe(200);
    remix.json().groups.forEach((g: { firstName: string; head: boolean }[], i: number) => {
      expect(g[0]!.head).toBe(true);
      expect(remix.json().groupNames[i]).toBe(`Con ${g[0]!.firstName}`);
    });

    // Preguntando: «separados» deja a cada cabeza en su grupo; «juntos» hace que un matrimonio cabeza encabece uno solo.
    const couple = (
      await app.inject({
        method: 'POST',
        url: '/api/group-sets',
        headers: auth(),
        payload: { name: 'Pareja', preferences: { mode: 'count', value: 2 }, groups: [[id('Luis'), id('Lucía'), id('Pedro')], people.filter((p) => !['Luis', 'Lucía', 'Pedro'].includes(p.firstName)).map((p) => p.id)] },
      })
    ).json();
    const apart = (await app.inject({ method: 'POST', url: `/api/group-sets/${couple.id}/heads`, headers: auth(), payload: { group: 0, name: 'S', couples: 'apart' } })).json();
    expect(apart.groups).toHaveLength(3);
    expect(apart.preferences.couples).toBe('apart');
    const together = (await app.inject({ method: 'POST', url: `/api/group-sets/${couple.id}/heads`, headers: auth(), payload: { group: 0, name: 'J', couples: 'together' } })).json();
    expect(together.groups).toHaveLength(2);
    const lead = together.groups.find((g: { firstName: string }[]) => g.some((m) => m.firstName === 'Luis'));
    expect(lead.slice(0, 2).map((m: { firstName: string; head: boolean }) => [m.firstName, m.head]).sort()).toEqual([['Lucía', true], ['Luis', true]]);
    // Pedro encabeza el otro; Sara, su mujer, va con él.
    const pedro = together.groups.find((g: { firstName: string }[]) => g[0]!.firstName === 'Pedro');
    expect(pedro.some((m: { firstName: string }) => m.firstName === 'Sara')).toBe(true);
    for (const s of [couple.id, apart.id, together.id]) await app.inject({ method: 'DELETE', url: `/api/group-sets/${s}`, headers: auth() });

    // Un grupo de una persona no sirve, y un reparto sin cabezas no se puede volver a mezclar.
    const lonely = await app.inject({ method: 'PATCH', url: `/api/group-sets/${source.id}`, headers: auth(), payload: { layout: [[0], [1, 2, 3, 4, 5]] } });
    expect(lonely.statusCode).toBe(200);
    const tooSmall = await app.inject({ method: 'POST', url: `/api/group-sets/${source.id}/heads`, headers: auth(), payload: { group: 0, name: 'X' } });
    expect(tooSmall.json()).toMatchObject({ error: 'NOT_ENOUGH_HEADS' });
    expect((await app.inject({ method: 'POST', url: `/api/group-sets/${source.id}/remix`, headers: auth() })).statusCode).toBe(400);

    for (const s of [source.id, set.id]) await app.inject({ method: 'DELETE', url: `/api/group-sets/${s}`, headers: auth() });
  });

  it('guarda responsables al crear y un matrimonio responsable sigue encabezando junto', async () => {
    const people: { id: string; firstName: string }[] = (await app.inject({ method: 'GET', url: '/api/people', headers: auth() })).json();
    const id = (name: string) => people.find((p) => p.firstName === name)!.id;
    const save = await app.inject({
      method: 'POST',
      url: '/api/group-sets',
      headers: auth(),
      payload: {
        name: 'Con responsables',
        preferences: { mode: 'count', value: 2, leaders: true },
        groups: [
          [id('Luis'), id('Lucía'), id('Marta')],
          [id('Pedro'), id('Sara'), id('Tomás')],
        ],
        heads: [id('Luis'), id('Lucía'), id('Pedro')],
      },
    });
    expect(save.statusCode).toBe(201);
    const set = save.json();
    expect(set.preferences.leaders).toBe(true);
    expect(set.groups.flat().filter((m: { head: boolean }) => m.head).map((m: { firstName: string }) => m.firstName).sort()).toEqual(['Lucía', 'Luis', 'Pedro']);

    // Volver a mezclar: siguen siendo 2 grupos, y Luis y Lucía encabezan el mismo.
    const remix = (await app.inject({ method: 'POST', url: `/api/group-sets/${set.id}/remix`, headers: auth() })).json();
    expect(remix.groups).toHaveLength(2);
    const theirs = remix.groups.find((g: { firstName: string }[]) => g.some((m) => m.firstName === 'Luis'));
    expect(theirs.slice(0, 2).map((m: { firstName: string }) => m.firstName).sort()).toEqual(['Lucía', 'Luis']);
    expect(remix.groups.flat()).toHaveLength(6);

    await app.inject({ method: 'DELETE', url: `/api/group-sets/${set.id}`, headers: auth() });
  });

  it('pide al menos 2 personas', async () => {
    const people = (await app.inject({ method: 'GET', url: '/api/people', headers: auth() })).json();
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/generate',
      headers: auth(),
      payload: { personIds: [people[0].id], preferences: { mode: 'count', value: 2, couples: 'any', balanceGender: false, balanceAge: false, mixMarital: false } },
    });
    expect(res.statusCode).toBe(400);
  });
});

// Después de los grupos: reemplaza la lista que usan los tests anteriores.
describe('importación de matrimonios en una fila', () => {
  it('vincula a cada matrimonio escrito en una fila con su pareja aunque se repitan los nombres', async () => {
    // Así llegan del cliente «Jorge y María» y «Pedro y María» sin apellidos.
    const res = await app.inject({
      method: 'POST',
      url: '/api/people/import',
      headers: auth(),
      payload: {
        replace: true,
        people: [
          { firstName: 'Jorge', married: true, spouseName: 'María' },
          { firstName: 'María', married: true, spouseName: 'Jorge' },
          { firstName: 'Pedro', married: true, spouseName: 'María' },
          { firstName: 'María', married: true, spouseName: 'Pedro' },
        ],
      },
    });
    expect(res.json()).toMatchObject({ created: 4, couples: 2, addedSpouses: [] });
    const people: { id: string; firstName: string; spouseId: string | null }[] = res.json().people;
    const [jorge, pedro] = ['Jorge', 'Pedro'].map((n) => people.find((p) => p.firstName === n)!);
    expect(jorge!.spouseId).not.toBe(pedro!.spouseId);
    for (const p of [jorge!, pedro!]) expect(people.find((x) => x.id === p.spouseId)).toMatchObject({ firstName: 'María', spouseId: p.id });
  });
});

describe('cuenta', () => {
  it('borrar la cuenta borra sus datos', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/auth/me', headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() })).statusCode).toBe(401);
  });
});
