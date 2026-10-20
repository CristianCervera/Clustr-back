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
