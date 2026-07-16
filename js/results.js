// ---------------------------------------------------------------------------
// results.js — the aggregate view. Reads the "final" tab of the aggregation
// sheet (DeckID, DeckName, Owner, NumericRating, OwnerRating, Difference),
// joins it by DeckID (with rename/whitespace-tolerant fallbacks) against the
// live deck catalog (art, color identity, Archidekt links), and renders:
//   1. filter chips — players, then color Include and color Exclude rows;
//   2. the full-collection power timeline (compact & sticky, or expanded to
//      the full viewport width);
//   3. tier bands of art cards, strongest first, with owner-vs-table badges
//      and a lightbox that draws the stat as pins on a gradient slice.
//
// Filtering semantics (per James):
//   • a deck is shown iff its OWNER's chip is on, AND
//   • at least one of its colors is in the Include set (colorless rides ◇),
//   • AND none of its colors is in the Exclude set. Include defaults to
//     everything on; Exclude defaults to everything off — "show me decks
//     without blue" is one tap on Exclude-U instead of four on Include.
//
// Architecture note: the DOM is built ONCE. Filters toggle a .hidden class
// and re-position timeline thumbs — nothing is rebuilt, so no image ever
// reloads and the page never flashes or jumps on a toggle.
//
// Read-only and standalone: no state, no localStorage, nothing here can
// touch a ranking session. Sheets remain the source of truth.
// ---------------------------------------------------------------------------

import { RESULTS_SHEET_ID, RESULTS_TAB, RAW_TAB, TIERS } from "./config.js";
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

/* ---- parsing the "final" tab ----------------------------------------------
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
    cRating = col("NumericRating"), cOwnerRating = col("OwnerRating"),
    cDiff = col("Difference"), cIdentity = col("Identity"),
    cStdev = col("StdDev");
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
      score,
      ownerRating: num(cOwnerRating >= 0 ? row[cOwnerRating] : null),
      diff: num(cDiff >= 0 ? row[cDiff] : null),
      stdevFinal: num(cStdev >= 0 ? row[cStdev] : null),
      // The catalog's Color_ID wins later; this is the fallback.
      identityRaw: cIdentity >= 0 ? String(row[cIdentity] ?? "").trim() : "",
    });
  }
  if (!out.length) throw new Error(`No scored decks found in "${RESULTS_TAB}".`);
  return out;
}

/** Raw tab → Map(deckId → Map(rater → rating)) plus the rater list. Header:
 *  DeckID, DeckName, Owner, Rater, Bracket, NumericRating. Tolerant of a
 *  missing tab (returns empties — the lens row then offers Table/Owner only). */
function parseRawTab(rows) {
  const byDeck = new Map();
  const raters = new Set();
  if (!rows || rows.length < 2) return { byDeck, raters: [] };
  const header = rows[0];
  const cId = findColumn(header, "DeckID"), cRater = findColumn(header, "Rater"),
    cRating = findColumn(header, "NumericRating");
  if (cId === -1 || cRater === -1 || cRating === -1) return { byDeck, raters: [] };
  for (const row of rows.slice(1)) {
    const id = String(row[cId] ?? "").trim();
    const rater = String(row[cRater] ?? "").trim();
    const rating = num(row[cRating]);
    if (!id || !rater || rating === null) continue;
    raters.add(rater);
    if (!byDeck.has(id)) byDeck.set(id, new Map());
    byDeck.get(id).set(rater, rating);
  }
  return { byDeck, raters: [...raters].sort() };
}

/* ---- bracket helpers --------------------------------------------------------
   Band labels ALWAYS come from the fixed score intervals, never from the
   sheet's Bracket text: grouping is by interval, and a sheet label computed
   with slightly different boundary rounding once put "B3 Mid" over a B3 Low
   band. One source of truth for what a number means. */
function tierOf(score) {
  for (const t of TIERS) if (score >= t.low && score < t.high) return t;
  return score >= TIERS.at(-1).high ? TIERS.at(-1) : TIERS[0];
}
const tint = (score) => powerTint((score - 1) / 5);

/* ---- color identity ----------------------------------------------------------
   Identities arrive as strings like "WUBRG", "wur", "R/G" — extract only
   WUBRG letters, in canonical order. No letters at all → colorless. */
const WUBRG = ["W", "U", "B", "R", "G"];
const COLOR_C = "C";
function parseIdentity(raw) {
  const letters = new Set(
    String(raw ?? "").toUpperCase().split("").filter((ch) => WUBRG.includes(ch)));
  return WUBRG.filter((c) => letters.has(c)); // canonical order, [] = colorless
}

/* ---- filter state ------------------------------------------------------------ */
const filters = {
  players: new Set(),                       // filled at boot
  include: new Set([...WUBRG, COLOR_C]),    // all on by default
  exclude: new Set(),                       // all off by default
};
let allPlayers = [];

function passesFilters(e) {
  if (dynScore(e) === null) return false;
  if (!filters.players.has(e.owner)) return false;
  if (e.colors.length === 0) {
    return filters.include.has(COLOR_C) && !filters.exclude.has(COLOR_C);
  }
  if (e.colors.some((c) => filters.exclude.has(c))) return false; // veto
  return e.colors.some((c) => filters.include.has(c));            // union
}
/* ---- rater include filter --------------------------------------------------------
   "Ratings by" is a multi-select over raters, all on by default — the
   displayed score for every deck is the MEAN OF THE ENABLED RATERS' ratings,
   recomputed live from the Raw tab. Everything on therefore IS the table
   average, so there is no separate "Table" chip. The Owner chip gates
   self-ratings: a rating by R on deck D counts iff R's chip is on AND
   (R isn't D's owner, or the Owner chip is on). Turning Owner off shows
   every deck at its mean-excluding-owner; turning off all but one rater
   shows the table exactly as that person sees it.
   The rater list is the union of raters seen in Raw and the deck owners, so
   players who haven't submitted yet still get a chip (it just contributes
   no ratings until they do). */
let allRaters = [];
const raters = { on: new Set(), ownerCounted: true };

function ratersPristine() {
  return raters.on.size === allRaters.length && raters.ownerCounted;
}

function countedRatings(e) {
  const out = [];
  for (const [r, v] of e.ratings) {
    if (!raters.on.has(r)) continue;
    if (r === e.owner && !raters.ownerCounted) continue;
    out.push(v);
  }
  return out;
}

/** Mean of the enabled raters' ratings; null hides the deck. Falls back to
 *  the final tab's precomputed mean if the Raw tab never loaded. */
function dynScore(e) {
  if (!e.ratings.size) return ratersPristine() ? e.score : null;
  const vals = countedRatings(e);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Sample stdev over the same counted ratings (null below 2 samples). */
function dynStdev(e) {
  const vals = countedRatings(e);
  if (vals.length < 2) return e.ratings.size ? null : e.stdevFinal;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1));
}

/* ---- art helpers -------------------------------------------------------------- */
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

/** WUBRG pips (plus ◇ for colorless), used on the lightbox. */
function manaPips(colors) {
  const wrap = el("span", { class: "mana-pips" });
  if (!colors.length) wrap.append(el("span", { class: "mana-pip mana-C", title: "Colorless" }, "◇"));
  for (const c of colors) {
    wrap.append(el("span", { class: `mana-pip mana-${c}`, title: c }));
  }
  return wrap;
}

/* ---- filter bar (built once; chips restyle in place) ----------------------- */
const chipRegistry = []; // { el, isOn } pairs refreshed by syncChips()

function registerChip(node, isOn) {
  chipRegistry.push({ node, isOn });
  return node;
}
function syncChips() {
  for (const { node, isOn } of chipRegistry) node.classList.toggle("on", isOn());
}

function buildFilterBar() {
  const playerChips = allPlayers.map((p) => registerChip(
    el("button", { class: "chip", onclick: () => { flip(filters.players, p); applyFilters(); } }, p),
    () => filters.players.has(p)));

  const colorRow = (label, set, cls) =>
    el("div", { class: "chip-row" },
      el("span", { class: "chip-row-label" }, label),
      ...[...WUBRG, COLOR_C].map((c) => registerChip(
        el("button", {
          class: `chip color-chip ${cls} mana-${c}`,
          title: c === COLOR_C ? "Colorless" : c,
          onclick: () => { flip(set, c); applyFilters(); },
        }, c === COLOR_C ? "◇" : c),
        () => set.has(c))));

  const reset = el("button", {
    class: "chip reset",
    onclick: () => {
      // Mutate the Sets in place — the chips' click handlers hold references
      // to these exact objects; replacing them would orphan every chip.
      filters.players.clear();
      for (const p of allPlayers) filters.players.add(p);
      filters.include.clear();
      for (const c of [...WUBRG, COLOR_C]) filters.include.add(c);
      filters.exclude.clear();
      raters.on.clear();
      for (const r of allRaters) raters.on.add(r);
      raters.ownerCounted = true;
      regroupGallery();
      applyFilters();
    },
  }, "Reset");

  // "Ratings by" row: multi-select include over raters (all on = the table
  // mean), plus the Owner gate on self-ratings. Any change re-scores the
  // page, so regroup as well as re-filter.
  const raterChange = () => { regroupGallery(); applyFilters(); };
  const ownerChip = registerChip(
    el("button", {
      class: "chip lens-chip",
      title: "Count owners' ratings of their own decks",
      onclick: () => { raters.ownerCounted = !raters.ownerCounted; raterChange(); },
    }, "Owner"),
    () => raters.ownerCounted);
  const raterChips = allRaters.map((r) => registerChip(
    el("button", {
      class: "chip lens-chip",
      onclick: () => { flip(raters.on, r); raterChange(); },
    }, r),
    () => raters.on.has(r)));
  const lensRow = allRaters.length
    ? el("div", { class: "chip-row" },
        el("span", { class: "chip-row-label" }, "Ratings by"),
        ownerChip, ...raterChips)
    : "";

  return el("nav", { class: "filter-bar" },
    el("div", { class: "chip-row" },
      el("span", { class: "chip-row-label" }, "Owners"), ...playerChips),
    colorRow("Include", filters.include, "inc"),
    colorRow("Exclude", filters.exclude, "exc"),
    lensRow,
    el("div", { class: "chip-row reset-row" }, reset),
  );
}
function flip(set, key) { set.has(key) ? set.delete(key) : set.add(key); }

/* ---- timeline (the app's dock, promoted to a hero) ---------------------------
   Thumbs are created ONCE into a pool; layout only moves/hides them. Two
   modes: compact (sticky strip) and expanded (full viewport width, taller,
   bigger thumbs — actually reading the collection's shape). */
let timelineEntries = [];        // all entries, ascending score
let timelineExpanded = false;
const thumbPool = new Map();     // deckId → element
let canvasEl = null;

function buildTimeline(entries) {
  timelineEntries = [...entries].sort(
    (a, b) => a.score - b.score || a.name.localeCompare(b.name));

  canvasEl = el("div", { class: "dock-canvas results-canvas" });
  for (const e of timelineEntries) {
    const thumb = thumbFor(e, "dock-thumb");
    thumb.title = `${e.name} (${e.owner}) — ${e.score.toFixed(2)}`;
    thumb.addEventListener("click", () => jumpToDeck(e.id));
    thumbPool.set(e.id, thumb);
    canvasEl.append(thumb);
  }

  const axis = el("div", { class: "dock-axis" });
  const tickAt = (v, major) => el("span", {
    class: `dock-tick${major ? " major" : ""}`,
    style: `left:${((v - 1) / 5) * 100}%`,
  });
  for (const v of [2, 3, 4, 5]) axis.append(tickAt(v, true));
  for (const base of [2, 3, 4]) axis.append(tickAt(base + 1 / 3), tickAt(base + 2 / 3));
  const labels = el("div", { class: "dock-labels" },
    ...["B1", "B2", "B3", "B4", "B5"].map((b) => el("span", {}, b)));

  const expandBtn = el("button", { class: "timeline-expand" }, "⤢ expand");
  const wrap = el("section", { class: "results-timeline" },
    expandBtn, canvasEl, axis, labels);
  expandBtn.addEventListener("click", () => {
    timelineExpanded = !timelineExpanded;
    wrap.classList.toggle("expanded", timelineExpanded);
    expandBtn.textContent = timelineExpanded ? "⤡ compact" : "⤢ expand";
    // Width changes with the class; lay out after the style lands.
    requestAnimationFrame(layoutTimeline);
  });
  requestAnimationFrame(layoutTimeline);
  return wrap;
}

/* Same greedy-lane algorithm as ui.js's _layoutDock, over VISIBLE entries
   only; hidden thumbs get display:none, never removed. */
function layoutTimeline() {
  if (!canvasEl) return;
  const visible = timelineEntries.filter(passesFilters)
    .sort((a, b) => dynScore(a) - dynScore(b) || a.name.localeCompare(b.name));
  const hiddenIds = new Set(timelineEntries.map((e) => e.id));
  const W = canvasEl.clientWidth;
  if (!visible.length || !W) {
    for (const id of hiddenIds) thumbPool.get(id).style.display = "none";
    canvasEl.style.height = "24px";
    return;
  }
  const desktop = W >= 480;
  const base = timelineExpanded ? (desktop ? 56 : 38) : (desktop ? 40 : 30);
  const density = W / visible.length;
  const THUMB = Math.round(Math.max(timelineExpanded ? 26 : 20,
    Math.min(base, density * (timelineExpanded ? 2.4 : 1.6))));
  const LANE = Math.round(THUMB * 0.76);
  const MAX_LANES = timelineExpanded ? 12 : 7;

  let gap = Math.round(THUMB * 0.6);
  let placed, maxLane;
  do {
    placed = [];
    maxLane = 0;
    const laneRight = [];
    for (const e of visible) {
      const x = ((dynScore(e) - 1) / 5) * (W - THUMB);
      let lane = 0;
      while (laneRight[lane] !== undefined && x - laneRight[lane] < gap) lane++;
      laneRight[lane] = x;
      maxLane = Math.max(maxLane, lane);
      placed.push({ e, x, lane });
    }
    gap -= 3;
  } while (maxLane >= MAX_LANES && gap > 3);

  const MAX_H = timelineExpanded
    ? Math.round(window.innerHeight * 0.42)
    : (desktop ? 200 : 140);
  const laneStep = maxLane > 0
    ? Math.min(LANE, Math.max(8, Math.floor((MAX_H - THUMB) / maxLane)))
    : LANE;

  for (const { e, x, lane } of placed) {
    hiddenIds.delete(e.id);
    const thumb = thumbPool.get(e.id);
    thumb.title = `${e.name} (${e.owner}) \u2014 ${dynScore(e).toFixed(2)}`;
    thumb.style.display = "";
    thumb.style.left = `${x}px`;
    thumb.style.bottom = `${lane * laneStep}px`;
    thumb.style.width = thumb.style.height = `${THUMB}px`;
    thumb.style.zIndex = lane + 1;
  }
  for (const id of hiddenIds) thumbPool.get(id).style.display = "none";
  canvasEl.style.height = `${maxLane * laneStep + THUMB + 4}px`;
}

/** Timeline thumb tapped → scroll its gallery card into view and flash it. */
function jumpToDeck(id) {
  const card = document.querySelector(`.deck-card[data-id="${CSS.escape(id)}"]`);
  if (!card || card.classList.contains("hidden")) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("flash"); // restart animation if re-tapped
  void card.offsetWidth;
  card.classList.add("flash");
}

/* ---- tier gallery (built once) -----------------------------------------------
   Strongest tier first, each tier a tinted band of art cards. Ranks are
   fixed over the FULL table — filters never renumber decks. Filtering hides
   cards (and emptied bands) with a class; nothing is rebuilt. */
let rankById = new Map();
const cardById = new Map();  // deckId → card element
const bands = [];            // { el, cards: entry[] }

function buildGallery(entries) {
  galleryWrap = el("section", { class: "results-gallery" },
    el("p", { class: "empty-note hidden" }, "Nothing matches these filters."));
  // Create every card exactly once; regroupGallery() owns the grouping.
  for (const e of entries) cardById.set(e.id, deckCard(e, rankById.get(e.id)));
  regroupGallery();
  return galleryWrap;
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

  // 🔥 = one of the table's five most disputed decks (highest StdDev).
  if (e.fire) card.append(el("span", {
    class: `card-fire${rank <= 3 ? " beside-medal" : ""}`,
    title: `The table disagrees: \u03c3 = ${e.stdevFinal.toFixed(2)}`,
  }, "🔥"));

  // Owner-vs-table badge: ▲ the owner rates it higher than the group, ▼
  // lower. Only shown when the gap clears ~half a sub-tier (0.15) — small
  // disagreements are noise and would just clutter the art. The lightbox
  // pins still show every gap exactly.
  const d = e.ownerRating !== null ? (e.diff ?? e.ownerRating - e.score) : null;
  if (d !== null && Math.abs(d) >= 0.15) {
    card.append(el("span", {
      class: `card-diff ${d > 0 ? "up" : "down"}`,
      title: `${e.owner} rates it ${d > 0 ? "+" : ""}${d.toFixed(2)} vs the table`,
    }, `${d > 0 ? "\u25b2" : "\u25bc"}${Math.abs(d).toFixed(2).replace(/^0/, "")}`));
  }

  card.append(el("div", { class: "card-caption" },
    el("span", { class: "card-name" }, e.name),
    el("span", { class: "card-score" }, e.score.toFixed(2))));
  return card;
}

function monogramPanel(e) {
  return el("div", { class: "card-art monogram" }, e.name.slice(0, 2).toUpperCase());
}

/* Re-score the gallery for the current lens: rebuild the band skeletons and
   MOVE the existing card nodes into them (moving never reloads an image).
   Cards missing a score under this lens are parked hidden in the last band
   they occupied \u2014 applyFilters() hides them anyway. */
let galleryWrap = null;

function regroupGallery() {
  if (!galleryWrap) return;
  const scored = allEntries.filter((e) => dynScore(e) !== null)
    .sort((a, b) => dynScore(b) - dynScore(a) || a.name.localeCompare(b.name));

  bands.length = 0;
  const emptyNote = galleryWrap.querySelector(".empty-note");
  galleryWrap.replaceChildren(emptyNote);

  let grid = null, lastTier = null, bandRec = null;
  for (const e of scored) {
    const s = dynScore(e);
    const tier = tierOf(s);
    if (tier !== lastTier) {
      lastTier = tier;
      grid = el("div", { class: "tier-grid" });
      const bandEl = el("section", {
        class: "tier-band",
        style: `--tier-tint:${tint((tier.low + tier.high) / 2)}`,
      }, el("h2", { class: "tier-band-label" }, tier.label), grid);
      bandRec = { el: bandEl, cards: [] };
      bands.push(bandRec);
      galleryWrap.append(bandEl);
    }
    const card = cardById.get(e.id);
    card.style.setProperty("--tier-tint", tint(s));
    card.querySelector(".card-score").textContent = s.toFixed(2);
    bandRec.cards.push(e);
    grid.append(card); // append MOVES the node \u2014 no clone, no reload
  }
}

/* ---- lightbox ---------------------------------------------------------------
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
        el("span", { class: "lb-meta" },
          `#${rank} \u00b7 ${e.owner} `, manaPips(e.colors))),
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
 *  own — a drawn stat instead of a written one. */
function miniAxis(e) {
  const shown = dynScore(e) ?? e.score;       // what the page currently shows
  const sd = dynStdev(e);                     // spread of the counted ratings
  const custom = !ratersPristine();
  const whiskerLo = sd !== null ? shown - sd : null;
  const whiskerHi = sd !== null ? shown + sd : null;
  const scores = [shown, e.ownerRating, whiskerLo, whiskerHi]
    .filter((v) => v !== null);
  // Window: the deck's whole bracket, padded so pins never sit on the edge,
  // widened if the owner's rating strays outside it; clamped to 1–6.
  const t = tierOf(e.score);
  const bracketLow = Math.floor(t.low);
  const bracketHigh = bracketLow + 1;
  const lo = Math.max(1, Math.min(bracketLow, ...scores) - 0.15);
  const hi = Math.min(6, Math.max(bracketHigh, ...scores) + 0.15);
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
  // Disagreement whisker: a translucent band of \u00b11\u03c3 around the mean —
  // wide band, the table argues about this deck; sliver, consensus.
  if (sd !== null) {
    axis.append(el("span", {
      class: "mini-whisker",
      style: `left:${pos(Math.max(lo, whiskerLo))}%;` +
        `width:${pos(Math.min(hi, whiskerHi)) - pos(Math.max(lo, whiskerLo))}%`,
    }));
  }

  const pins = el("div", { class: "mini-pins" },
    pinEl("group", shown, `${custom ? "avg" : "table"} ${shown.toFixed(2)}`));
  if (e.ownerRating !== null) {
    pins.append(pinEl("owner", e.ownerRating, `${e.owner} ${e.ownerRating.toFixed(2)}`));
  } else {
    pins.append(el("div", { class: "mini-pending" }, `${e.owner}: pending`));
  }

  const n = countedRatings(e).length || (e.ratings.size ? 0 : null);
  const labels = el("div", { class: "mini-labels" },
    el("span", {}, `B${Math.round(lo)}`),
    el("span", { class: "mini-sigma" },
      sd !== null ? `\u03c3 ${sd.toFixed(2)}${e.fire ? " \ud83d\udd25" : ""}` +
        (n ? ` \u00b7 ${n} rating${n === 1 ? "" : "s"}` : "") : ""),
    el("span", {}, `B${Math.round(hi)}`));
  return el("div", { class: "mini-axis-wrap" }, pins, axis, labels);
}

function hideOnError(ev) { ev.target.remove(); }

/* ---- table stats -----------------------------------------------------------------
   Two fixed panels below the gallery, computed once over the FULL table
   (like medals and 🔥, they don't chase the filters):

   • Collections — each owner's decks averaged into one number on the shared
     power axis: whose pile runs hottest.
   • Rater report — each rater vs the mean EXCLUDING their own vote (a mean
     containing your vote flatters you). Two numbers per rater: bias (signed
     — runs hot or cold) and spread (average absolute miss — how often they
     simply disagree, regardless of direction). A rater can be calibrated
     but scattered, or harsh but in lockstep; these are different virtues. */
function ownerStats() {
  const by = new Map();
  for (const e of allEntries) {
    if (!by.has(e.owner)) by.set(e.owner, []);
    by.get(e.owner).push(e.score);
  }
  return [...by.entries()]
    .map(([owner, scores]) => ({
      owner,
      n: scores.length,
      avg: scores.reduce((a, b) => a + b, 0) / scores.length,
    }))
    .sort((a, b) => b.avg - a.avg);
}

function raterStats() {
  const devs = new Map(); // rater → array of (rating − mean-of-others)
  for (const e of allEntries) {
    const entries = [...e.ratings.entries()];
    if (entries.length < 2) continue; // no "others" to compare against
    const sum = entries.reduce((a, [, v]) => a + v, 0);
    for (const [rater, v] of entries) {
      const others = (sum - v) / (entries.length - 1);
      if (!devs.has(rater)) devs.set(rater, []);
      devs.get(rater).push(v - others);
    }
  }
  // Every known rater gets a row — players who haven't submitted (or whose
  // every rated deck has no second rating to compare against) show as
  // pending rather than silently vanishing from the report.
  return allRaters
    .map((rater) => {
      const ds = devs.get(rater);
      if (!ds) return { rater, n: 0, bias: null, spread: null };
      return {
        rater,
        n: ds.length,
        bias: ds.reduce((a, b) => a + b, 0) / ds.length,
        spread: ds.reduce((a, b) => a + Math.abs(b), 0) / ds.length,
      };
    })
    .sort((a, b) => (a.spread ?? Infinity) - (b.spread ?? Infinity));
}

/** Full-range (1–6) gradient, sampled from the same powerTint as everything
 *  else so the stats axes can never drift from the dock's colors. */
function fullAxisGradient() {
  const stops = [0, 0.2, 0.4, 0.6, 0.8, 1]
    .map((t) => `${powerTint(t)} ${t * 100}%`).join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

function buildStats() {
  const owners = ownerStats();
  const raters = raterStats();

  const ownerRows = owners.map(({ owner, n, avg }) => {
    const tier = tierOf(avg);
    return el("div", { class: "stat-row" },
      el("span", { class: "stat-name" }, owner),
      el("div", { class: "stat-axis", style: `background:${fullAxisGradient()}` },
        el("span", { class: "stat-pin", style: `left:${((avg - 1) / 5) * 100}%` })),
      el("span", { class: "stat-value" },
        `${avg.toFixed(2)} · ${tier.label} · ${n} deck${n === 1 ? "" : "s"}`));
  });

  // Bias renders as a diverging bar from a center zero line: ember right =
  // rates above the table, jade left = below. Scale caps at ±0.6 so one
  // outlier doesn't flatten everyone else's bars.
  const CAP = 0.6;
  const raterRows = raters.map(({ rater, n, bias, spread }) => {
    if (bias === null) {
      return el("div", { class: "stat-row" },
        el("span", { class: "stat-name" }, rater),
        el("div", { class: "bias-track" }, el("span", { class: "bias-zero" })),
        el("span", { class: "stat-value pending" }, "no ratings yet"));
    }
    const w = Math.min(Math.abs(bias) / CAP, 1) * 50;
    const dir = Math.abs(bias) < 0.05 ? "±0.00 vs table"
      : `${bias > 0 ? "+" : "−"}${Math.abs(bias).toFixed(2)} vs table`;
    return el("div", { class: "stat-row" },
      el("span", { class: "stat-name" }, rater),
      el("div", { class: "bias-track" },
        el("span", { class: "bias-zero" }),
        el("span", {
          class: `bias-bar ${bias >= 0 ? "hot" : "cold"}`,
          style: bias >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`,
        })),
      el("span", { class: "stat-value" },
        `${dir} · ±${spread.toFixed(2)} typical · ${n} ratings`));
  });

  if (!ownerRows.length && !raterRows.length) return "";
  return el("section", { class: "stats-section" },
    ownerRows.length ? el("div", { class: "stat-panel" },
      el("h2", { class: "stat-title" }, "Collections"),
      el("p", { class: "stat-sub" }, "Average table rating of the decks each player owns."),
      ...ownerRows) : "",
    raterRows.length ? el("div", { class: "stat-panel" },
      el("h2", { class: "stat-title" }, "Rater report"),
      el("p", { class: "stat-sub" },
        "Each player's lean vs the rest of the table — ember rates higher, " +
        "jade lower. ± is their typical distance from the group."),
      ...raterRows) : "",
  );
}


/* ---- pod builder -------------------------------------------------------------------
   Deal a "fair" pod: pick who's playing (1–5) and a target power bucket, and
   each player gets one of their own decks from within ONE sub-tier of the
   target. Fairness = tight score spread: many random legal combinations are
   sampled and one of the tightest is dealt, with enough randomness left in
   the tie-break that rerolling keeps producing fresh pods. Uses the table's
   mean scores; ignores the page filters entirely. */
const pod = { players: new Set(), tierIdx: null };

function tierIndexOf(score) {
  return TIERS.indexOf(tierOf(score));
}

function dealPod() {
  const players = [...pod.players];
  const pools = players.map((p) => allEntries.filter((e) =>
    e.owner === p && Math.abs(tierIndexOf(e.score) - pod.tierIdx) <= 1));
  const missing = players.filter((_, i) => !pools[i].length);
  if (missing.length) return { missing };

  // Sample legal combos, keep everything within 0.12 of the tightest spread,
  // then pick one of those at random.
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  let best = [];
  let bestSpread = Infinity;
  for (let i = 0; i < 250; i++) {
    const combo = pools.map(pick);
    const scores = combo.map((e) => e.score);
    const spread = Math.max(...scores) - Math.min(...scores);
    if (spread < bestSpread - 0.12) { best = [combo]; bestSpread = spread; }
    else if (spread <= bestSpread + 0.12) { best.push(combo); bestSpread = Math.min(bestSpread, spread); }
  }
  const deal = pick(best);
  return { deal, spread: Math.max(...deal.map((e) => e.score)) - Math.min(...deal.map((e) => e.score)) };
}

function buildPodBuilder() {
  const playerChips = allPlayers.map((p) => {
    const c = el("button", { class: "chip", onclick: () => {
      if (pod.players.has(p)) pod.players.delete(p);
      else if (pod.players.size < 5) pod.players.add(p);
      c.classList.toggle("on", pod.players.has(p));
    }}, p);
    return c;
  });

  const tierChips = TIERS.map((t, i) => {
    const c = el("button", {
      class: "chip pod-tier",
      style: `--tier-tint:${tint((t.low + t.high) / 2)}`,
      onclick: () => {
        pod.tierIdx = pod.tierIdx === i ? null : i;
        for (const [j, node] of tierChips.entries())
          node.classList.toggle("on", pod.tierIdx === j);
      },
    }, t.label);
    return c;
  });

  const out = el("div", { class: "pod-result" });
  const dealBtn = el("button", { class: "pod-deal", onclick: () => {
    out.replaceChildren();
    if (!pod.players.size || pod.tierIdx === null) {
      out.append(el("p", { class: "empty-note" }, "Pick at least one player and a bucket."));
      return;
    }
    const r = dealPod();
    if (r.missing) {
      out.append(el("p", { class: "empty-note" },
        `${r.missing.join(", ")} ${r.missing.length === 1 ? "has" : "have"} no deck within one sub-tier of ${TIERS[pod.tierIdx].label}.`));
      return;
    }
    dealBtn.textContent = "Reroll";
    const grid = el("div", { class: "tier-grid pod-grid" });
    for (const e of [...r.deal].sort((a, b) => b.score - a.score)) {
      const card = deckCard(e, rankById.get(e.id));
      card.classList.remove("hidden");
      grid.append(card);
    }
    out.append(grid, el("p", { class: "pod-spread" },
      `Power spread: ${r.spread.toFixed(2)} \u2014 ${
        r.spread < 0.34 ? "razor fair" : r.spread < 0.67 ? "fair enough" : "someone's the villain"}`));
  }}, "Deal a pod");

  return el("section", { class: "stat-panel pod-panel" },
    el("h2", { class: "stat-title" }, "Pod builder"),
    el("p", { class: "stat-sub" },
      "Pick who's playing and a target bucket; everyone gets one of their own " +
      "decks from within one sub-tier of it."),
    el("div", { class: "chip-row" }, ...playerChips),
    el("div", { class: "chip-row" }, ...tierChips),
    el("div", { class: "chip-row" }, dealBtn),
    out);
}

/* ---- filtering (in place — the no-flash core) --------------------------------- */
let allEntries = [];
let subEl = null;

function applyFilters() {
  syncChips();
  let shownCount = 0;
  for (const e of allEntries) {
    const show = passesFilters(e);
    if (show) shownCount++;
    cardById.get(e.id)?.classList.toggle("hidden", !show);
  }
  for (const band of bands) {
    band.el.classList.toggle("hidden", !band.cards.some(passesFilters));
  }
  document.querySelector(".empty-note")?.classList.toggle("hidden", shownCount > 0);
  if (subEl) {
    const owners = new Set(allEntries.filter(passesFilters).map((e) => e.owner));
    subEl.textContent = shownCount === allEntries.length
      ? `${allEntries.length} decks \u00b7 ${owners.size} owners \u00b7 group averages`
      : `${shownCount} of ${allEntries.length} decks shown`;
  }
  layoutTimeline();
}

/* ---- boot --------------------------------------------------------------------- */
async function boot() {
  try {
    // Scores and catalog load in parallel; a catalog failure only costs art
    // and links, never the rankings themselves.
    const [finalRows, rawRows, catalogResult] = await Promise.all([
      fetchSheetTabRows(RESULTS_SHEET_ID, RESULTS_TAB),
      fetchSheetTabRows(RESULTS_SHEET_ID, RAW_TAB).catch((err) => {
        console.warn(`"${RAW_TAB}" tab unavailable \u2014 rater lens limited to Table/Owner.`, err);
        return null;
      }),
      loadAllDecks().catch((err) => {
        console.warn("Deck catalog unavailable \u2014 rendering without art.", err);
        return { decks: [] };
      }),
    ]);
    allEntries = parseFinalTab(finalRows);
    const raw = parseRawTab(rawRows);
    for (const e of allEntries) e.ratings = raw.byDeck.get(e.id) ?? new Map();
    // Union with owners so not-yet-submitted players still get a chip.
    allRaters = [...new Set([...raw.raters, ...allEntries.map((e) => e.owner)])].sort();
    if (!raw.raters.length) allRaters = []; // no Raw tab → hide the row entirely
    for (const r of allRaters) raters.on.add(r);
    const catalog = new Catalog(catalogResult.decks);

    // The join: aggregation sheet owns the numbers, data sheet owns the
    // presentation. The sheet's DeckID is tried first, but IDs go stale the
    // moment a deck or tab is renamed (rename = new hash, by design), so
    // fall back to rehashing this row's owner+name, then to a normalized
    // name match — that covers stale IDs, stray whitespace, and smart-quote
    // drift. A deck that still misses renders as a monogram, and the miss
    // is logged so it's diagnosable instead of mysterious.
    const norm = (s) => String(s ?? "").toLowerCase().replace(/[\u2018\u2019']/g, "")
      .replace(/\s+/g, " ").trim();
    const byNormName = new Map(
      catalogResult.decks.map((d) => [`${norm(d.owner)}\u0000${norm(d.deckName)}`, d]));
    for (const e of allEntries) {
      const d = catalog.get(e.id)
        ?? catalog.get(deckId(e.owner, e.name))
        ?? byNormName.get(`${norm(e.owner)}\u0000${norm(e.name)}`);
      if (!d) console.warn(`No catalog match for "${e.name}" (${e.owner}) \u2014 ` +
        `id ${e.id}; check the final tab's DeckID/owner/name against the data sheet.`);
      e.art = d?.artUrl || "";
      e.artPartner = d?.artUrlPartner || "";
      e.archidektUrl = d?.archidektUrl || "";
      e.colors = parseIdentity(d?.colorId || e.identityRaw);
    }

    // Ranks over the full table, fixed once \u2014 filters never renumber decks.
    rankById = new Map(
      [...allEntries]
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .map((e, i) => [e.id, i + 1]));

    // 🔥 marks the table's most disputed decks: the five highest StdDevs,
    // provided the disagreement is real (σ ≥ 0.3 — roughly a sub-tier).
    const disputed = allEntries.filter((e) => (e.stdevFinal ?? 0) >= 0.3)
      .sort((a, b) => b.stdevFinal - a.stdevFinal).slice(0, 5);
    for (const e of disputed) e.fire = true;

    allPlayers = [...new Set(allEntries.map((e) => e.owner))].sort();
    filters.players = new Set(allPlayers);

    subEl = el("p", { class: "results-sub" }, "");
    app.replaceChildren(
      el("header", { class: "results-header" },
        el("h1", {}, "The Table Has Spoken"), subEl),
      buildFilterBar(),
      buildTimeline(allEntries),
      buildGallery(allEntries),
      buildStats(),
      buildPodBuilder(),
      el("footer", { class: "results-footer" },
        "Scores are the group's mean rating on the fixed bracket scale (1\u20136). ",
        "Tap any deck: pins show the table's rating vs the owner's own."),
    );
    applyFilters(); // sets counts + chip states; nothing is hidden yet
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
