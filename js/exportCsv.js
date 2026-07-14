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

/** RFC-4180-ish escaping: quote any field containing comma/quote/newline. */
function csvField(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The shared row set behind every export path. */
function buildRows(state, catalog) {
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

export function buildCsv(state, catalog) {
  const lines = ["DeckID,DeckName,Owner,Rater,Bracket,NumericRating"];
  for (const r of buildRows(state, catalog)) {
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
  const url =
    `mailto:${EXPORT_EMAIL}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
  const a = document.createElement("a");
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Tab-separated rows to the clipboard — pastes straight into Google Sheets
 *  as proper columns. Returns the clipboard promise so the UI can show
 *  Copied!/failed feedback. */
export function copyForSheet(state, catalog) {
  const lines = ["DeckID\tDeckName\tOwner\tRater\tBracket\tNumericRating"];
  for (const r of buildRows(state, catalog)) {
    lines.push([r.deckId, r.name, r.owner, r.rater, r.bracket, r.rating].join("\t"));
  }
  return navigator.clipboard.writeText(lines.join("\n"));
}
