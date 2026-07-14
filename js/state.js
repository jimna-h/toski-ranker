// ---------------------------------------------------------------------------
// state.js — the single serializable session state + persistence + undo.
//
// One plain JSON object holds everything a session needs to resume exactly
// where it left off. It is written to localStorage wholesale after every
// user action (commit()), which is what makes "close the tab whenever you
// like" free.
//
// Undo is snapshot-based: before each action we push a deep copy of the
// state. At playgroup scale (~70 decks) a snapshot is a few KB, so keeping
// the last 100 is cheap and far less bug-prone than inverse patches.
// ---------------------------------------------------------------------------

import { SCHEMA_VERSION } from "./config.js";

const KEY_PREFIX = "edhrank";

/** localStorage key is scoped per player so a shared device can host
 *  several people's sessions side by side. */
function storageKey(player) {
  return `${KEY_PREFIX}:v${SCHEMA_VERSION}:${player}`;
}

/** Fisher–Yates shuffle (in place). Randomized presentation order avoids
 *  "all of one player's decks in a row" anchoring bias; the shuffled queue
 *  is persisted, so resume order is exact. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function freshState(player, deckIds) {
  return {
    version: SCHEMA_VERSION,
    player,
    /** Deck IDs not yet placed, in presentation order. Front = current. */
    queue: shuffle([...deckIds]),
    /** "Come back later" decks, re-queued after the main queue empties. */
    deferred: [],
    /** deckId → number of times the user has deferred it. */
    deferCounts: {},
    /** Decks the user chose to skip permanently (excluded from export). */
    skipped: [],
    /**
     * tierId → ordered array of tie-groups, weakest → strongest.
     * A tie-group is an array of deck IDs the user judged "about the same".
     * e.g. buckets.B3_MID = [["a1"], ["b2","c3"], ["d4"]]
     * Ties as first-class groups keep scoring honest (tied decks share a
     * score) and feed the future gradient visualization directly.
     */
    buckets: {},
    /**
     * In-progress binary insertion, or null when on the bracket screen.
     * { deckId, tier, lo, hi } — lo/hi are group-index bounds of the
     * remaining search window within buckets[tier].
     */
    current: null,
  };
}

export class Session {
  constructor(state) {
    this.state = state;
    this.undoStack = [];
  }

  /** Load an existing session for a player, or null if none saved. */
  static load(player) {
    const raw = localStorage.getItem(storageKey(player));
    if (!raw) return null;
    try {
      const state = JSON.parse(raw);
      if (state.version !== SCHEMA_VERSION) return null; // stale schema
      return new Session(state);
    } catch {
      return null; // corrupted entry — treat as no session
    }
  }

  static start(player, deckIds) {
    const session = new Session(freshState(player, deckIds));
    session.commit();
    return session;
  }

  /** Call before mutating state, so the action can be undone. */
  snapshot() {
    this.undoStack.push(JSON.stringify(this.state));
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  /** Persist after mutating state. */
  commit() {
    localStorage.setItem(storageKey(this.state.player), JSON.stringify(this.state));
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  undo() {
    if (!this.canUndo) return false;
    this.state = JSON.parse(this.undoStack.pop());
    this.commit();
    return true;
  }

  // ---- derived counts for progress display -------------------------------

  placedCount() {
    return Object.values(this.state.buckets).reduce(
      (sum, groups) => sum + groups.reduce((s, g) => s + g.length, 0),
      0
    );
  }

  totalCount() {
    return (
      this.placedCount() +
      this.state.queue.length +
      this.state.deferred.length +
      this.state.skipped.length +
      (this.state.current ? 1 : 0)
    );
  }
}
