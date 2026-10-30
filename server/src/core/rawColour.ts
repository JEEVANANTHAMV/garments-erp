/**
 * Knitted fabric and undyed yarn have no colour of their own (client 30-Oct-2026): their colour is "Kora / Raw" —
 * never "Grey" (grey is a real colour, so a typed "Grey" is kept) and never the colour the fabric will be dyed to later.
 */
export const RAW_COLOUR = 'Kora / Raw';

const RAW_WORDS = /^(raw|kora|cora|greige|kora\s*\/\s*raw|cora\s*\/\s*raw|raw\s*\/\s*kora|natural\s*raw)$/i;

/** True for the ways people write "undyed": raw, kora, cora, greige … */
export const isRawColour = (c: unknown) => RAW_WORDS.test(String(c ?? '').trim());

/** A typed colour with every "undyed" spelling made "Kora / Raw"; blank stays null. */
export const normRawColour = (c: string | null | undefined): string | null => {
  const t = String(c ?? '').trim();
  return !t ? null : isRawColour(t) ? RAW_COLOUR : t;
};
