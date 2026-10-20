import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from 'mongoose';
import { GENDERS } from '../grouping.js';

const personSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, default: '', trim: true, maxlength: 80 },
    gender: { type: String, enum: [...GENDERS, null], default: null },
    age: { type: Number, min: 0, max: 120, default: null },
    married: { type: Boolean, default: false },
    /** Cónyuge dentro de la misma cuenta. El vínculo se guarda en las dos personas. */
    spouse: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
    phone: { type: String, default: '', trim: true, maxlength: 40 },
    email: { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },
    notes: { type: String, default: '', trim: true, maxlength: 500 },
    /** No suele venir: se reparte entre los grupos para que ninguno se quede cojo. */
    occasional: { type: Boolean, default: false },
    /** Si participa al generar grupos. */
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

personSchema.index({ owner: 1, lastName: 1, firstName: 1 });

export type PersonDoc = HydratedDocument<InferSchemaType<typeof personSchema>> & { _id: Types.ObjectId };
export const Person = model('Person', personSchema);
