// ---------------------------------------------------------------------------
// config.js — edit these two values, everything else should Just Work.
// ---------------------------------------------------------------------------

// Data sources — fill in ONE section:
//
// A) EASIEST — link-shared sheet, zero keys, zero Google Cloud setup:
//    1. Share the sheet "Anyone with the link can view".
//    2. Paste SHEET_ID below (the long ID from the sheet's URL).
//    3. List your players' worksheet tab names here (Google's keyless
//       endpoint can't enumerate tabs, so we tell it which ones exist —
//       just keep this in sync if someone joins the group):
export const PLAYER_TABS = [
  // "Sam", "Dave", "Alex",
];

// B) DATA_URL: any endpoint returning { sheets: [{ title, values }] }.
//    For private sheets. Providers included: server/server.js (Node +
//    service account) and apps-script/Code.gs (Apps Script proxy).
//    Takes priority over A and C when non-empty.
export const DATA_URL = "";

// C) Link-shared sheet + Google Cloud API key. Auto-discovers tabs, so no
//    PLAYER_TABS list to maintain, at the cost of API-key setup. Used when
//    API_KEY is filled in and PLAYER_TABS is empty.
/** The long ID from your Google Sheet URL:
 *  https://docs.google.com/spreadsheets/d/<THIS PART>/edit
 *  (needed for both A and C) */
export const SHEET_ID = "PASTE_YOUR_SHEET_ID_HERE";
export const API_KEY = "";

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
