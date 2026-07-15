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

/** Timeline thumb tapped → scroll its gallery card into view and flash it. */
function jumpToDeck(id) {
  const card = document.querySelector(`.deck-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("flash"); // restart animation if re-tapped
  void card.offsetWidth;
  card.classList.add("flash");
}

/* ---- tier gallery ----------------------------------------------------------
   The done-screen idea, promoted: strongest tier first, each tier a tinted
   band holding art cards. Cards are art-dominant — name and score live in a
   thin gradient caption; everything else waits in the lightbox. Text only
   where a picture can't do the job. */
function renderGallery(entries) {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const wrap = el("section", { class: "results-gallery" });
  let band = null, lastTier = null, rank = 0;
  for (const e of sorted) {
    rank++;
    const tier = tierOf(e.score);
    if (tier !== lastTier) {
      lastTier = tier;
      const tierTint = tint((tier.low + tier.high) / 2);
      band = el("div", { class: "tier-grid" });
      wrap.append(
        el("section", { class: "tier-band", style: `--tier-tint:${tierTint}` },
          el("h2", { class: "tier-band-label" }, e.bracket || tier.label),
          band));
    }
    band.append(deckCard(e, rank));
  }
  return wrap;
}

function deckCard(e, rank) {
  const card = el("article", {
    class: "deck-card",
    style: `--tier-tint:${tint(e.score)}`,
    onclick: () => openLightbox(e, rank),
  });
  card.dataset.id = e.id;

  // Art fills the card; partners split it. No art → tinted monogram panel.
  if (e.art && e.artPartner) {
    card.append(el("div", { class: "card-art partners" },
      el("img", { src: e.art, alt: "", loading: "lazy", onerror: hideOnError }),
      el("img", { src: e.artPartner, alt: "", loading: "lazy", onerror: hideOnError })));
  } else if (e.art) {
    card.append(el("div", { class: "card-art" },
      el("img", { src: e.art, alt: e.name, loading: "lazy",
        onerror: (ev) => ev.target.parentElement.replaceWith(monogramPanel(e)) })));
  } else {
    card.append(monogramPanel(e));
  }

  // Top three across the whole table get a medal, because of course they do.
  if (rank <= 3) card.append(el("span", { class: "card-medal" }, ["🥇", "🥈", "🥉"][rank - 1]));

  card.append(el("div", { class: "card-caption" },
    el("span", { class: "card-name" }, e.name),
    el("span", { class: "card-score" }, e.score.toFixed(2))));
  return card;
}

function monogramPanel(e) {
  return el("div", { class: "card-art monogram" }, e.name.slice(0, 2).toUpperCase());
}

/* ---- lightbox --------------------------------------------------------------
   Tap a card → full-bleed art with the numbers drawn, not written: a slice
   of the power gradient with two pins — the table's rating and the owner's
   own. The gap between the pins IS the owner-bias stat. */
function openLightbox(e, rank) {
  closeLightbox();
  const artEls = e.art && e.artPartner
    ? [el("div", { class: "lb-art partners" },
        el("img", { src: e.art, alt: "", onerror: hideOnError }),
        el("img", { src: e.artPartner, alt: "", onerror: hideOnError }))]
    : e.art
      ? [el("div", { class: "lb-art" },
          el("img", { src: e.art, alt: e.name, onerror: hideOnError }))]
      : [];

  const box = el("div", { class: "lightbox", onclick: (ev) => {
    if (ev.target === box) closeLightbox();
  }},
    el("div", { class: "lb-panel" },
      el("button", { class: "lb-close", onclick: closeLightbox }, "\u2715"),
      ...artEls,
      el("div", { class: "lb-title" },
        el("span", { class: "lb-name" }, e.name),
        el("span", { class: "lb-meta" }, `#${rank} \u00b7 ${e.owner}`)),
      miniAxis(e),
      el("div", { class: "lb-actions" },
        e.archidektUrl
          ? el("a", { class: "decklist-link", href: e.archidektUrl,
              target: "_blank", rel: "noopener" }, "Decklist \u2197")
          : "",
      ),
    ));
  document.body.append(box);
  document.body.classList.add("lb-open");
}

function closeLightbox() {
  document.querySelector(".lightbox")?.remove();
  document.body.classList.remove("lb-open");
}
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeLightbox(); });

/** A zoomed slice of the power axis around this deck's bracket, with a pin
 *  for the group's rating and (when submitted) a second pin for the owner's
 *  own — the visual replacement for v1's stats table. */
function miniAxis(e) {
  const scores = [e.score, e.ownerRating].filter((v) => v !== null);
  // Window: the deck's whole bracket, padded so pins never sit on the edge,
  // widened if the owner's rating strays outside it; clamped to 1–6.
  const t = tierOf(e.score);
  const bracketLow = Math.floor(t.low);
  const bracketHigh = bracketLow + 1;
  let lo = Math.max(1, Math.min(bracketLow, ...scores) - 0.15);
  let hi = Math.min(6, Math.max(bracketHigh, ...scores) + 0.15);
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;

  // The slice must show the same colors this range has on the full axis —
  // sample powerTint along the window and stretch between the samples.
  const axis = el("div", {
    class: "mini-axis",
    style: `background: linear-gradient(90deg, ${tint(lo)}, ${tint((lo + hi) / 2)}, ${tint(hi)})`,
  });
  // Sub-tier ticks inside the window (thirds; majors at whole brackets).
  for (let k = Math.ceil(lo * 3); k <= Math.floor(hi * 3); k++) {
    const v = k / 3;
    if (v <= lo + 0.01 || v >= hi - 0.01) continue;
    axis.append(el("span", {
      class: `mini-tick${k % 3 === 0 ? " major" : ""}`,
      style: `left:${pos(v)}%`,
    }));
  }

  const pinEl = (cls, v, label) => {
    const p = el("div", { class: `mini-pin ${cls}`, style: `left:${pos(v)}%` },
      el("span", { class: "pin-label" }, label));
    // Labels are centered on the pin; near an edge, hang them inward instead
    // so they never clip out of the panel.
    const pct = pos(v);
    if (pct < 14) p.classList.add("edge-left");
    else if (pct > 86) p.classList.add("edge-right");
    return p;
  };
  const pins = el("div", { class: "mini-pins" },
    pinEl("group", e.score, `table ${e.score.toFixed(2)}`));
  if (e.ownerRating !== null) {
    pins.append(pinEl("owner", e.ownerRating, `${e.owner} ${e.ownerRating.toFixed(2)}`));
  } else {
    pins.append(el("div", { class: "mini-pending" }, `${e.owner}: pending`));
  }

  const labels = el("div", { class: "mini-labels" },
    el("span", {}, `B${Math.round(lo)}`), el("span", {}, `B${Math.round(hi)}`));
  return el("div", { class: "mini-axis-wrap" }, pins, axis, labels);
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
      renderGallery(entries),
      el("footer", { class: "results-footer" },
        "Scores are the group's mean rating on the fixed bracket scale (1–6). ",
        "Tap any deck: pins show the table's rating vs the owner's own."),
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
