// ---------------------------------------------------------------------------
// sheetsLoader.js — READ-ONLY access to the playgroup's Google Sheet.
//
// Strategy: Google's keyless GViz CSV endpoint, which serves any tab of a
// link-shared sheet without credentials:
//   https://docs.google.com/spreadsheets/d/{id}/gviz/tq?tqx=out:csv&sheet={tab}
// It can't LIST tabs, which is why PLAYER_TABS lives in config.js.
//
// This module is deliberately the only file that knows anything about
// Google. It returns plain arrays of { deckName, owner, artUrl,
// artUrlPartner, colorId, archidektUrl }; if the data source ever changes,
// only this file needs to be replaced.
// ---------------------------------------------------------------------------

import { SHEET_ID, PLAYER_TABS, IGNORED_TABS, IGNORED_DECKS } from "./config.js";

/** Case-insensitive header lookup: "Deck Name", "deck name", " Deck Name " all match. */
function findColumn(headerRow, wanted) {
  const target = wanted.trim().toLowerCase();
  return headerRow.findIndex((h) => String(h ?? "").trim().toLowerCase() === target);
}

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

/** Parses one tab's raw grid (array of row arrays) into deck objects. */
function parseTabRows(title, rows) {
  if (!rows || rows.length < 2) return []; // header only, or empty tab

  const header = rows[0];
  const colName = findColumn(header, "Deck Name");
  if (colName === -1) return []; // tab doesn't look like a deck list; skip it

  // Optional columns — captured so future features (color identity badges)
  // don't need loader changes.
  const colArt = findColumn(header, "Art_URL");
  const colArtPartner = findColumn(header, "Art_URL_Partner");
  const colColorId = findColumn(header, "Color_ID");
  const colExclude = findColumn(header, "Exclude");
  const colArchidekt = findColumn(header, "Archidekt");

  const ignoredDecks = new Set(IGNORED_DECKS.map((d) => d.toLowerCase()));
  const decks = [];
  for (const row of rows.slice(1)) {
    const deckName = String(row[colName] ?? "").trim();
    if (!deckName) continue;
    if (ignoredDecks.has(deckName.toLowerCase())) continue;
    // Sheet checkbox column: GViz renders checked boxes as "TRUE".
    if (colExclude >= 0 && String(row[colExclude] ?? "").trim().toLowerCase() === "true") continue;

    // Only accept Archidekt values that are actual links; stray text in the
    // column shouldn't become a broken button.
    const archidektRaw = colArchidekt >= 0 ? String(row[colArchidekt] ?? "").trim() : "";
    const archidektUrl = /^https?:\/\//i.test(archidektRaw) ? archidektRaw : "";

    decks.push({
      deckName,
      owner: title.trim(),
      artUrl: colArt >= 0 ? String(row[colArt] ?? "").trim() : "",
      artUrlPartner: colArtPartner >= 0 ? String(row[colArtPartner] ?? "").trim() : "",
      colorId: colColorId >= 0 ? String(row[colColorId] ?? "").trim() : "",
      archidektUrl,
    });
  }
  return decks;
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

/**
 * Loads every deck from every player tab.
 * @returns {Promise<{players: string[], decks: object[]}>}
 */
export async function loadAllDecks() {
  const ignored = new Set(IGNORED_TABS.map((t) => t.toLowerCase()));
  const tabs = PLAYER_TABS.filter((t) => !ignored.has(t.trim().toLowerCase()));
  const perTab = await Promise.all(tabs.map(fetchTabCsv));
  return { players: tabs, decks: perTab.flat() };
}
