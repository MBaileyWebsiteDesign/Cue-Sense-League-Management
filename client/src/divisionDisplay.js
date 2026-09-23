// Shared helpers for describing and ordering divisions on player-facing
// pages (League page, Open Leagues).

export const SCHEDULING_LABELS = {
  knockout_single_elim: 'Knockout (single elim)',
  knockout_double_elim: 'Knockout (double elim)',
  knockout_double_elim_pcdek: 'Pre Configured Double Elim Knockout',
  knockout_double_elim_adek: 'Adaptive Double Elim Knockout',
  round_robin_double: 'Standard League - Double Leg',
  round_robin_single: 'Standard League - Single Leg',
  killer_classic: 'Killer Classic',
  cards_killer: 'Cards Killer',
  free_play: 'Free Play',
};

export const KILLER_SCHEDULING_TYPES = ['killer_classic', 'cards_killer'];

export function schedulingLabel(scheduling) {
  return SCHEDULING_LABELS[scheduling] || 'Standard League - Single Leg';
}

export function entryTypeLabel(division) {
  if (division.entryType === 'teams') {
    return `Teams · ${division.legsPerMatch} leg${division.legsPerMatch === 1 ? '' : 's'}/match`;
  }
  if (division.entryType === 'doubles') {
    return `${division.pairingSize === 3 ? 'Triples' : 'Doubles'} (${division.pairingSize} players/pairing)`;
  }
  return 'Singles';
}

// One line describing how a division plays, e.g.
// "Singles · Race to 6 · Standard League - Double Leg".
export function divisionFormat(division) {
  const isKiller = KILLER_SCHEDULING_TYPES.includes(division.scheduling);
  const parts = [];
  if (isKiller) {
    parts.push(`${division.startingLives || 3} lives each`);
  } else {
    parts.push(entryTypeLabel(division));
    if (division.raceTo && division.scheduling !== 'free_play') parts.push(`Race to ${division.raceTo}`);
  }
  parts.push(schedulingLabel(division.scheduling));
  return parts.join(' · ');
}

function isPremier(division) {
  return /^\s*premier\b/i.test(division.name || '');
}

// Display order only - the stored `order` values are left alone. Any
// division whose name starts with "Premier" comes first, then the rest by
// their stored order (when present), keeping the original order for ties.
export function sortDivisionsPremierFirst(divisions) {
  return (divisions || [])
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      const pa = isPremier(a.d) ? 0 : 1;
      const pb = isPremier(b.d) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const oa = typeof a.d.order === 'number' ? a.d.order : null;
      const ob = typeof b.d.order === 'number' ? b.d.order : null;
      if (oa !== null && ob !== null && oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map((x) => x.d);
}
