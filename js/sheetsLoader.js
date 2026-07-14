// ---------------------------------------------------------------------------
// sheetsLoader.js — READ-ONLY access to the playgroup's Google Sheet.
//
// Strategy: Google Sheets API v4 with an API key.
//   1. One request lists all worksheet tabs (players).
//   2. One request per tab fetches its cell values.
//
// This module is deliberately the only file that knows anything about
// Google. It returns plain arrays of { deckName, owner, artUrl, artUrlPartner,
// colorId } objects; if the data source ever changes (CSV upload, different
// API, hardcoded JSON), only this file needs to be replaced.
// ---------------------------------------------------------------------------

import {
  SHEET_ID, API_KEY, DATA_URL, PLAYER_TABS, IGNORED_TABS, IGNORED_DECKS,
} from "./config.js";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/* ---- keyless mode: GViz CSV endpoint ------------------------------------
   For link-shared sheets Google serves any tab as CSV without credentials:
     https://docs.google.com/spreadsheets/d/{id}/gviz/tq?tqx=out:csv&sheet={tab}
   It can't LIST tabs, which is why keyless mode needs PLAYER_TABS. ---------*/

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/quotes/
 *  newlines). ~20 lines beats a dependency for one endpoint. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchTabCsv(title) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(title)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Couldn't load tab "${title}" (${res.status}). Check the tab name in ` +
      `PLAYER_TABS and that the sheet is shared "anyone with the link can view".`
    );
  }
  return parseTabRows(title, parseCsv(await res.text()));
}

async function loadKeyless() {
  const ignored = new Set(IGNORED_TABS.map((t) => t.toLowerCase()));
  const tabs = PLAYER_TABS.filter((t) => !ignored.has(t.trim().toLowerCase()));
  const perTab = await Promise.all(tabs.map(fetchTabCsv));
  return { players: tabs, decks: perTab.flat() };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error?.message ?? "";
    } catch {
      /* body wasn't JSON; the status alone will have to do */
    }
    throw new Error(`Google Sheets request failed (${res.status}). ${detail}`);
  }
  return res.json();
}

/** Returns the list of worksheet tab titles, minus ignored tabs. */
async function fetchTabTitles() {
  const url = `${BASE}/${SHEET_ID}?key=${API_KEY}&fields=sheets.properties(title)`;
  const data = await fetchJson(url);
  const ignored = new Set(IGNORED_TABS.map((t) => t.toLowerCase()));
  return (data.sheets ?? [])
    .map((s) => s.properties.title)
    .filter((title) => !ignored.has(title.trim().toLowerCase()));
}

/** Case-insensitive header lookup: "Deck Name", "deck name", " Deck Name " all match. */
function findColumn(headerRow, wanted) {
  const target = wanted.trim().toLowerCase();
  return headerRow.findIndex((h) => String(h ?? "").trim().toLowerCase() === target);
}

/** Parses one tab's raw grid (array of row arrays) into deck objects.
 *  Shared by both data sources so filtering rules live in exactly one place. */
function parseTabRows(title, rows) {
  if (!rows || rows.length < 2) return []; // header only, or empty tab

  const header = rows[0];
  const colName = findColumn(header, "Deck Name");
  if (colName === -1) return []; // tab doesn't look like a deck list; skip it

  // Optional columns — captured now so future features (commander art,
  // color identity badges) don't need loader changes.
  const colArt = findColumn(header, "Art_URL");
  const colArtPartner = findColumn(header, "Art_URL_Partner");
  const colColorId = findColumn(header, "Color_ID");

  const ignoredDecks = new Set(IGNORED_DECKS.map((d) => d.toLowerCase()));
  const decks = [];
  for (const row of rows.slice(1)) {
    const deckName = String(row[colName] ?? "").trim();
    if (!deckName) continue;
    if (ignoredDecks.has(deckName.toLowerCase())) continue;
    decks.push({
      deckName,
      owner: title.trim(),
      artUrl: colArt >= 0 ? String(row[colArt] ?? "").trim() : "",
      artUrlPartner: colArtPartner >= 0 ? String(row[colArtPartner] ?? "").trim() : "",
      colorId: colColorId >= 0 ? String(row[colColorId] ?? "").trim() : "",
    });
  }
  return decks;
}

/** Data source A: a JSON endpoint (server/server.js or apps-script/Code.gs).
 *  Expects { sheets: [{ title, values }] }. */
async function loadFromDataUrl() {
  const data = await fetchJson(DATA_URL);
  if (!Array.isArray(data.sheets)) {
    throw new Error(
      "The DATA_URL responded, but not with the expected JSON " +
      "({ sheets: [{ title, values }] }). Check the endpoint."
    );
  }
  const ignored = new Set(IGNORED_TABS.map((t) => t.toLowerCase()));
  const tabs = data.sheets.filter((s) => !ignored.has(String(s.title).trim().toLowerCase()));
  return {
    players: tabs.map((s) => s.title),
    decks: tabs.flatMap((s) => parseTabRows(s.title, s.values)),
  };
}

/** Data source B: Sheets API v4 with an API key (link-shared sheet). */
async function fetchTabDecks(title) {
  // The range is just the quoted sheet name → the whole used grid.
  const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
  const url = `${BASE}/${SHEET_ID}/values/${range}?key=${API_KEY}`;
  const data = await fetchJson(url);
  return parseTabRows(title, data.values ?? []);
}

/**
 * Loads every deck from every player tab, using whichever data source is
 * configured: DATA_URL > keyless PLAYER_TABS > API key.
 * @returns {Promise<{players: string[], decks: object[]}>}
 */
export async function loadAllDecks() {
  if (DATA_URL) return loadFromDataUrl();
  if (PLAYER_TABS.length > 0) return loadKeyless();
  const titles = await fetchTabTitles();
  const perTab = await Promise.all(titles.map(fetchTabDecks));
  return { players: titles, decks: perTab.flat() };
}
