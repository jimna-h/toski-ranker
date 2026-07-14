// ---------------------------------------------------------------------------
// scoring.js — turns the ordinal ranking into decimal scores. Pure functions.
//
// Each tier owns a fixed interval [low, high) (see config.js). A tier with
// n tie-groups spaces them evenly at fractions 1/(n+1) … n/(n+1) of the
// interval, so:
//   • scores never touch the interval endpoints (no cross-tier collisions),
//   • tied decks share a score exactly,
//   • a lone deck in a tier sits at the interval midpoint,
//   • scores are comparable across users, because the tier boundaries are
//     fixed constants — only sub-tier spacing depends on bucket population.
// ---------------------------------------------------------------------------

import { tierById } from "./config.js";

/**
 * @param {object} buckets state.buckets (tierId → array of tie-groups)
 * @returns {Map<string, {score: number, tierId: string}>} deckId → result
 */
export function computeScores(buckets) {
  const out = new Map();
  for (const [tierId, groups] of Object.entries(buckets)) {
    const { low, high } = tierById[tierId];
    const width = high - low;
    const n = groups.length;
    groups.forEach((group, rank) => {
      // rank 0 = weakest group in the tier
      const score = low + (width * (rank + 1)) / (n + 1);
      for (const deckId of group) out.set(deckId, { score, tierId });
    });
  }
  return out;
}
