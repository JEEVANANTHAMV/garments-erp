/** Environmental / sustainability certifications offered on the Yarn, Fabric and Trims masters (one list, so they stay the same). */
export const CERTIFICATIONS = [
  { value: 'GOTS', label: 'GOTS (Global Organic Textile Standard)' },
  { value: 'OEKO-TEX', label: 'OEKO-TEX Standard 100' },
  { value: 'BCI', label: 'BCI (Better Cotton Initiative)' },
  { value: 'GRS', label: 'GRS (Global Recycled Standard)' },
  { value: 'OCS', label: 'OCS (Organic Content Standard)' },
  { value: 'NONE', label: 'None / Standard' },
];

/** Trims add FSC (paper hangtags, cartons) to the yarn / fabric list (client voice note 13-Oct-2026). */
export const TRIM_CERTIFICATIONS = [
  ...CERTIFICATIONS.filter((c) => c.value !== 'NONE'),
  { value: 'FSC', label: 'FSC (Forest Stewardship Council)' },
  { value: 'NONE', label: 'None / Standard' },
];
