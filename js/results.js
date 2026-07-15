// ---------------------------------------------------------------------------
// results.js — the aggregate view. Reads the "final" tab of the aggregation
// sheet (DeckID, DeckName, Owner, Bracket, NumericRating, OwnerRating,
// Difference), joins it by DeckID against the live deck catalog (for art and
// Archidekt links), and renders:
//   1. the full-collection power timeline — same axis, same tints, same
//      greedy-lane stacking as the in-app dock, just given room to breathe;
//   2. a ranked list, strongest → weakest, grouped by bracket, with a
//      tap-to-expand detail card per deck (owner's own rating vs the group).
//
// Read-only and standalone: no state, no localStorage, nothing here can
// touch a ranking session. Sheets remain the source of truth.
// ---------------------------------------------------------------------------

import { RESULTS_SHEET_ID, RESULTS_TAB, TIERS } from "./config.js";
import { fetchSheetTabRows, findColumn, loadAllDecks } from "./sheetsLoader.js";
import { Catalog, deckId } from "./catalog.js";
import { powerTint } from "./ui.js";

const app = document.getElementById("app");

/* ---- tiny DOM helper (same shape as ui.js's private one) ---------------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "style") node.setAttribute("style", v);
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

/* ---- parsing the "final" tab --------------------------------------------
   Sheet formulas leak error strings ("#DIV/0!", "#N/A", "#REF!") through the
   CSV endpoint as literal text — decks whose owner hasn't submitted yet, for
   example. Anything that doesn't parse as a finite number is treated as
   "not available yet", never as zero. */
function num(raw) {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  if (!s || s.startsWith("#")) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function parseFinalTab(rows) {
  if (!rows || rows.length < 2) throw new Error(`Tab "${RESULTS_TAB}" looks empty.`);
  const header = rows[0];
  const col = (name) => findColumn(header, name);
  const cId = col("DeckID"), cName = col("DeckName"), cOwner = col("Owner"),
    cBracket = col("Bracket"), cRating = col("NumericRating"),
    cOwnerRating = col("OwnerRating"), cDiff = col("Difference");
  if (cName === -1 || cRating === -1) {
    throw new Error(`Tab "${RESULTS_TAB}" is missing a DeckName or NumericRating column.`);
  }
  const out = [];
  for (const row of rows.slice(1)) {
    const name = String(row[cName] ?? "").trim();
    const score = num(cRating >= 0 ? row[cRating] : null);
    if (!name || score === null) continue; // not yet aggregated → not shown
    const owner = cOwner >= 0 ? String(row[cOwner] ?? "").trim() : "";
    out.push({
      // Trust the sheet's DeckID; fall back to recomputing the same hash.
      id: cId >= 0 && String(row[cId] ?? "").trim()
        ? String(row[cId]).trim()
        : deckId(owner, name),
      name,
      owner,
      bracket: cBracket >= 0 ? String(row[cBracket] ?? "").trim() : "",
      score,
      ownerRating: num(cOwnerRating >= 0 ? row[cOwnerRating] : null),
      diff: num(cDiff >= 0 ? row[cDiff] : null),
    });
  }
  if (!out.length) throw new Error(`No scored decks found in "${RESULTS_TAB}".`);
  return out;
}

/* ---- bracket helpers ------------------------------------------------------
   Group headers use the sheet's Bracket label when present; the tier a score
   falls in is derived from the fixed intervals either way, since the tint
   and grouping should always agree with the number. */
function tierOf(score) {
  for (const t of TIERS) if (score >= t.low && score < t.high) return t;
  return score >= TIERS.at(-1).high ? TIERS.at(-1) : TIERS[0];
}
const tint = (score) => powerTint((score - 1) / 5);

/* ---- art helpers ---------------------------------------------------------- */
function monogram(entry, cls) {
  return el("div", { class: `${cls} placeholder`, title: entry.name },
    entry.name.slice(0, 2).toUpperCase());
}
function thumbFor(entry, cls) {
  if (!entry.art) return monogram(entry, cls);
  return el("img", {
    class: cls, src: entry.art, alt: entry.name, loading: "lazy",
    onerror: (ev) => ev.target.replaceWith(monogram(entry, cls)),
  });
}

/* ---- timeline (the app's dock, promoted to a hero) ------------------------ */
let timelineEntries = [];

function renderTimeline(entries) {
  timelineEntries = [...entries].sort(
    (a, b) => a.score - b.score || a.name.localeCompare(b.name));

  const canvas = el("div", { class: "dock-canvas results-canvas" });
  const axis = el("div", { class: "dock-axis" });
  const tickAt = (v, major) => el("span", {
    class: `dock-tick${major ? " major" : ""}`,
    style: `left:${((v - 1) / 5) * 100}%`,
  });
  for (const v of [2, 3, 4, 5]) axis.append(tickAt(v, true));
  for (const base of [2, 3, 4]) axis.append(tickAt(base + 1 / 3), tickAt(base + 2 / 3));
  const labels = el("div", { class: "dock-labels" },
    ...["B1", "B2", "B3", "B4", "B5"].map((b) => el("span", {}, b)));

  const wrap = el("section", { class: "results-timeline" }, canvas, axis, labels);
  requestAnimationFrame(layoutTimeline);
  return wrap;
}

/* Same greedy-lane algorithm as ui.js's _layoutDock, with a roomier height
   cap (this page is a destination, not a fixed footer) and click-to-scroll
   instead of click-to-rerank. */
function layoutTimeline() {
  const canvas = document.querySelector(".results-canvas");
  if (!canvas || !timelineEntries.length) return;
  const W = canvas.clientWidth;
  const base = W < 480 ? 30 : 40;
  const density = W / timelineEntries.length;
  const THUMB = Math.round(Math.max(20, Math.min(base, density * 1.6)));
  const LANE = Math.round(THUMB * 0.76);
  const MAX_LANES = 7;

  let gap = Math.round(THUMB * 0.6);
  let placed, maxLane;
  do {
    placed = [];
    maxLane = 0;
    const laneRight = [];
    for (const e of timelineEntries) {
      const x = ((e.score - 1) / 5) * (W - THUMB);
      let lane = 0;
      while (laneRight[lane] !== undefined && x - laneRight[lane] < gap) lane++;
      laneRight[lane] = x;
      maxLane = Math.max(maxLane, lane);
      placed.push({ e, x, lane });
    }
    gap -= 3;
  } while (maxLane >= MAX_LANES && gap > 3);

  const MAX_H = W < 480 ? 140 : 200;
  const laneStep = maxLane > 0
    ? Math.min(LANE, Math.max(8, Math.floor((MAX_H - THUMB) / maxLane)))
    : LANE;

  canvas.replaceChildren();
  for (const { e, x, lane } of placed) {
    const thumb = thumbFor(e, "dock-thumb");
    thumb.title = `${e.name} (${e.owner}) — ${e.score.toFixed(2)}`;
    thumb.style.left = `${x}px`;
    thumb.style.bottom = `${lane * laneStep}px`;
    thumb.style.width = thumb.style.height = `${THUMB}px`;
    thumb.style.zIndex = lane + 1;
    thumb.addEventListener("click", () => jumpToDeck(e.id));
    canvas.append(thumb);
  }
  canvas.style.height = `${maxLane * laneStep + THUMB + 4}px`;
}

/** Timeline thumb tapped → scroll its list row into view and flash it. */
function jumpToDeck(id) {
  const row = document.querySelector(`.result-row[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash"); // restart animation if re-tapped
  void row.offsetWidth;
  row.classList.add("flash");
}

/* ---- ranked list ----------------------------------------------------------
   Strongest first. Rows expand on tap — small thumbs on phones mean detail
   belongs behind a deliberate second look, same philosophy as the dock's
   two-step info bar. */
function renderList(entries) {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const list = el("section", { class: "results-list" });
  let lastTier = null;
  sorted.forEach((e, i) => {
    const tier = tierOf(e.score);
    if (tier !== lastTier) {
      lastTier = tier;
      list.append(el("h2", {
        class: "results-tier-head",
        style: `--tier-tint:${tint((tier.low + tier.high) / 2)}`,
      }, e.bracket || tier.label));
    }
    list.append(resultRow(e, i + 1));
  });
  return list;
}

function resultRow(e, rank) {
  const scoreChip = el("span", {
    class: "score-chip",
    style: `--tier-tint:${tint(e.score)}`,
  }, e.score.toFixed(2));

  const head = el("div", { class: "result-head" },
    el("span", { class: "result-rank" }, `${rank}`),
    thumbFor(e, "result-thumb"),
    el("span", { class: "result-name" },
      e.name, " ",
      el("span", { class: "who" }, `· ${e.owner}`)),
    scoreChip,
  );

  const row = el("article", { class: "result-row" }, head);
  row.dataset.id = e.id;

  let detail = null;
  head.addEventListener("click", () => {
    if (detail) { detail.remove(); detail = null; row.classList.remove("open"); return; }
    detail = resultDetail(e);
    row.append(detail);
    row.classList.add("open");
  });
  return row;
}

function resultDetail(e) {
  const bits = [];

  // Commander art, full width; partners side by side in the app's letterbox
  // style. Missing art simply omits the panel — the row already identifies
  // the deck.
  if (e.art && e.artPartner) {
    bits.push(el("div", { class: "detail-art partners" },
      el("img", { src: e.art, alt: "", loading: "lazy", onerror: hideOnError }),
      el("img", { src: e.artPartner, alt: "", loading: "lazy", onerror: hideOnError }),
    ));
  } else if (e.art) {
    bits.push(el("div", { class: "detail-art" },
      el("img", { src: e.art, alt: "", loading: "lazy", onerror: hideOnError })));
  }

  // Group score vs the owner's own take. The sign framing ("above/below the
  // table") reads better than a bare signed decimal.
  const stats = el("dl", { class: "detail-stats" },
    el("div", {}, el("dt", {}, "Group rating"), el("dd", {}, e.score.toFixed(2))),
  );
  if (e.ownerRating !== null) {
    stats.append(el("div", {},
      el("dt", {}, `${e.owner}'s own rating`), el("dd", {}, e.ownerRating.toFixed(2))));
    const d = e.diff ?? (e.ownerRating - e.score);
    const cls = d > 0.05 ? "up" : d < -0.05 ? "down" : "even";
    const word = d > 0.05 ? "above the table" : d < -0.05 ? "below the table" : "in line with the table";
    stats.append(el("div", {},
      el("dt", {}, "Owner vs group"),
      el("dd", { class: `diff ${cls}` }, `${d >= 0 ? "+" : ""}${d.toFixed(2)} — ${word}`)));
  } else {
    stats.append(el("div", {},
      el("dt", {}, `${e.owner}'s own rating`),
      el("dd", { class: "pending" }, "not submitted yet")));
  }
  bits.push(stats);

  if (e.archidektUrl) {
    bits.push(el("a", {
      class: "decklist-link", href: e.archidektUrl, target: "_blank", rel: "noopener",
    }, "Decklist ↗"));
  }
  return el("div", { class: "result-detail" }, ...bits);
}
function hideOnError(ev) { ev.target.remove(); }

/* ---- boot ------------------------------------------------------------------ */
async function boot() {
  try {
    // Scores and catalog load in parallel; a catalog failure only costs art
    // and links, never the rankings themselves.
    const [finalRows, catalogResult] = await Promise.all([
      fetchSheetTabRows(RESULTS_SHEET_ID, RESULTS_TAB),
      loadAllDecks().catch((err) => {
        console.warn("Deck catalog unavailable — rendering without art.", err);
        return { decks: [] };
      }),
    ]);
    const entries = parseFinalTab(finalRows);
    const catalog = new Catalog(catalogResult.decks);

    // The join: aggregation sheet owns the numbers, data sheet owns the
    // presentation. A deck missing from the catalog (renamed, excluded)
    // still renders — just as text.
    for (const e of entries) {
      const d = catalog.get(e.id);
      e.art = d?.artUrl || "";
      e.artPartner = d?.artUrlPartner || "";
      e.archidektUrl = d?.archidektUrl || "";
    }

    const owners = new Set(entries.map((e) => e.owner).values());
    app.replaceChildren(
      el("header", { class: "results-header" },
        el("h1", {}, "The Table Has Spoken"),
        el("p", { class: "results-sub" },
          `${entries.length} decks · ${owners.size} owners · group averages`),
      ),
      renderTimeline(entries),
      renderList(entries),
      el("footer", { class: "results-footer" },
        "Scores are the group's mean rating on the fixed bracket scale (1–6). ",
        "Tap any deck for its owner's own take."),
    );
    window.addEventListener("resize", layoutTimeline);
  } catch (err) {
    console.error(err);
    app.replaceChildren(
      el("div", { class: "notice" },
        el("strong", {}, "Couldn't load results. "),
        el("div", {}, String(err.message ?? err)),
      ));
  }
}

boot();
