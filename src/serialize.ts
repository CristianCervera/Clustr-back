import type { Types } from 'mongoose';
import type { GroupPreferences } from './grouping.js';

type Id = Types.ObjectId;

export interface UserDto {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  locale: string;
  theme: string;
  preferences: GroupPreferences;
  hasPassword: boolean;
  hasGoogle: boolean;
  createdAt: string;
}

export function userDto(user: {
  _id: Id;
  email: string;
  name: string;
  picture?: string | null;
  locale?: string | null;
  theme?: string | null;
  preferences?: unknown;
  passwordHash?: string | null;
  googleId?: string | null;
  createdAt?: Date;
}): UserDto {
  const prefs = (user.preferences ?? {}) as GroupPreferences & { toObject?: () => GroupPreferences };
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    picture: user.picture ?? null,
    locale: user.locale ?? 'es',
    theme: user.theme ?? 'system',
    preferences: prefs.toObject ? prefs.toObject() : prefs,
    // Requiere cargar el usuario con select('+passwordHash').
    hasPassword: Boolean(user.passwordHash),
    hasGoogle: Boolean(user.googleId),
    createdAt: (user.createdAt ?? new Date()).toISOString(),
  };
}

export interface PersonDto {
  id: string;
  firstName: string;
  lastName: string;
  gender: 'male' | 'female' | null;
  age: number | null;
  married: boolean;
  occasional: boolean;
  spouseId: string | null;
  phone: string;
  email: string;
  notes: string;
  active: boolean;
}

export function personDto(p: {
  _id: Id;
  firstName: string;
  lastName?: string | null;
  gender?: string | null;
  age?: number | null;
  married?: boolean | null;
  occasional?: boolean | null;
  spouse?: Id | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean | null;
}): PersonDto {
  return {
    id: p._id.toString(),
    firstName: p.firstName,
    lastName: p.lastName ?? '',
    gender: (p.gender as PersonDto['gender']) ?? null,
    age: p.age ?? null,
    married: Boolean(p.married),
    occasional: Boolean(p.occasional),
    spouseId: p.spouse ? p.spouse.toString() : null,
    phone: p.phone ?? '',
    email: p.email ?? '',
    notes: p.notes ?? '',
    active: p.active ?? true,
  };
}

export interface MemberDto {
  personId: string | null;
  firstName: string;
  lastName: string;
  gender: string | null;
  age: number | null;
  married: boolean;
  occasional: boolean;
  spouseId: string | null;
  head: boolean;
}

export function groupSetDto(set: {
  _id: Id;
  name: string;
  preferences?: unknown;
  groups: { name?: string | null; members: { person?: Id | null; firstName: string; lastName?: string | null; gender?: string | null; age?: number | null; married?: boolean | null; occasional?: boolean | null; spouse?: Id | null; head?: boolean | null }[] }[];
  createdAt?: Date;
}) {
  return {
    id: set._id.toString(),
    name: set.name,
    preferences: set.preferences ?? {},
    createdAt: (set.createdAt ?? new Date()).toISOString(),
    /** Nombre de cada grupo, en el mismo orden que `groups`; vacío si no se ha puesto. */
    groupNames: set.groups.map((g) => g.name ?? ''),
    groups: set.groups.map((g) =>
      g.members.map(
        (m): MemberDto => ({
          personId: m.person ? m.person.toString() : null,
          firstName: m.firstName,
          lastName: m.lastName ?? '',
          gender: m.gender ?? null,
          age: m.age ?? null,
          married: Boolean(m.married),
          occasional: Boolean(m.occasional),
          spouseId: m.spouse ? m.spouse.toString() : null,
          head: Boolean(m.head),
        }),
      ),
    ),
  };
}
