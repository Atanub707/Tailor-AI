export type ATSPlatform =
  | 'greenhouse'
  | 'workday'
  | 'ashby'
  | 'lever'
  | 'smartrecruiters'
  | 'workable'
  | 'teamtailor'
  | 'personio'
  | 'bamboohr'
  | 'icims'
  | 'recruitee'
  | 'join'
  | 'pinpoint'
  | 'rippling'
  | 'jazzhr'
  | 'comeet'
  | 'other';

export const PRIORITY_ATS: ATSPlatform[] = [
  'greenhouse',
  'workday',
  'ashby',
  'lever',
  'smartrecruiters',
  'workable',
];

export const ALL_ATS: ATSPlatform[] = [
  'greenhouse',
  'workday',
  'ashby',
  'lever',
  'smartrecruiters',
  'workable',
  'teamtailor',
  'personio',
  'bamboohr',
  'icims',
  'recruitee',
  'join',
  'pinpoint',
  'rippling',
  'jazzhr',
  'comeet',
  'other',
];

export function normalizeATSPlatform(raw?: string): ATSPlatform {
  const v = (raw || '').toLowerCase().trim();
  if ((ALL_ATS as string[]).includes(v)) return v as ATSPlatform;
  if (v === 'teamtailor') return 'teamtailor';
  if (v === 'workday') return 'workday';
  return 'other';
}
