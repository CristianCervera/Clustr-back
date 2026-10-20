import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from 'mongoose';
import { COUPLE_MODES } from '../grouping.js';

export const LOCALES = ['es', 'en', 'it', 'fr'] as const;
export const THEMES = ['system', 'light', 'dark'] as const;

const preferencesSchema = new Schema(
  {
    mode: { type: String, enum: ['count', 'size'], default: 'count' },
    value: { type: Number, min: 1, max: 500, default: 4 },
    couples: { type: String, enum: COUPLE_MODES, default: 'together' },
    balanceGender: { type: Boolean, default: true },
    balanceAge: { type: Boolean, default: false },
    mixMarital: { type: Boolean, default: true },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /** Ausente en las cuentas creadas con Google hasta que el usuario pone una contraseña. */
    passwordHash: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** Foto de perfil de Google, si la hay. */
    picture: { type: String },
    locale: { type: String, enum: LOCALES, default: 'es' },
    theme: { type: String, enum: THEMES, default: 'system' },
    /** Criterios con los que se generan los grupos. */
    preferences: { type: preferencesSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>> & { _id: Types.ObjectId };
export const User = model('User', userSchema);
