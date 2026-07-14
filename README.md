# EDH Bracket Ranker

A zero-backend web app for collectively ranking a Commander playgroup's decks
into the 11 official EDH bracket tiers. Each player places every deck with a
bracket tap plus a few binary-insertion comparisons, progress autosaves to
localStorage, and the result exports as a CSV with deterministic deck IDs and
decimal ratings.

## Setup — pick one data source

All feed the same loader; `js/config.js` decides which is active.

### Option 1: link-shared sheet, zero keys (recommended)

1. Share the sheet **"Anyone with the link can view"**.
2. In `js/config.js`: paste `SHEET_ID` and list your players' tab names in
   `PLAYER_TABS` (Google's keyless CSV endpoint can't discover tabs, so the
   list must be kept in sync if a player joins/renames — that's the whole
   trade-off).
3. Serve the folder over HTTP (`python3 -m http.server` locally, or GitHub
   Pages / Netlify for the group — it's a pure static site in this mode).

### Option 2: your existing service account (`server/server.js`)

Best if you already run something server-side with a service account that
can read the sheet. The sheet stays private and there's no new Google setup.

1. `cd server && npm install`
2. Put the service-account JSON key on the server (outside any web root).
3. `SHEET_ID=<your-sheet-id> KEY_FILE=/path/to/key.json node server.js`
4. In `js/config.js`: `DATA_URL = "/api/decks"`.
5. Open `http://localhost:8787` (the server also serves the app itself).

**Deploying on Render** (a `render.yaml` blueprint is included):

1. Push this folder to a Git repo and create a new **Web Service** on Render
   (or use "New → Blueprint" to pick up `render.yaml` automatically).
   Manual settings if not using the blueprint:
   *Build command* `cd server && npm install`, *Start command*
   `node server/server.js`.
2. In the service's **Environment** tab:
   - Add env var `SHEET_ID` = your sheet's ID.
   - Add a **Secret File** named `service-account.json` with the contents of
     your service-account key; it mounts at `/etc/secrets/service-account.json`,
     which is where the `KEY_FILE` env var already points. Never commit the
     key to the repo.
3. Set `DATA_URL = "/api/decks"` in `js/config.js` before pushing — the
   same service serves both the app and the data, so the relative URL works
   as-is. Share the Render URL with your playgroup and you're live.

Note: Render's free tier spins down idle services, so the first visit after
a quiet spell takes ~30s to wake. Fine for a ranking night; just warn the
group, or use a paid instance if it annoys you.

### Option 3: Apps Script proxy (`apps-script/Code.gs`)

Best if you don't want to host anything. Sheet stays private; a tiny script
runs as the sheet owner. Extensions → Apps Script → paste `Code.gs` →
Deploy as Web app (*Execute as: Me*, *Access: Anyone*) → paste the `/exec`
URL into `DATA_URL`. Details and caveats are in the file's comments.
Then serve the folder over any static host (`python3 -m http.server`,
GitHub Pages, etc.).

### Option 4: link-shared sheet + API key

Share the sheet "anyone with the link can view", create a Google Cloud API
key with the Sheets API enabled (referrer-restricted), fill in `SHEET_ID` +
`API_KEY`. `DATA_URL` takes priority when set, so leave it empty.

## Notes

- **Sheet updates are safe mid-campaign.** Every time a player resumes, the
  app diffs their saved session against the fresh sheet: newly added decks
  join their queue, deleted decks are pruned from their rankings, and a
  small notice says what changed. Renaming a deck (or its owner tab)
  changes its deterministic ID, so it's treated as delete + add and gets
  re-ranked — rename before the campaign if possible.
- **The Scale view** (button in the top bar) shows every placed deck's
  commander art on a continuous power gradient, strongest to weakest, with
  labeled bracket separators — a live preview of the final aggregate
  visualization, per-player for now.
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
