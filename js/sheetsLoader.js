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

import { SHEET_ID, API_KEY, IGNORED_TABS, IGNORED_DECKS } from "./config.js";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

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

/** Fetches one player's tab and returns their decks. */
async function fetchTabDecks(title) {
  // The range is just the quoted sheet name → the whole used grid.
  const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
  const url = `${BASE}/${SHEET_ID}/values/${range}?key=${API_KEY}`;
  const data = await fetchJson(url);
  const rows = data.values ?? [];
  if (rows.length < 2) return []; // header only, or empty tab

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

/**
 * Loads every deck from every player tab.
 * @returns {Promise<{players: string[], decks: object[]}>}
 */
export async function loadAllDecks() {
  const titles = await fetchTabTitles();
  const perTab = await Promise.all(titles.map(fetchTabDecks));
  return { players: titles, decks: perTab.flat() };
}
