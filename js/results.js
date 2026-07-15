// ---------------------------------------------------------------------------
// results.js — the aggregate view. Reads the "final" tab of the aggregation
// sheet (DeckID, DeckName, Owner, Bracket, NumericRating, OwnerRating,
// Difference), joins it by DeckID against the live deck catalog (art, color
// identity, Archidekt links), and renders:
//   1. filter chips — players and WUBRG colors, all on by default;
//   2. the full-collection power timeline (the app's dock, sticky, with a
//      compact/expanded toggle);
//   3. tier bands of art cards, strongest first, with a lightbox per deck
//      that draws the table-vs-owner stat as pins on a gradient slice.
//
// Filtering semantics (per James):
//   • a deck is shown iff its OWNER's chip is on, AND
//   • at least one of the deck's colors is on — so with only R off, WUR
//     still shows (W and U are on); only mono-R vanishes. Colorless decks
//     ride the ◇ chip.
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
    cDiff = col("Difference"), cIdentity = col("Identity");
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
      // The catalog's Color_ID wins later; this is the fallback.
      identityRaw: cIdentity >= 0 ? String(row[cIdentity] ?? "").trim() : "",
    });
  }
  if (!out.length) throw new Error(`No scored decks found in "${RESULTS_TAB}".`);
  return out;
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
   Identities arrive as strings like "WUBRG", "wur", "R/G", "Grixis"-adjacent
   junk — extract only WUBRG letters, in canonical order. No letters at all
   (or "C") → colorless. */
const WUBRG = ["W", "U", "B", "R", "G"];
function parseIdentity(raw) {
  const letters = new Set(
    String(raw ?? "").toUpperCase().split("").filter((ch) => WUBRG.includes(ch)));
  return WUBRG.filter((c) => letters.has(c)); // canonical order, [] = colorless
}

/* ---- filter state ------------------------------------------------------------
   Everything on by default. COLOR_C is the colorless bucket's key. */
const COLOR_C = "C";
const filters = {
  players: new Set(),           // filled at boot from the data
  colors: new Set([...WUBRG, COLOR_C]),
};
let allPlayers = [];

function passesFilters(e) {
  if (!filters.players.has(e.owner)) return false;
  if (e.colors.length === 0) return filters.colors.has(COLOR_C);
  return e.colors.some((c) => filters.colors.has(c)); // any shared color keeps it
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

/** WUBRG pips (plus ◇ for colorless), used on filter chips and the lightbox. */
function manaPips(colors) {
  const wrap = el("span", { class: "mana-pips" });
  if (!colors.length) wrap.append(el("span", { class: "mana-pip mana-C", title: "Colorless" }, "◇"));
  for (const c of colors) {
    wrap.append(el("span", { class: `mana-pip mana-${c}`, title: c }));
  }
  return wrap;
}

/* ---- filter bar ----------------------------------------------------------------- */
function renderFilterBar() {
  const playerChips = allPlayers.map((p) =>
    chip(p, filters.players.has(p), () => toggle(filters.players, p)));

  const colorChips = [...WUBRG, COLOR_C].map((c) =>
    el("button", {
      class: `chip color-chip mana-${c}${filters.colors.has(c) ? " on" : ""}`,
      title: c === COLOR_C ? "Colorless" : c,
      onclick: () => toggle(filters.colors, c),
    }, c === COLOR_C ? "◇" : c));

  const anyOff = filters.players.size < allPlayers.length
    || filters.colors.size < WUBRG.length + 1;

  return el("nav", { class: "filter-bar" },
    el("div", { class: "chip-row" }, ...playerChips),
    el("div", { class: "chip-row" },
      ...colorChips,
      anyOff
        ? el("button", { class: "chip reset", onclick: resetFilters }, "Reset")
        : ""),
  );
}
function chip(label, on, onclick) {
  return el("button", { class: `chip${on ? " on" : ""}`, onclick }, label);
}
function toggle(set, key) {
  set.has(key) ? set.delete(key) : set.add(key);
  renderAll();
}
function resetFilters() {
  filters.players = new Set(allPlayers);
  filters.colors = new Set([...WUBRG, COLOR_C]);
  renderAll();
}

/* ---- timeline (the app's dock, promoted to a hero) ---------------------------
   Two modes. Compact: the familiar dock strip, sticky at the top. Expanded:
   roomier lanes and bigger thumbs for actually reading the collection's
   shape — the whole point of the axis — especially on desktop. */
let timelineEntries = [];
let timelineExpanded = false;

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

  const expandBtn = el("button", {
    class: "timeline-expand",
    title: timelineExpanded ? "Compact timeline" : "Expand timeline",
    onclick: () => { timelineExpanded = !timelineExpanded; renderAll(); },
  }, timelineExpanded ? "▾ compact" : "▴ expand");

  const wrap = el("section", {
    class: `results-timeline${timelineExpanded ? " expanded" : ""}`,
  }, expandBtn, canvas, axis, labels);
  requestAnimationFrame(layoutTimeline);
  return wrap;
}

/* Same greedy-lane algorithm as ui.js's _layoutDock; the mode only changes
   the knobs (thumb size, lane count, height cap). */
function layoutTimeline() {
  const canvas = document.querySelector(".results-canvas");
  if (!canvas) return;
  if (!timelineEntries.length) { canvas.replaceChildren(); canvas.style.height = "24px"; return; }
  const W = canvas.clientWidth;
  const desktop = W >= 480;
  const base = timelineExpanded ? (desktop ? 56 : 38) : (desktop ? 40 : 30);
  const density = W / timelineEntries.length;
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

  const MAX_H = timelineExpanded
    ? Math.round(window.innerHeight * 0.42)
    : (desktop ? 200 : 140);
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

/* ---- tier gallery --------------------------------------------------------------
   Strongest tier first, each tier a tinted band of art cards. Text only
   where a picture can't do the job. Ranks are computed over the FULL table,
   not the filtered view — #1 stays #1 no matter what's hidden. */
let rankById = new Map();

function renderGallery(entries) {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const wrap = el("section", { class: "results-gallery" });
  if (!sorted.length) {
    wrap.append(el("p", { class: "empty-note" }, "Nothing matches these filters."));
    return wrap;
  }
  let band = null, lastTier = null;
  for (const e of sorted) {
    const tier = tierOf(e.score);
    if (tier !== lastTier) {
      lastTier = tier;
      const tierTint = tint((tier.low + tier.high) / 2);
      band = el("div", { class: "tier-grid" });
      wrap.append(
        el("section", { class: "tier-band", style: `--tier-tint:${tierTint}` },
          el("h2", { class: "tier-band-label" }, tier.label),
          band));
    }
    band.append(deckCard(e, rankById.get(e.id)));
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
  const scores = [e.score, e.ownerRating].filter((v) => v !== null);
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

/* ---- boot & rerender ------------------------------------------------------------- */
let allEntries = [];

function renderAll() {
  const shown = allEntries.filter(passesFilters);
  const owners = new Set(shown.map((e) => e.owner));
  const countLine = shown.length === allEntries.length
    ? `${allEntries.length} decks \u00b7 ${owners.size} owners \u00b7 group averages`
    : `${shown.length} of ${allEntries.length} decks shown`;

  app.replaceChildren(
    el("header", { class: "results-header" },
      el("h1", {}, "The Table Has Spoken"),
      el("p", { class: "results-sub" }, countLine)),
    renderFilterBar(),
    renderTimeline(shown),
    renderGallery(shown),
    el("footer", { class: "results-footer" },
      "Scores are the group's mean rating on the fixed bracket scale (1\u20136). ",
      "Tap any deck: pins show the table's rating vs the owner's own."),
  );
}

async function boot() {
  try {
    // Scores and catalog load in parallel; a catalog failure only costs art
    // and links, never the rankings themselves.
    const [finalRows, catalogResult] = await Promise.all([
      fetchSheetTabRows(RESULTS_SHEET_ID, RESULTS_TAB),
      loadAllDecks().catch((err) => {
        console.warn("Deck catalog unavailable \u2014 rendering without art.", err);
        return { decks: [] };
      }),
    ]);
    allEntries = parseFinalTab(finalRows);
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
      if (!d) console.warn(`No catalog match for "${e.name}" (${e.owner}) — ` +
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

    allPlayers = [...new Set(allEntries.map((e) => e.owner))].sort();
    filters.players = new Set(allPlayers);

    renderAll();
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
