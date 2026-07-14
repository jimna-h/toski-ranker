// ---------------------------------------------------------------------------
// exportCsv.js — assembles the results and gets them to James.
// Three paths, all from the same row builder:
//   • downloadCsv  — classic file download
//   • emailCsv     — mailto: with the CSV preloaded in the body
//   • copyForSheet — TSV to the clipboard (pastes into Sheets as columns)
// Columns: DeckID,DeckName,Owner,Rater,Bracket,NumericRating
// Skipped decks are excluded. Rows sorted by rating (strongest last).
// ---------------------------------------------------------------------------

import { computeScores } from "./scoring.js";
import { tierById, EXPORT_EMAIL } from "./config.js";

const HEADER = ["DeckID", "DeckName", "Owner", "Rater", "Bracket", "NumericRating"];

/** The shared row model every export format is built from. */
function csvRows(state, catalog) {
  const scores = computeScores(state.buckets);
  return [...scores.entries()]
    .map(([deckId, { score, tierId }]) => {
      const deck = catalog.get(deckId);
      return {
        deckId,
        name: deck?.deckName ?? "(unknown)",
        owner: deck?.owner ?? "(unknown)",
        rater: state.player,
        bracket: tierById[tierId].label,
        // 3 decimals: enough precision that dense tiers don't collide when
        // rounded, without implying false accuracy.
        rating: score.toFixed(3),
      };
    })
    .sort((a, b) => a.rating - b.rating);
}

/** RFC-4180-ish escaping: quote any field containing comma/quote/newline. */
function csvField(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(state, catalog) {
  const lines = [HEADER.join(",")];
  for (const r of csvRows(state, catalog)) {
    lines.push(
      [r.deckId, csvField(r.name), csvField(r.owner), csvField(r.rater), r.bracket, r.rating].join(",")
    );
  }
  return lines.join("\r\n");
}

export function downloadCsv(state, catalog) {
  const csv = buildCsv(state, catalog);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `edh-rankings-${state.player.replace(/\s+/g, "_")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** TSV to the clipboard — pasting into Google Sheets splits into columns,
 *  so "Copy for spreadsheet" → Ctrl+V lands ready-made in the aggregation
 *  sheet. (Tabs never appear in the data, so no escaping needed.) */
export async function copyForSheet(state, catalog) {
  const lines = [HEADER.join("\t")];
  for (const r of csvRows(state, catalog)) {
    lines.push([r.deckId, r.name, r.owner, r.rater, r.bracket, r.rating].join("\t"));
  }
  await navigator.clipboard.writeText(lines.join("\n"));
}

/** Opens the user's mail app with the CSV preloaded in the body.
 *  mailto: can't attach files and some clients truncate very long bodies,
 *  so two defenses: (1) the file download fires first as the reliable copy,
 *  and (2) the body ends with an END OF DATA sentinel — the header tells
 *  the sender to check for it before hitting Send, making truncation
 *  self-evident instead of silent. The sentinel lives only in the email,
 *  never in the downloaded file, so pasted aggregates stay clean. */
export function emailCsv(state, catalog) {
  downloadCsv(state, catalog); // the reliable copy
  const subject = `EDH Rankings — ${state.player}`;
  const body =
    `Rankings from ${state.player}. Paste-ready CSV below.\n` +
    `IMPORTANT: the last line below should say "=== END OF DATA ===". ` +
    `If it doesn't, this email got cut off — attach the downloaded CSV file instead.\n\n` +
    buildCsv(state, catalog) +
    `\n=== END OF DATA ===`;
  location.href =
    `mailto:${EXPORT_EMAIL}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
}
