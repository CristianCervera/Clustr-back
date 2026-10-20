import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

export const objectId = z.string().refine(isValidObjectId, 'Identificador no válido');
export const IdParams = z.object({ id: objectId });

/** Clave para emparejar nombres: sin tildes, mayúsculas ni espacios repetidos. */
export function nameKey(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
