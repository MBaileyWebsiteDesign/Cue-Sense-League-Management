// Automatic division draw (Matt, 2026-11-20). Pure helpers for the "Automatically
// manage divisions" wizard on the League page (components/AutoDivisionsWizard.jsx).
//
// Every player lands in exactly ONE division, and division sizes never differ by
// more than one player: the players are shuffled, then dealt round-robin across
// the divisions (starting at a random division, so the "extra" player when the
// numbers don't divide evenly doesn't always go to Division 1).

export function shuffle(items, rng = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ids: any array of unique ids. Returns [{ id, divisionIndex }] in draw (reveal) order.
export function buildAssignment(ids, divisionCount, rng = Math.random) {
  const n = Math.max(1, Math.floor(divisionCount));
  const start = Math.floor(rng() * n);
  return shuffle(ids, rng).map((id, i) => ({ id, divisionIndex: (start + i) % n }));
}

// Next free "Division N" names that don't clash (case-insensitive) with existing ones.
export function nextDivisionNames(existingNames, count) {
  const used = new Set((existingNames || []).map((s) => String(s).trim().toLowerCase()));
  const out = [];
  let k = 1;
  while (out.length < count) {
    const name = `Division ${k}`;
    if (!used.has(name.toLowerCase())) out.push(name);
    k += 1;
  }
  return out;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
