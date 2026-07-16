// ---------------------------------------------------------------------------
// config.js — sheet, players, and tier definitions. Everything else Just Works.
// ---------------------------------------------------------------------------
// Data source: link-shared Google Sheet via Google's keyless CSV endpoint.
// The sheet must be shared "Anyone with the link can view".
//
// The endpoint can't enumerate worksheet tabs, so list your players' tab
// names here — keep it in sync if someone joins or renames their tab
// (names must match Google exactly, including spaces):
export const PLAYER_TABS = [
  "James", "Ben R", "Kevin", "Michael R", "Michael J", "Will", "Ben M"
];

/** The long ID from your Google Sheet URL:
 *  https://docs.google.com/spreadsheets/d/<THIS PART>/edit */
export const SHEET_ID = "1HfTUoLol3h1DmDeWTDsUqYTjq99SV9NGi-CmB3Wk89g";

/** Where "Send to James" delivers finished rankings. */
export const EXPORT_EMAIL = "jimnah.mtg@gmail.com";

/** Aggregation sheet (James's results workbook) and the tab results.html
 *  reads. Must also be shared "anyone with the link can view". */
export const RESULTS_SHEET_ID = "1gINrEt9MZfjVVfTkp4ayvCFTEbtrTPf2-Pv88Psbpug";
export const RESULTS_TAB = "final";
/** Raw concatenated ratings (one row per deck×rater) — powers the per-rater
 *  lens on results.html. Optional: if missing, the lens degrades gracefully. */
export const RAW_TAB = "Raw";

/** Worksheet tabs to ignore entirely. */
export const IGNORED_TABS = ["Precons"];
/** Deck names to ignore (exact match, case-insensitive). */
export const IGNORED_DECKS = ["PFP"];
/** Version stamp for the localStorage schema. Bump this if the shape of the
 *  saved state ever changes incompatibly; old sessions will be discarded
 *  rather than half-loaded into a broken app. */
export const SCHEMA_VERSION = 1;
// ---------------------------------------------------------------------------
// Ranking modes. Each mode is an independent scale the group can rate every
// deck on. The ranking engine (binary insertion, tie-groups, defer/skip) and
// the scoring math (fixed intervals, even spacing) are scale-agnostic — a
// mode is just a different set of tiers plus a little presentation.
//
// "power" — the 11 official EDH bracket tiers, ordered weakest → strongest.
// "dependency" — how much of the deck's plan is written on the commander,
//   from "none of it" (Color Anchor) to "all of it" (Cornerstone). This does
//   NOT relate to power level: cEDH has decks at every dependency.
//
// Each tier owns a fixed numeric interval [low, high). Scores are computed
// by evenly spacing a tier's rank-groups inside its interval, never touching
// the endpoints — so "top of B2 High" can never collide with "bottom of
// B3 Low", and scores are comparable across different users even if their
// tiers hold different numbers of decks.
// ---------------------------------------------------------------------------
const POWER_TIERS = [
  { id: "B1",      label: "B1",      short: "1",  low: 1.0,     high: 2.0     },
  { id: "B2_LOW",  label: "B2 Low",  short: "2−", low: 2.0,     high: 2.3333  },
  { id: "B2_MID",  label: "B2 Mid",  short: "2",  low: 2.3333,  high: 2.6667  },
  { id: "B2_HIGH", label: "B2 High", short: "2+", low: 2.6667,  high: 3.0     },
  { id: "B3_LOW",  label: "B3 Low",  short: "3−", low: 3.0,     high: 3.3333  },
  { id: "B3_MID",  label: "B3 Mid",  short: "3",  low: 3.3333,  high: 3.6667  },
  { id: "B3_HIGH", label: "B3 High", short: "3+", low: 3.6667,  high: 4.0     },
  { id: "B4_LOW",  label: "B4 Low",  short: "4−", low: 4.0,     high: 4.3333  },
  { id: "B4_MID",  label: "B4 Mid",  short: "4",  low: 4.3333,  high: 4.6667  },
  { id: "B4_HIGH", label: "B4 High", short: "4+", low: 4.6667,  high: 5.0     },
  { id: "B5",      label: "B5",      short: "5",  low: 5.0,     high: 6.0     },
];

const DEPENDENCY_TIERS = [
  { id: "T1", label: "Color Anchor", low: 1, high: 2,
    blurb: "The commander exists solely to set your colors. You rarely cast it; the deck is 99 cards that don't know it exists." },
  { id: "T2", label: "Flavor Mascot", low: 2, high: 3,
    blurb: "An on-theme card you cast when convenient. The deck's engine runs entirely in the 99; the commander is a welcome bonus, not a piece of the strategy." },
  { id: "T3", label: "Utility Roleplayer", low: 3, high: 4,
    blurb: "A reliable tool used to smooth out your game. It provides generic value, card flow, or a mana sink when needed. It lubes the gears of your strategy but is never the focus of the deck." },
  { id: "T4", label: "Catalyst", low: 4, high: 5,
    blurb: "The 99 operates fine on its own, but the commander acts as a massive multiplier. You cast it every game to supercharge your existing board state and turn fair plays into explosive ones." },
  { id: "T5", label: "Engine", low: 5, high: 6,
    blurb: "The deck's resource loop is warped around the commander. The 99 is stuffed with potentially otherwise mediocre cards that are only run to aid the commander's plan. Without it to convert that filler into value, your game plan exists but is more likely to stall." },
  { id: "T6", label: "Cornerstone", low: 6, high: 7,
    blurb: "Absolute mechanical reliance. The commander is the only win condition or functional enabler, and the 99 has zero redundancy. If the commander is locked down or taxed out, you physically cannot win the game without a miracle from the Magic gods." },
];

export const MODES = {
  power: {
    id: "power",
    name: "Power bracket",
    tiers: POWER_TIERS,
    /** Bracket-button rows, as tier indexes — mirrors the bracket structure. */
    rows: [[0], [1, 2, 3], [4, 5, 6], [7, 8, 9], [10]],
    /** Score axis for the timeline dock. */
    axis: { min: 1, max: 6, majorTicks: [2, 3, 4, 5],
      minorTicks: [2 + 1/3, 2 + 2/3, 3 + 1/3, 3 + 2/3, 4 + 1/3, 4 + 2/3],
      labels: ["B1", "B2", "B3", "B4", "B5"] },
    question: "Which bracket does this deck belong in?",
  },
  dependency: {
    id: "dependency",
    name: "Commander dependency",
    tiers: DEPENDENCY_TIERS,
    rows: [[0, 1, 2], [3, 4, 5]],
    axis: { min: 1, max: 7, majorTicks: [2, 3, 4, 5, 6], minorTicks: [],
      labels: ["Anchor", "Mascot", "Roleplayer", "Catalyst", "Engine", "Cornerstone"] },
    question: "How much of this deck's plan is written on its commander?",
  },
};

/* Live bindings: `import { TIERS }` elsewhere always sees the active mode's
 * tiers — setMode() reassigns these and every importer follows. The engine
 * and scoring modules stay completely mode-unaware. */
export let ACTIVE_MODE = MODES.power;
export let TIERS = ACTIVE_MODE.tiers;
export let tierById = Object.fromEntries(TIERS.map((t) => [t.id, t]));
export let tierIndex = Object.fromEntries(TIERS.map((t, i) => [t.id, i]));

export function setMode(modeId) {
  ACTIVE_MODE = MODES[modeId] ?? MODES.power;
  TIERS = ACTIVE_MODE.tiers;
  tierById = Object.fromEntries(TIERS.map((t) => [t.id, t]));
  tierIndex = Object.fromEntries(TIERS.map((t, i) => [t.id, i]));
}
