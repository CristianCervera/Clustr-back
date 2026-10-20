import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, makeGroups, seededRandom, type GroupingPerson, type GroupPreferences } from '../src/grouping.js';

/** 12 solteros (6 y 6) y 6 matrimonios: 24 personas. */
function sampleCrowd(): GroupingPerson[] {
  const people: GroupingPerson[] = [];
  for (let i = 0; i < 12; i++) {
    people.push({ id: `s${i}`, gender: i % 2 ? 'female' : 'male', age: 20 + i * 3, married: false });
  }
  for (let i = 0; i < 6; i++) {
    people.push({ id: `h${i}`, gender: 'male', age: 30 + i * 5, married: true, spouseId: `w${i}` });
    people.push({ id: `w${i}`, gender: 'female', age: 29 + i * 5, married: true, spouseId: `h${i}` });
  }
  return people;
}

const prefs = (over: Partial<GroupPreferences> = {}): GroupPreferences => ({ ...DEFAULT_PREFERENCES, ...over });
const sizes = (groups: string[][]) => groups.map((g) => g.length).sort((a, b) => a - b);

describe('makeGroups', () => {
  it('reparte a todas las personas exactamente una vez', () => {
    const people = sampleCrowd();
    const groups = makeGroups(people, prefs({ value: 5 }), seededRandom(1));
    const ids = groups.flat();
    expect(ids).toHaveLength(people.length);
    expect(new Set(ids).size).toBe(people.length);
  });

  it('crea el número de grupos pedido con tamaños equilibrados', () => {
    const groups = makeGroups(sampleCrowd(), prefs({ mode: 'count', value: 4 }), seededRandom(2));
    expect(sizes(groups)).toEqual([6, 6, 6, 6]);
  });

  it('en modo tamaño calcula cuántos grupos salen', () => {
    const groups = makeGroups(sampleCrowd(), prefs({ mode: 'size', value: 8 }), seededRandom(3));
    expect(sizes(groups)).toEqual([8, 8, 8]);
  });

  it('mantiene juntos a los matrimonios', () => {
    const groups = makeGroups(sampleCrowd(), prefs({ value: 4, couples: 'together' }), seededRandom(4));
    for (let i = 0; i < 6; i++) {
      expect(groups.find((g) => g.includes(`h${i}`))).toContain(`w${i}`);
    }
  });

  it('separa a los matrimonios cuando se pide', () => {
    const groups = makeGroups(sampleCrowd(), prefs({ value: 4, couples: 'apart' }), seededRandom(5));
    for (let i = 0; i < 6; i++) {
      expect(groups.find((g) => g.includes(`h${i}`))).not.toContain(`w${i}`);
    }
  });

  it('equilibra hombres y mujeres', () => {
    const people = sampleCrowd();
    const gender = new Map(people.map((p) => [p.id, p.gender]));
    const groups = makeGroups(people, prefs({ value: 4, balanceGender: true }), seededRandom(6));
    for (const g of groups) {
      const males = g.filter((id) => gender.get(id) === 'male').length;
      expect(Math.abs(males - g.length / 2)).toBeLessThanOrEqual(1);
    }
  });

  it('reparte los matrimonios entre los grupos', () => {
    const groups = makeGroups(sampleCrowd(), prefs({ value: 3, mixMarital: true }), seededRandom(7));
    for (const g of groups) expect(g.filter((id) => !id.startsWith('s'))).toHaveLength(4);
  });

  it('reparte a los ocasionales para que no coincidan en el mismo grupo', () => {
    // 4 ocasionales entre 24 personas y 4 grupos: uno en cada grupo.
    const occasional = new Set(['s0', 's1', 's2', 's3']);
    const people = sampleCrowd().map((p) => ({ ...p, occasional: occasional.has(p.id) }));
    for (let seed = 10; seed < 15; seed++) {
      const groups = makeGroups(people, prefs({ value: 4, spreadOccasional: true }), seededRandom(seed));
      for (const g of groups) expect(g.filter((id) => occasional.has(id))).toHaveLength(1);
    }
  });

  it('nunca crea grupos vacíos ni más grupos que personas', () => {
    const people = sampleCrowd().slice(0, 3);
    expect(makeGroups(people, prefs({ value: 10 }), seededRandom(8))).toHaveLength(3);
    expect(makeGroups([], prefs())).toEqual([]);
  });

  it('ignora el cónyuge si no está en la lista', () => {
    const people: GroupingPerson[] = [
      { id: 'a', married: true, spouseId: 'ausente' },
      { id: 'b', married: false },
    ];
    expect(sizes(makeGroups(people, prefs({ value: 2 }), seededRandom(9)))).toEqual([1, 1]);
  });
});
