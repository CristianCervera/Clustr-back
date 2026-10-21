import { z } from 'zod';

export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

/** Qué hacer con los matrimonios: juntos en el mismo grupo, en grupos distintos o sin preferencia. */
export const COUPLE_MODES = ['together', 'apart', 'any'] as const;

export const GroupPreferences = z.object({
  /** `count`: `value` es el número de grupos. `size`: `value` es el número de personas por grupo. */
  mode: z.enum(['count', 'size']).default('count'),
  value: z.number().int().min(1).max(500).default(4),
  couples: z.enum(COUPLE_MODES).default('together'),
  balanceGender: z.boolean().default(true),
  balanceAge: z.boolean().default(false),
  /** Repartir solteros y casados de forma proporcional entre los grupos. */
  mixMarital: z.boolean().default(true),
  /** Repartir a los ocasionales (quienes no suelen venir) para que ningún grupo dependa de ellos. */
  spreadOccasional: z.boolean().default(true),
  /** Al crear, el primero de cada grupo (o su matrimonio) queda como cabeza del grupo. */
  leaders: z.boolean().default(false),
});
export type GroupPreferences = z.infer<typeof GroupPreferences>;

export const DEFAULT_PREFERENCES: GroupPreferences = GroupPreferences.parse({});

export interface GroupingPerson {
  id: string;
  gender?: Gender | null;
  age?: number | null;
  married: boolean;
  /** No suele venir. */
  occasional?: boolean;
  /** Solo cuenta si el cónyuge también está entre las personas a repartir. */
  spouseId?: string | null;
}

type Unit = GroupingPerson[];

interface Stats {
  maleShare: number;
  marriedShare: number;
  occasionalShare: number;
  ageMean: number;
  ageStd: number;
}

/** Generador pseudoaleatorio con semilla, para tests reproducibles. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Número de grupos resultante para `total` personas. Nunca hay más grupos que unidades a repartir. */
export function groupCount(total: number, units: number, prefs: Pick<GroupPreferences, 'mode' | 'value'>): number {
  if (total === 0) return 0;
  const wanted = prefs.mode === 'count' ? prefs.value : Math.round(total / prefs.value);
  return Math.max(1, Math.min(wanted, units));
}

function statsOf(people: GroupingPerson[]): Stats {
  const gendered = people.filter((p) => p.gender);
  const ages = people.map((p) => p.age).filter((a): a is number => typeof a === 'number');
  const ageMean = ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : 0;
  const variance = ages.length ? ages.reduce((s, a) => s + (a - ageMean) ** 2, 0) / ages.length : 0;
  return {
    maleShare: gendered.length ? gendered.filter((p) => p.gender === 'male').length / gendered.length : 0,
    marriedShare: people.length ? people.filter((p) => p.married).length / people.length : 0,
    occasionalShare: people.length ? people.filter((p) => p.occasional).length / people.length : 0,
    ageMean,
    ageStd: Math.sqrt(variance),
  };
}

/**
 * Coste de un grupo: cuanto más se aleja de su tamaño objetivo y de las proporciones globales
 * (sexo, estado civil, ocasionales, edad), más alto. Los pesos priorizan el tamaño sobre el equilibrio.
 */
function groupCost(members: GroupingPerson[], target: number, prefs: GroupPreferences, stats: Stats): number {
  let cost = 50 * (members.length - target) ** 2;

  if (prefs.balanceGender) {
    const males = members.filter((p) => p.gender === 'male').length;
    const gendered = members.filter((p) => p.gender).length;
    cost += 4 * (males - stats.maleShare * gendered) ** 2;
  }
  if (prefs.mixMarital) {
    const married = members.filter((p) => p.married).length;
    cost += 3 * (married - stats.marriedShare * members.length) ** 2;
  }
  if (prefs.spreadOccasional) {
    // Más peso que el resto de equilibrios: un grupo con varios ocasionales se queda cojo.
    const occasional = members.filter((p) => p.occasional).length;
    cost += 6 * (occasional - stats.occasionalShare * members.length) ** 2;
  }
  if (prefs.balanceAge && stats.ageStd > 0) {
    const ages = members.map((p) => p.age).filter((a): a is number => typeof a === 'number');
    if (ages.length) {
      const mean = ages.reduce((s, a) => s + a, 0) / ages.length;
      cost += 3 * ages.length * ((mean - stats.ageMean) / stats.ageStd) ** 2;
    }
  }
  if (prefs.couples === 'apart') {
    const ids = new Set(members.map((p) => p.id));
    const together = members.filter((p) => p.spouseId && ids.has(p.spouseId)).length / 2;
    cost += 500 * together;
  }
  return cost;
}

/**
 * Reparte a las personas en grupos según las preferencias. Devuelve los ids de cada grupo.
 * Primero coloca cada unidad (persona o matrimonio) en el grupo donde menos coste añade
 * y después mejora el reparto intercambiando unidades entre grupos.
 */
export function makeGroups(people: GroupingPerson[], prefs: GroupPreferences, rng: () => number = Math.random): string[][] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const units: Unit[] = [];
  const placed = new Set<string>();
  for (const person of people) {
    if (placed.has(person.id)) continue;
    placed.add(person.id);
    const spouse = prefs.couples === 'together' && person.spouseId ? byId.get(person.spouseId) : undefined;
    if (spouse && !placed.has(spouse.id)) {
      placed.add(spouse.id);
      units.push([person, spouse]);
    } else {
      units.push([person]);
    }
  }

  const k = groupCount(people.length, units.length, prefs);
  if (k === 0) return [];

  const base = Math.floor(people.length / k);
  const targets = Array.from({ length: k }, (_, i) => base + (i < people.length % k ? 1 : 0));
  const stats = statsOf(people);
  const groups: Unit[][] = Array.from({ length: k }, () => []);
  const members = (g: Unit[]) => g.flat();
  const cost = (g: Unit[], i: number) => groupCost(members(g), targets[i]!, prefs, stats);

  // Los matrimonios primero: son las piezas grandes y luego es más difícil encajarlas.
  const ordered = [...shuffle(units.filter((u) => u.length > 1), rng), ...shuffle(units.filter((u) => u.length === 1), rng)];
  for (const unit of ordered) {
    let best = 0;
    let bestDelta = Infinity;
    groups.forEach((g, i) => {
      const delta = cost([...g, unit], i) - cost(g, i) + rng() * 0.01;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    });
    groups[best]!.push(unit);
  }

  if (k > 1) {
    const attempts = 60 * units.length;
    for (let n = 0; n < attempts; n++) {
      const a = Math.floor(rng() * k);
      const b = (a + 1 + Math.floor(rng() * (k - 1))) % k;
      const ga = groups[a]!;
      const gb = groups[b]!;
      if (!ga.length) continue;
      const ia = Math.floor(rng() * ga.length);
      const ua = ga[ia]!;
      const before = cost(ga, a) + cost(gb, b);

      // Intercambio con una unidad de B, o traslado si B está vacío o tocó probarlo.
      const ib = gb.length && rng() < 0.8 ? Math.floor(rng() * gb.length) : -1;
      const nextA = ga.filter((_, i) => i !== ia);
      const nextB = ib >= 0 ? gb.filter((_, i) => i !== ib) : [...gb];
      if (ib >= 0) nextA.push(gb[ib]!);
      nextB.push(ua);
      if (cost(nextA, a) + cost(nextB, b) < before - 1e-9) {
        groups[a] = nextA;
        groups[b] = nextB;
      }
    }
  }

  return groups.filter((g) => g.length).map((g) => members(g).map((p) => p.id));
}

/**
 * Reparto «por cabezas»: cada unidad de cabezas (una persona, o un matrimonio que encabeza junto)
 * va al frente de un grupo y el resto se reparte entre esos grupos con los criterios de siempre.
 * Con «matrimonios juntos», el cónyuge de un cabeza va a su grupo; con «separados», a otro.
 * Devuelve los ids de cada grupo con sus cabezas en primer lugar.
 */
export function groupsWithHeads(people: GroupingPerson[], headUnits: string[][], prefs: GroupPreferences, rng: () => number = Math.random): string[][] {
  const units = shuffle(headUnits, rng);
  const isHead = new Set(units.flat());
  const byId = new Map(people.map((p) => [p.id, p]));
  const k = units.length;
  const groups = makeGroups(
    people.filter((p) => !isHead.has(p.id)),
    { ...prefs, mode: 'count', value: k },
    rng,
  );
  while (groups.length < k) groups.push([]);

  // Cónyuge de un cabeza que está entre el resto (si también es cabeza, ya está colocado).
  const spouseOf = (unit: number) => {
    for (const head of units[unit]!) {
      const spouse = byId.get(head)?.spouseId;
      if (spouse && byId.has(spouse) && !isHead.has(spouse)) return spouse;
    }
    return null;
  };
  const wants = (unit: number, g: number) => {
    const spouse = spouseOf(unit);
    if (!spouse || prefs.couples === 'any') return true;
    return groups[g]!.includes(spouse) === (prefs.couples === 'together');
  };

  // Primero los cabezas con cónyuge entre el resto, cada uno al grupo libre que encaja con los criterios.
  const unitOf: (number | undefined)[] = Array.from({ length: k }, () => undefined);
  const all = units.map((_, u) => u);
  for (const unit of [...all.filter((u) => spouseOf(u)), ...all.filter((u) => !spouseOf(u))]) {
    const free = unitOf.map((u, g) => (u === undefined ? g : -1)).filter((g) => g >= 0);
    unitOf[free.find((g) => wants(unit, g)) ?? free[0]!] = unit;
  }

  // Si no ha encajado (dos cónyuges en el mismo grupo…), se cambia al cónyuge por alguien parecido.
  if (prefs.couples !== 'any') {
    unitOf.forEach((unit, b) => {
      const spouseId = unit !== undefined ? spouseOf(unit) : null;
      if (!spouseId || wants(unit!, b)) return;
      const spouse = byId.get(spouseId)!;
      const a = prefs.couples === 'together' ? groups.findIndex((g) => g.includes(spouseId)) : b;
      const targets = prefs.couples === 'together' ? [b] : groups.map((_, g) => g).filter((g) => g !== b);
      // Con un solo grupo no hay adónde separarlos.
      if (!targets.length) return;
      // Candidato: no es cónyuge de ningún cabeza ni tiene pareja en su grupo; mejor si es del mismo sexo.
      const movable = (id: string, g: number) => {
        const p = byId.get(id)!;
        return !all.some((u) => spouseOf(u) === id) && !(p.spouseId && groups[g]!.includes(p.spouseId));
      };
      let best: { g: number; id: string; score: number } | null = null;
      for (const g of targets) {
        for (const id of groups[g]!) {
          if (!movable(id, g)) continue;
          const score = (byId.get(id)!.gender === spouse.gender ? 2 : 0) + rng();
          if (!best || score > best.score) best = { g, id, score };
        }
      }
      const from = groups[a]!;
      from.splice(from.indexOf(spouseId), 1);
      if (best) {
        const to = groups[best.g]!;
        to.splice(to.indexOf(best.id), 1, spouseId);
        from.push(best.id);
      } else {
        groups[prefs.couples === 'together' ? b : targets[0]!]!.push(spouseId);
      }
    });
  }

  // Los grupos con dos cabezas (un matrimonio) ya tienen uno más: se igualan los tamaños moviendo a
  // alguien sin pareja en su grupo del más lleno al más vacío, mejor del mismo sexo que lo que falta allí.
  const size = (g: number) => groups[g]!.length + units[unitOf[g]!]!.length;
  for (let guard = 0; guard < people.length; guard++) {
    const order = groups.map((_, g) => g).sort((a, b) => size(a) - size(b));
    const small = order[0]!;
    const big = order[order.length - 1]!;
    if (size(big) - size(small) <= 1) break;
    const candidates = groups[big]!.filter((id) => {
      const p = byId.get(id)!;
      const pairedHere = p.spouseId && (groups[big]!.includes(p.spouseId) || units[unitOf[big]!]!.includes(p.spouseId));
      return !(prefs.couples === 'together' && pairedHere) && !(prefs.couples === 'apart' && p.spouseId && (groups[small]!.includes(p.spouseId) || units[unitOf[small]!]!.includes(p.spouseId)));
    });
    if (!candidates.length) break;
    const id = candidates[Math.floor(rng() * candidates.length)]!;
    groups[big]!.splice(groups[big]!.indexOf(id), 1);
    groups[small]!.push(id);
  }

  return groups.map((g, i) => [...units[unitOf[i]!]!, ...g]);
}
