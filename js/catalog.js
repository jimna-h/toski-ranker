// ---------------------------------------------------------------------------
// catalog.js — the immutable deck catalog for a session.
//
// The catalog (what decks exist) is kept strictly separate from ranking
// state (what the user has decided). Features that enrich decks — commander
// art, Archidekt links, color identity — live here and never touch the
// ranking engine.
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash, hex-encoded. Deterministic ID that stays stable as
 * long as (owner, deckName) doesn't change. A NUL separator prevents the
 * ambiguity of e.g. ("Ab", "c") vs ("A", "bc").
 */
export function deckId(owner, deckName) {
  const input = `${owner}\u0000${deckName}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiplication via shifts (keeps math in int range)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class Catalog {
  /** @param {object[]} rawDecks output of sheetsLoader.loadAllDecks().decks */
  constructor(rawDecks) {
    this.byId = new Map();
    for (const d of rawDecks) {
      const id = deckId(d.owner, d.deckName);
      // Collisions are astronomically unlikely at playgroup scale, but a
      // duplicate (owner, name) row in the sheet would produce one — keep
      // the first and warn rather than silently double-count.
      if (this.byId.has(id)) {
        console.warn(`Duplicate deck ignored: ${d.owner} / ${d.deckName}`);
        continue;
      }
      this.byId.set(id, { id, ...d });
    }
  }

  get(id) {
    return this.byId.get(id);
  }

  allIds() {
    return [...this.byId.keys()];
  }

  get size() {
    return this.byId.size;
  }
}
