// ---------------------------------------------------------------------------
// server/server.js — optional self-hosted alternative to the Apps Script
// proxy, for groups that already have a service account with access to the
// sheet (and somewhere server-side to run it).
//
// It does two things:
//   1. Serves the static app (the parent folder).
//   2. Serves GET /api/decks — the sheet's tabs + cell values as JSON, read
//      with the service account. Same response shape as the Apps Script
//      proxy, so the client loader doesn't know or care which one it's
//      talking to.
//
// The service-account key stays on the server. It is never sent to browsers.
//
// SETUP:
//   1. npm install            (in this folder; only dependency: googleapis)
//   2. Put your service-account JSON key somewhere OUTSIDE any web root and
//      point KEY_FILE at it (env var or edit below). The sheet must already
//      be shared with the service account's email — which yours is.
//   3. SHEET_ID=<id> node server.js     → http://localhost:8787
//   4. In js/config.js set:  DATA_URL = "/api/decks"
//      (same-origin relative URL — works because this server also serves
//      the app itself).
// ---------------------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const PORT = process.env.PORT || 8787;
const SHEET_ID = process.env.SHEET_ID || "PASTE_YOUR_SHEET_ID_HERE";
const KEY_FILE = process.env.KEY_FILE || "./service-account.json";
const APP_ROOT = path.join(__dirname, ".."); // the static app lives one level up

// Cache sheet reads briefly so a whole playgroup loading at once costs one
// API call, not eight.
const CACHE_MS = 60_000;
let cache = { at: 0, body: null };

async function readSheet() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // One call for tab names, one batch call for all values.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties.title",
  });
  const titles = meta.data.sheets.map((s) => s.properties.title);
  const values = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: titles.map((t) => `'${t.replace(/'/g, "''")}'`),
  });

  const body = JSON.stringify({
    sheets: titles.map((title, i) => ({
      title,
      values: values.data.valueRanges[i].values ?? [],
    })),
  });
  cache = { at: Date.now(), body };
  return body;
}

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".md": "text/plain",
};

http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/decks") {
      const body = await readSheet();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    // Static file serving, confined to APP_ROOT (path.normalize + prefix
    // check prevents ../ traversal).
    const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const filePath = path.normalize(path.join(APP_ROOT, urlPath));
    if (!filePath.startsWith(APP_ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(data);
    });
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(PORT, () => {
  console.log(`EDH Bracket Ranker → http://localhost:${PORT}`);
});
