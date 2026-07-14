// ---------------------------------------------------------------------------
// ranking.js — the pure ranking engine.
//
// Every function takes the state object and mutates it according to one user
// action, returning a small "what happens next" descriptor for the UI:
//
//   { type: "bracket" }                       → show the bracket screen
//   { type: "compare", deckId, vsId, tier }   → ask "is deckId stronger than vsId?"
//   { type: "edgePrompt", deckId, tier, direction } → optional demote/promote offer
//   { type: "done" }                          → everything placed
//
// No DOM, no storage — this file is unit-testable in isolation.
//
// Algorithm: binary insertion over TIE-GROUPS.
// A tier's bucket is an ordered array of groups (weakest → strongest).
// To place a deck we binary-search over group indices [lo, hi):
//   • "stronger"       → lo = mid + 1
//   • "weaker"         → hi = mid
//   • "about the same" → join group mid, done (short-circuit)
// When lo === hi the deck becomes a new group inserted at index lo.
// Cost: ⌈log2(#groups)⌉ comparisons worst case; 0 for an empty bucket.
// ---------------------------------------------------------------------------

import { TIERS, tierIndex } from "./config.js";

/** Peek at what the UI should show given the current state. */
export function nextStep(state) {
  if (state.current) {
    return compareStepFor(state);
  }
  if (state.queue.length > 0) {
    return { type: "bracket", deckId: state.queue[0] };
  }
  if (state.deferred.length > 0) {
    // Main queue exhausted → deferred decks come back around.
    state.queue = state.deferred;
    state.deferred = [];
    return { type: "bracket", deckId: state.queue[0] };
  }
  return { type: "done" };
}

/** Build the comparison question for the in-progress insertion. */
function compareStepFor(state) {
  const { deckId, tier, lo, hi } = state.current;
  const groups = state.buckets[tier] ?? [];
  if (lo >= hi) {
    // Search window collapsed — this shouldn't be reachable because
    // answerComparison finalizes immediately, but guard anyway.
    return finalizeInsertion(state, lo);
  }
  const mid = Math.floor((lo + hi) / 2);
  // Compare against the first deck of the mid group. Any member would do —
  // they're tied by definition — the first is simply deterministic.
  return { type: "compare", deckId, vsId: groups[mid][0], tier, mid };
}

/** User tapped a bracket for the deck at the front of the queue. */
export function chooseBracket(state, tierId) {
  const deckId = state.queue.shift();
  const groups = state.buckets[tierId] ?? (state.buckets[tierId] = []);
  if (groups.length === 0) {
    // First deck in this tier: no comparisons needed.
    groups.push([deckId]);
    return nextStep(state);
  }
  state.current = { deckId, tier: tierId, lo: 0, hi: groups.length };
  return compareStepFor(state);
}

/** User answered a comparison: "stronger" | "weaker" | "same". */
export function answerComparison(state, answer) {
  const cur = state.current;
  const groups = state.buckets[cur.tier];
  const mid = Math.floor((cur.lo + cur.hi) / 2);

  if (answer === "same") {
    // Ties are first-class: join the group and stop asking questions.
    groups[mid].push(cur.deckId);
    state.current = null;
    return nextStep(state);
  }

  if (answer === "stronger") cur.lo = mid + 1;
  else cur.hi = mid;

  if (cur.lo >= cur.hi) return finalizeInsertion(state, cur.lo);
  return compareStepFor(state);
}

/** Insert the current deck as a new group at `index` within its tier. */
function finalizeInsertion(state, index) {
  const { deckId, tier } = state.current;
  const groups = state.buckets[tier];
  groups.splice(index, 0, [deckId]);
  state.current = null;

  // Boundary heuristic: landing at the very bottom or very top of a
  // reasonably full bucket is weak evidence the deck belongs one tier over
  // ("weaker than everything in B3 Mid" ≈ "maybe B3 Low"). Offer — never
  // force — a one-tap move. Suppressed for tiny buckets, where edges are
  // just where things land, and at the ends of the scale.
  const ti = tierIndex[tier];
  if (groups.length >= 3) {
    if (index === 0 && ti > 0) {
      return { type: "edgePrompt", deckId, tier, direction: "down", ...nextInfo(state) };
    }
    if (index === groups.length - 1 && ti < TIERS.length - 1) {
      return { type: "edgePrompt", deckId, tier, direction: "up", ...nextInfo(state) };
    }
  }
  return nextStep(state);
}

/** Attach what the next step would be, so the UI can proceed after the
 *  edge prompt without recomputing state transitions. */
function nextInfo(state) {
  return { next: nextStep(state) };
}

/**
 * User accepted an edge-prompt move: shift the deck to the adjacent tier.
 * It's placed at the facing edge of the destination bucket (strongest slot
 * when moving down, weakest when moving up) — a heuristic, not a proof, but
 * the natural guess given it was the extreme of its old tier. The edit
 * screen exists for the rare case where that guess is wrong.
 */
export function acceptEdgeMove(state, deckId, fromTier, direction) {
  removeDeck(state, deckId);
  const ti = tierIndex[fromTier] + (direction === "down" ? -1 : 1);
  const destTier = TIERS[ti].id;
  const groups = state.buckets[destTier] ?? (state.buckets[destTier] = []);
  if (direction === "down") groups.push([deckId]); // strongest of lower tier
  else groups.unshift([deckId]); // weakest of upper tier
  return nextStep(state);
}

/** "Come back later". Returns {step, mustResolve} — mustResolve is true on
 *  the 3rd attempt, meaning the UI should demand place-or-skip instead. */
export function deferCurrent(state) {
  const deckId = state.queue[0];
  const count = state.deferCounts[deckId] ?? 0;
  if (count >= 2) {
    return { mustResolve: true, deckId };
  }
  state.deferCounts[deckId] = count + 1;
  state.queue.shift();
  state.deferred.push(deckId);
  return { mustResolve: false, step: nextStep(state) };
}

/** Permanently skip the deck at the front of the queue. */
export function skipCurrent(state) {
  const deckId = state.queue.shift();
  state.skipped.push(deckId);
  return nextStep(state);
}

/** Remove a deck from wherever it currently lives (bucket/queue/lists).
 *  Empty tie-groups left behind are pruned. */
export function removeDeck(state, deckId) {
  for (const [tier, groups] of Object.entries(state.buckets)) {
    for (let g = 0; g < groups.length; g++) {
      const i = groups[g].indexOf(deckId);
      if (i !== -1) {
        groups[g].splice(i, 1);
        if (groups[g].length === 0) groups.splice(g, 1);
        if (groups.length === 0) delete state.buckets[tier];
        return;
      }
    }
  }
  for (const list of [state.queue, state.deferred, state.skipped]) {
    const i = list.indexOf(deckId);
    if (i !== -1) {
      list.splice(i, 1);
      return;
    }
  }
}

/** Edit screen: pull a placed/skipped deck back to the front of the queue
 *  so it gets re-ranked next. Its defer count is reset — it's had enough
 *  chances to be postponed. */
export function rerankDeck(state, deckId) {
  removeDeck(state, deckId);
  delete state.deferCounts[deckId];
  state.queue.unshift(deckId);
}

/**
 * Reconcile a saved session with a freshly loaded catalog — the sheet is
 * the source of truth for WHICH decks exist; the session remains the source
 * of truth for the user's judgments about them.
 *   • Decks added to the sheet    → appended to the queue (shuffled batch).
 *   • Decks removed from the sheet → pruned from queue/buckets/etc.
 *   • Renamed decks change their deterministic ID, so they intentionally
 *     count as removed + added and get re-ranked.
 * Returns { added, removed } counts so the UI can mention it.
 */
export function reconcileWithCatalog(state, catalogIds) {
  const known = new Set(catalogIds);
  const seen = new Set();
  let removed = 0;

  // Prune buckets, dropping emptied tie-groups and tiers.
  for (const [tier, groups] of Object.entries(state.buckets)) {
    for (let g = groups.length - 1; g >= 0; g--) {
      const kept = groups[g].filter((id) => known.has(id));
      removed += groups[g].length - kept.length;
      if (kept.length) {
        groups[g] = kept;
        kept.forEach((id) => seen.add(id));
      } else {
        groups.splice(g, 1);
      }
    }
    if (groups.length === 0) delete state.buckets[tier];
  }

  // Prune flat lists.
  for (const key of ["queue", "deferred", "skipped"]) {
    const kept = state[key].filter((id) => known.has(id));
    removed += state[key].length - kept.length;
    state[key] = kept;
    kept.forEach((id) => seen.add(id));
  }

  // An in-progress insertion: cancel it if its deck vanished, or if pruning
  // shrank its bucket enough to invalidate the search bounds — the deck
  // goes back to the queue front and the user simply re-picks its bracket.
  if (state.current) {
    const cur = state.current;
    const groups = state.buckets[cur.tier] ?? [];
    if (!known.has(cur.deckId)) {
      state.current = null;
      removed++;
    } else if (cur.hi > groups.length) {
      state.current = null;
      state.queue.unshift(cur.deckId);
      seen.add(cur.deckId);
    } else {
      seen.add(cur.deckId);
    }
  }

  // Append newcomers, shuffled among themselves.
  const added = catalogIds.filter((id) => !seen.has(id));
  for (let i = added.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [added[i], added[j]] = [added[j], added[i]];
  }
  state.queue.push(...added);

  return { added: added.length, removed };
}
