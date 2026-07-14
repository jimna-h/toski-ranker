# EDH Bracket Ranker

A zero-backend web app for collectively ranking a Commander playgroup's decks
into the 11 official EDH bracket tiers. Each player places every deck with a
bracket tap plus a few binary-insertion comparisons, progress autosaves to
localStorage, and the result exports as a CSV with deterministic deck IDs and
decimal ratings.

## Setup

1. **Share the Google Sheet** as "Anyone with the link can view".
2. **Create an API key** in Google Cloud Console:
   - Create a project (or reuse one) → APIs & Services → enable **Google Sheets API**.
   - Credentials → Create credentials → **API key**.
   - Restrict the key: *Application restrictions* → HTTP referrers → add your
     hosting URL (e.g. `https://yourname.github.io/*`).
     *API restrictions* → Google Sheets API only.
3. **Edit `js/config.js`**: paste `SHEET_ID` (from the sheet URL) and `API_KEY`.
4. **Serve the folder over HTTP** — ES modules don't run from `file://`.
   Locally: `python3 -m http.server` in this folder, then open
   `http://localhost:8000`. For the group: GitHub Pages, Netlify, or any
   static host works.

## Notes

- Sheet parsing: every worksheet tab is a player; the `Precons` tab and any
  deck named `PFP` are ignored (see `IGNORED_TABS` / `IGNORED_DECKS` in
  `js/config.js`). Only the `Deck Name` column is required; `Art_URL`,
  `Art_URL_Partner`, and `Color_ID` are captured for future features.
- Progress is saved per player per browser. Clearing site data erases it.
- Deck IDs are FNV-1a hashes of `owner + deckName`, so they stay stable
  across sessions and users as long as neither changes.
- CSV columns: `DeckID,DeckName,Owner,Bracket,NumericRating`. Skipped decks
  are excluded (restorable from the Review screen before export).

## Architecture

| File | Responsibility |
|---|---|
| `js/config.js` | Sheet/API config, tier definitions & score intervals |
| `js/sheetsLoader.js` | Read-only Google Sheets fetch (only file that knows Google) |
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
