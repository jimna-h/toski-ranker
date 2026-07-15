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

/** Worksheet tabs to ignore entirely. */
export const IGNORED_TABS = ["Precons"];
/** Deck names to ignore (exact match, case-insensitive). */
export const IGNORED_DECKS = ["PFP"];
/** Version stamp for the localStorage schema. Bump this if the shape of the
 *  saved state ever changes incompatibly; old sessions will be discarded
 *  rather than half-loaded into a broken app. */
export const SCHEMA_VERSION = 1;
// ---------------------------------------------------------------------------
// The 11 official EDH bracket tiers, ordered weakest → strongest.
//
// Each tier owns a fixed numeric interval [low, high). Scores are computed
// by evenly spacing a tier's rank-groups inside its interval, never touching
// the endpoints — so "top of B2 High" can never collide with "bottom of
// B3 Low", and scores are comparable across different users even if their
// tiers hold different numbers of decks.
// ---------------------------------------------------------------------------
export const TIERS = [
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
/** Lookup helpers */
export const tierById = Object.fromEntries(TIERS.map((t) => [t.id, t]));
export const tierIndex = Object.fromEntries(TIERS.map((t, i) => [t.id, i]));
