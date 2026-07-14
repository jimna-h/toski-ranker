# EDH Bracket Ranker

A zero-backend web app for collectively ranking a Commander playgroup's decks
into the 11 official EDH bracket tiers. Each player places every deck with a
bracket tap plus a few binary-insertion comparisons, progress autosaves to
localStorage, and the result exports as a CSV with deterministic deck IDs and
decimal ratings.

## Setup

1. Share the Google Sheet **"Anyone with the link can view"**.
2. In `js/config.js`: set `SHEET_ID` and list your players' worksheet tab
   names in `PLAYER_TABS` (Google's keyless CSV endpoint can't discover
   tabs, so keep the list in sync if a player joins or renames a tab —
   names must match exactly, including spaces).
3. Serve the folder over HTTP — ES modules don't run from `file://`.
   Locally: `python3 -m http.server`, then open `http://localhost:8000`.
   For the group: GitHub Pages, Netlify, or any static host.

## Notes

- **Sheet updates are safe mid-campaign.** Every time a player resumes, the
  app diffs their saved session against the fresh sheet: newly added decks
  join their queue, deleted decks are pruned from their rankings, and a
  small notice says what changed. Renaming a deck (or its owner tab)
  changes its deterministic ID, so it's treated as delete + add and gets
  re-ranked — rename before the campaign if possible.
- **The power timeline** is docked to the bottom of every screen: a
  jade→ember axis running weak (left) → strong (right), with each placed
  deck's commander art sitting at its exact score — ties and near-scores
  stack vertically like a timeline. Hover/long-press a thumbnail for the
  deck name and score. It fills in live as you rank.
- Sheet parsing: every worksheet tab is a player; the `Precons` tab and any
  deck named `PFP` are ignored (see `IGNORED_TABS` / `IGNORED_DECKS` in
  `js/config.js`). Only the `Deck Name` column is required; `Art_URL`,
  `Art_URL_Partner`, and `Color_ID` are captured for future features.
- Progress is saved per player per browser. Clearing site data erases it.
- Deck IDs are FNV-1a hashes of `owner + deckName`, so they stay stable
  across sessions and users as long as neither changes.
- CSV columns: `DeckID,DeckName,Owner,Rater,Bracket,NumericRating` —
  `Rater` is the player who produced the rankings, so exported files from
  the whole group can be concatenated directly. Skipped decks are excluded
  (restorable from the Review screen before export).
- After picking their name, each player chooses a scope: **All decks**
  (default), **My decks**, or **Not my decks**. A saved session keeps its
  original scope — switching mid-run would prune already-ranked decks.

## Architecture

| File | Responsibility |
|---|---|
| `js/config.js` | Sheet/API config, tier definitions & score intervals |
| `js/sheetsLoader.js` | Read-only keyless Google Sheets fetch (only file that knows Google) |
| `js/catalog.js` | Immutable deck catalog + deterministic IDs |
| `js/state.js` | Serializable session state, localStorage persistence, undo |
| `js/ranking.js` | Pure ranking engine: binary insertion over tie-groups |
| `js/scoring.js` | Ordinal ranking → decimal scores (pure) |
| `js/exportCsv.js` | CSV assembly + download |
| `js/ui.js` | Rendering & events only |
| `js/main.js` | Wiring |

Future features (commander art, Archidekt links, aggregation, the gradient
visualization) slot in without touching the engine: art/links come from the
catalog, aggregation reuses `scoring.js` on merged CSVs, and the
visualization can reuse `powerTint()` from `ui.js` for the continuous scale.
