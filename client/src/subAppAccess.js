// Sub apps (Virtual Training, Pool Academy, AI Coaching) are hidden from every
// account except the owner's while they are being built (2026-10-27).
// Client-side only: it hides the cards and Admin Portal tiles, it does not
// block the underlying pages or API calls.
export const SUB_APP_OWNER_EMAIL = 'matt.bailey1985@gmail.com';

export function canSeeSubApps(user) {
  return String(user?.email || '').trim().toLowerCase() === SUB_APP_OWNER_EMAIL;
}
