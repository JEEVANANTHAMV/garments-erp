/**
 * Knitted fabric and undyed yarn have no colour of their own (client 30-Oct-2026): their colour is "Kora / Raw" —
 * never "Grey" (grey is a real colour, so a typed "Grey" is kept) and never the colour the fabric will be dyed to later. Same rule as the server.
 */
export const RAW_COLOUR = 'Kora / Raw';

const RAW_WORDS = /^(raw|kora|cora|greige|kora\s*\/\s*raw|cora\s*\/\s*raw|raw\s*\/\s*kora|natural\s*raw)$/i;

export const isRawColour = (c: unknown) => RAW_WORDS.test(String(c ?? '').trim());

/** Colour to show for yarn / knitted fabric: blank or any "undyed" spelling → Kora / Raw. */
export const showRawColour = (c: string | null | undefined) => (!String(c ?? '').trim() || isRawColour(c) ? RAW_COLOUR : String(c).trim());

/** Fabric state for display: GREY (not yet processed) reads "Kora / Raw". */
export const stateLabel = (s: string | null | undefined) => (s === 'GREY' ? RAW_COLOUR : s ?? '');

/** A roll / roll group's colour as it is now; an undyed one also says what it will be dyed to: "Kora / Raw (for Orange)". */
export const rollColour = (g: { color_name?: string | null; colour?: string | null; process_state?: string | null; for_colour?: string | null; shade?: string | null }) =>
  g.color_name && !isRawColour(g.color_name) ? g.color_name
    : !g.process_state || g.process_state === 'GREY' || isRawColour(g.color_name) || isRawColour(g.colour) || g.colour === 'GREY'
      ? `${RAW_COLOUR}${g.for_colour ? ` (for ${g.for_colour})` : ''}`
      : g.shade || '';
