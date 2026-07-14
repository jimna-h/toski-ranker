// ---------------------------------------------------------------------------
// exportCsv.js — assembles and downloads the results CSV.
// Columns: DeckID,DeckName,Owner,Bracket,NumericRating
// Skipped decks are excluded. Rows are sorted by rating (strongest last)
// so the file is human-readable before any spreadsheet work.
// ---------------------------------------------------------------------------

import { computeScores } from "./scoring.js";
import { tierById } from "./config.js";

/** RFC-4180-ish escaping: quote any field containing comma/quote/newline. */
function csvField(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(state, catalog) {
  const scores = computeScores(state.buckets);
  const rows = [...scores.entries()]
    .map(([deckId, { score, tierId }]) => {
      const deck = catalog.get(deckId);
      return {
        deckId,
        name: deck?.deckName ?? "(unknown)",
        owner: deck?.owner ?? "(unknown)",
        bracket: tierById[tierId].label,
        // 3 decimals: enough precision that dense tiers don't collide when
        // rounded, without implying false accuracy.
        rating: score.toFixed(3),
      };
    })
    .sort((a, b) => a.rating - b.rating);

  const lines = ["DeckID,DeckName,Owner,Rater,Bracket,NumericRating"];
  for (const r of rows) {
    lines.push(
      [r.deckId, csvField(r.name), csvField(r.owner), csvField(state.player), r.bracket, r.rating].join(",")
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
