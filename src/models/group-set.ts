import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from 'mongoose';

/** Copia de la persona en el momento de guardar: el reparto no cambia si luego se edita o borra. */
const memberSchema = new Schema(
  {
    person: { type: Schema.Types.ObjectId, ref: 'Person' },
    firstName: { type: String, required: true },
    lastName: { type: String, default: '' },
    gender: { type: String, default: null },
    age: { type: Number, default: null },
    married: { type: Boolean, default: false },
    spouse: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const groupSetSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    preferences: { type: Schema.Types.Mixed, default: {} },
    groups: { type: [{ members: { type: [memberSchema], default: [] } }], default: [] },
  },
  { timestamps: true },
);

export type GroupSetDoc = HydratedDocument<InferSchemaType<typeof groupSetSchema>> & { _id: Types.ObjectId };
export const GroupSet = model('GroupSet', groupSetSchema);
