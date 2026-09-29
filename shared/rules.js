// Game rules shared by the app (for messages) and the server (for enforcement).

// Forecasting, not staking: you never put points in. Being right earns points, scaled by confidence.
export const CONF = {
  hunch:   { label: 'Hunch',       pct: '60%', win: 10, lose: 0 },
  sure:    { label: 'Fairly sure', pct: '75%', win: 20, lose: 5 },
  certain: { label: 'Certain',     pct: '90%', win: 30, lose: 15 }
};

export const COMMUNITY = { name: "King's E-Lab", short: 'KE' };

export const normaliseEmail = raw => String(raw ?? '').trim().toLowerCase();
export const isCamEmail = raw => /^[^@\s]+@cam\.ac\.uk$/.test(normaliseEmail(raw));
export const CAM_ONLY_MSG = 'BNOC is only open to Cambridge email addresses ending in @cam.ac.uk.';

// Relationships, health, appearance, grades. A word list can't catch everything; admins review suggestions too.
// Whole words only, so "fat" doesn't block "father". A trailing * matches any ending ("grade*" → "grades").
const BANNED = [
  'break up', 'breakup', 'broke up', 'dating', 'date with', 'hook up', 'hookup', 'kiss*', 'crush*', 'sleep with',
  'boyfriend*', 'girlfriend*', 'divorce*', 'cheat*',
  'sick', 'ill', 'illness', 'pregnan*', 'depress*', 'therapy', 'drunk', 'hospital*',
  'weigh*', 'fat', 'ugly', 'looks', 'hot or not',
  'grade*', 'marks', 'exam result*', 'first class', '2:1', 'fail his', 'fail her', 'fail their'
];
const BANNED_RE = new RegExp(BANNED.map(w => {
  const prefix = w.endsWith('*');
  const core = (prefix ? w.slice(0, -1) : w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return prefix ? `\\b${core}` : `\\b${core}\\b`;
}).join('|'), 'i');
export const BANNED_MSG = "This call can't be posted. BNOC doesn't allow calls about relationships, health, appearance or grades. Try something people can cheer for instead.";
export const isBannedTopic = q => BANNED_RE.test(String(q ?? ''));
