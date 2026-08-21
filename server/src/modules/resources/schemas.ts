import { z } from 'zod';

/** Common reusable field schemas. */
export const s = {
  str:   (max = 255) => z.string().trim().max(max),
  strReq:(max = 255) => z.string().trim().min(1, 'This field is required').max(max),
  text:  () => z.string().trim().max(20000).nullish(),
  int:   () => z.coerce.number().int().nullish(),
  intReq:() => z.coerce.number().int(),
  id:    () => z.coerce.number().int().positive().nullish(),
  idReq: () => z.coerce.number().int().positive(),
  dec:   () => z.coerce.number().nullish(),
  decReq:() => z.coerce.number(),
  bool:  () => z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).nullish(),
  date:  () => z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'), z.literal(''), z.null()])
                 .transform((v) => (v === '' ? null : v)).nullish(),
  enum:  <T extends readonly [string, ...string[]]>(vals: T) => z.enum(vals).nullish(),
  enumReq: <T extends readonly [string, ...string[]]>(vals: T) => z.enum(vals),
  email: () => z.union([z.string().trim().email('Enter a valid email'), z.literal(''), z.null()])
                 .transform((v) => (v === '' ? null : v)).nullish(),
  nullableStr: (max = 255) => z.union([z.string().trim().max(max), z.literal(''), z.null()])
                 .transform((v) => (v === '' ? null : v)).nullish(),
};

/** Shorthand for a writable field. */
export const f = (name: string, schema: z.ZodTypeAny, immutable = false) => ({ name, schema, immutable });
