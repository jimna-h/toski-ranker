// ---------------------------------------------------------------------------
// ui.js — rendering and event wiring only. No ranking logic, no storage.
//
// main.js constructs UI with a set of handler callbacks; every screen is a
// render function that rebuilds #app. At this scale, full re-render per
// action is simpler and plenty fast — no framework needed.
// ---------------------------------------------------------------------------

import { TIERS, tierById } from "./config.js";
import { computeScores } from "./scoring.js";

/* ---- power-gradient tints -------------------------------------------------
   Each of the 11 tiers gets a color sampled from the jade→amber→ember axis.
   Computed once here (rather than 11 hand-picked hexes) so the future
   continuous-scale visualization can reuse the exact same function. */

const ANCHORS = ["#3e8e6e", "#6d9a58", "#b3913f", "#c1663c", "#b8403d"];

function hexToRgb(h) {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function lerpColor(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `rgb(${c.join(",")})`;
}
/** t in [0,1] along the power axis → CSS color. */
export function powerTint(t) {
  const scaled = t * (ANCHORS.length - 1);
  const i = Math.min(Math.floor(scaled), ANCHORS.length - 2);
  return lerpColor(ANCHORS[i], ANCHORS[i + 1], scaled - i);
}
const TIER_TINT = Object.fromEntries(
  TIERS.map((t, i) => [t.id, powerTint(i / (TIERS.length - 1))])
);

/* ---- tiny DOM helpers ---------------------------------------------------- */

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

export class UI {
  /**
   * @param {HTMLElement} root
   * @param {object} handlers callbacks provided by main.js:
   *   onStart(player), onBracket(tierId), onAnswer(answer), onDefer(),
   *   onSkip(), onUndo(), onEdgeMove(deckId, tier, direction, accept),
   *   onRerank(deckId), onExport(), onOpenEdit(), onCloseEdit()
   */
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.catalog = null;
    this.session = null;
  }

  deck(id) {
    return this.catalog.get(id) ?? { deckName: "(unknown deck)", owner: "?" };
  }

  clear() {
    this.root.replaceChildren();
  }

  /* ---- shared chrome ---- */

  topbar(showNav = true) {
    const placed = this.session.placedCount();
    const total = this.session.totalCount();
    const bar = el(
      "div",
      { class: "topbar" },
      el("span", { class: "title" }, "EDH Bracket Ranker"),
      el("span", {}, `${this.session.state.player} · ${placed}/${total} placed`),
      el(
        "span",
        {},
        el("button", {
          onclick: () => this.h.onUndo(),
          disabled: !this.session.canUndo,
          title: "Undo last action",
        }, "Undo"),
        " ",
        ...(showNav
          ? [
              el("button", { onclick: () => this.h.onOpenScale() }, "Scale"),
              " ",
              el("button", { onclick: () => this.h.onOpenEdit() }, "Review"),
            ]
          : [])
      )
    );
    const track = el(
      "div",
      { class: "progress-track" },
      el("div", {
        class: "progress-fill",
        style: `width:${total ? (placed / total) * 100 : 0}%`,
      })
    );
    // One-shot notice (e.g. "sheet changed: 2 decks added") set by main.js.
    const pieces = [bar, track];
    if (this.flash) {
      pieces.push(el("div", { class: "notice slim" }, this.flash));
      this.flash = null;
    }
    return pieces;
  }

  /** Commander art banner: one image, or two side-by-side for partners.
   *  Broken/missing URLs degrade to no banner — the card stays text-only. */
  artBanner(deck, small = false) {
    const urls = [deck.artUrl, deck.artUrlPartner].filter(Boolean);
    if (!urls.length) return "";
    const banner = el("div", { class: `deck-art${urls.length === 2 ? " partners" : ""}${small ? " small" : ""}` });
    for (const url of urls) {
      banner.append(el("img", {
        src: url,
        alt: "",             // decorative; the deck name is the content
        loading: "lazy",
        onerror: (e) => e.target.closest(".deck-art")?.remove(),
      }));
    }
    return banner;
  }

  deckCard(deckId, { eyebrow = "Place this deck", small = false, tierId = null } = {}) {
    const d = this.deck(deckId);
    return el(
      "div",
      { class: `deck-card${small ? " vs" : ""}` },
      this.artBanner(d, small),
      el("div", { class: "eyebrow" }, eyebrow),
      el("h2", { class: "deck-name" }, d.deckName),
      el("div", { class: "deck-owner" }, `${d.owner}'s deck`),
      ...(tierId
        ? [el("span", { class: "tier-chip" }, `currently in ${tierById[tierId].label}`)]
        : [])
    );
  }

  /* ---- screens ---- */

  renderLoading(msg = "Loading deck list from Google Sheets…") {
    this.clear();
    this.root.append(el("div", { class: "start" }, el("h1", {}, "EDH Bracket Ranker"), el("p", { class: "sub" }, msg)));
  }

  renderError(message) {
    this.clear();
    this.root.append(
      el("div", { class: "start" },
        el("h1", {}, "EDH Bracket Ranker"),
        el("div", { class: "error" },
          el("strong", {}, "Couldn't load the deck list."),
          el("p", {}, message),
          el("p", {}, "Check SHEET_ID and API_KEY in js/config.js, and that the sheet is shared as “anyone with the link can view.”"),
          el("button", { onclick: () => location.reload() }, "Try again")
        )
      )
    );
  }

  /** Player picker. `resumeInfo(player)` → "12/70" string or null. */
  renderStart(players, resumeInfo) {
    this.clear();
    const select = el("select", {},
      el("option", { value: "" }, "Choose your name…"),
      ...players.map((p) => el("option", { value: p }, p))
    );
    const go = el("button", { class: "go", disabled: true }, "Start ranking");
    select.addEventListener("change", () => {
      const info = select.value ? resumeInfo(select.value) : null;
      go.disabled = !select.value;
      go.textContent = info ? `Resume (${info} placed)` : "Start ranking";
    });
    go.addEventListener("click", () => this.h.onStart(select.value));
    this.root.append(
      el("div", { class: "start" },
        el("h1", {}, "EDH Bracket Ranker"),
        el("p", { class: "sub" }, "Every deck, one at a time. Pick a bracket, answer a couple of comparisons, done. Progress saves automatically — close the tab whenever."),
        select,
        go
      )
    );
  }

  /** Bracket-choice screen for the deck at the front of the queue. */
  renderBracket(deckId) {
    this.clear();
    this.root.append(...this.topbar());
    this.root.append(this.deckCard(deckId, { eyebrow: "Which bracket?" }));

    const btn = (tier) => {
      const groups = this.session.state.buckets[tier.id] ?? [];
      const n = groups.reduce((s, g) => s + g.length, 0);
      return el(
        "button",
        {
          class: "bracket-btn",
          style: `--tint:${TIER_TINT[tier.id]}`,
          onclick: () => this.h.onBracket(tier.id),
        },
        tier.label,
        el("span", { class: "count" }, n ? `${n} placed` : "empty")
      );
    };

    // Rows mirror the bracket structure: 1 / 3 / 3 / 3 / 1
    const rows = [[0], [1, 2, 3], [4, 5, 6], [7, 8, 9], [10]];
    this.root.append(
      el("div", { class: "bracket-grid" },
        ...rows.map((idxs) =>
          el("div", { class: `bracket-row${idxs.length === 1 ? " single" : ""}` },
            ...idxs.map((i) => btn(TIERS[i]))
          )
        )
      ),
      el("div", { class: "secondary-row" },
        el("button", { onclick: () => this.h.onDefer() }, "Come back later")
      )
    );
  }

  /** Binary-insertion comparison question. */
  renderCompare(step) {
    this.clear();
    this.root.append(...this.topbar());
    this.root.append(
      this.deckCard(step.deckId, { eyebrow: "Placing" }),
      el("div", { class: "vs-label" }, "…is it stronger or weaker than…"),
      this.deckCard(step.vsId, { eyebrow: "Compare against", small: true, tierId: step.tier }),
      el("div", { class: "answer-row" },
        el("button", { onclick: () => this.h.onAnswer("weaker") }, "Weaker"),
        el("button", { class: "same", onclick: () => this.h.onAnswer("same") }, "About the same"),
        el("button", { onclick: () => this.h.onAnswer("stronger") }, "Stronger")
      )
    );
  }

  /** Optional demote/promote offer after an edge landing. */
  renderEdgePrompt(step) {
    this.clear();
    this.root.append(...this.topbar(false));
    const d = this.deck(step.deckId);
    const from = tierById[step.tier];
    const destLabel =
      TIERS[TIERS.findIndex((t) => t.id === step.tier) + (step.direction === "down" ? -1 : 1)].label;
    const phrase =
      step.direction === "down"
        ? `${d.deckName} came out weaker than everything in ${from.label}.`
        : `${d.deckName} came out stronger than everything in ${from.label}.`;
    this.root.append(
      el("div", { class: "notice" },
        el("strong", {}, phrase),
        el("p", {}, `Keep it there, or move it to ${destLabel}?`),
        el("div", { class: "actions" },
          el("button", { onclick: () => this.h.onEdgeMove(step, false) }, `Keep in ${from.label}`),
          el("button", { onclick: () => this.h.onEdgeMove(step, true) }, `Move to ${destLabel}`)
        )
      )
    );
  }

  /** Third "come back later" → the deck must be placed or skipped. */
  renderMustResolve(deckId) {
    this.clear();
    this.root.append(...this.topbar(false));
    const d = this.deck(deckId);
    this.root.append(
      el("div", { class: "notice" },
        el("strong", {}, `You've set ${d.deckName} aside twice already.`),
        el("p", {}, "Third time's the charm: make your best guess now, or skip it permanently (it won't appear in your export)."),
        el("div", { class: "actions" },
          el("button", { onclick: () => this.h.onResolvePlace() }, "Make my best guess"),
          el("button", { onclick: () => this.h.onSkip() }, "Skip this deck")
        )
      )
    );
  }

  /** Review/edit screen: everything placed so far, grouped by tier. */
  renderEdit() {
    this.clear();
    this.root.append(...this.topbar(false));
    const s = this.session.state;
    const container = el("div", {});

    for (const tier of TIERS) {
      const groups = s.buckets[tier.id];
      if (!groups?.length) continue;
      const section = el("div", { class: "edit-tier", style: `--tint:${TIER_TINT[tier.id]}` },
        el("h2", {}, tier.label)
      );
      // Strongest first within the tier — matches how players talk about lists.
      [...groups].reverse().forEach((group, gi, arr) => {
        for (const id of group) {
          const d = this.deck(id);
          section.append(
            el("div", { class: "edit-row" },
              el("span", {},
                d.deckName, " ",
                el("span", { class: "who" }, `· ${d.owner}`),
                group.length > 1 ? el("span", { class: "tie-note" }, "  (tied)") : ""
              ),
              el("button", { onclick: () => this.h.onRerank(id) }, "Re-rank")
            )
          );
        }
      });
      container.append(section);
    }

    if (s.skipped.length) {
      const section = el("div", { class: "edit-tier" }, el("h2", {}, "Skipped"));
      for (const id of s.skipped) {
        const d = this.deck(id);
        section.append(
          el("div", { class: "edit-row" },
            el("span", {}, d.deckName, " ", el("span", { class: "who" }, `· ${d.owner}`)),
            el("button", { onclick: () => this.h.onRerank(id) }, "Restore & rank")
          )
        );
      }
      container.append(section);
    }

    if (!container.children.length) {
      container.append(el("p", { class: "sub" }, "Nothing placed yet."));
    }

    this.root.append(
      container,
      el("div", { class: "secondary-row" },
        el("button", { onclick: () => this.h.onCloseEdit() }, "Back to ranking")
      )
    );
  }

  /** The Scale: every placed deck on a continuous power gradient.
   *  Ordered strongest → weakest, each row tinted by its exact score's
   *  position on the jade→ember axis, with labeled separators wherever a
   *  bracket boundary is crossed. This is the "one glance shows the whole
   *  collection" view the tier buttons have been hinting at all along. */
  renderScale() {
    this.clear();
    this.root.append(...this.topbar(false));

    const scores = computeScores(this.session.state.buckets);
    const rows = [...scores.entries()]
      .map(([id, { score, tierId }]) => ({ id, score, tierId }))
      .sort((a, b) => b.score - a.score); // strongest first

    const container = el("div", { class: "scale" });
    if (!rows.length) {
      container.append(el("p", { class: "sub" }, "Nothing placed yet — the scale fills in as you rank."));
    }

    let lastTier = null;
    for (const r of rows) {
      if (r.tierId !== lastTier) {
        container.append(
          el("div", {
            class: "scale-sep",
            style: `--tint:${TIER_TINT[r.tierId]}`,
          }, tierById[r.tierId].label)
        );
        lastTier = r.tierId;
      }
      const d = this.deck(r.id);
      // Normalize score 1..6 → 0..1 along the power axis for the row tint.
      const tint = powerTint((r.score - 1) / 5);
      const row = el("div", { class: "scale-row", style: `--tint:${tint}` },
        d.artUrl
          ? el("img", { class: "scale-thumb", src: d.artUrl, alt: "", loading: "lazy",
              onerror: (e) => e.target.remove() })
          : el("span", { class: "scale-thumb placeholder" }),
        el("span", { class: "scale-name" },
          d.deckName, " ",
          el("span", { class: "who" }, `· ${d.owner}`)),
        el("span", { class: "scale-score" }, r.score.toFixed(2))
      );
      container.append(row);
    }

    this.root.append(
      container,
      el("div", { class: "secondary-row" },
        el("button", { onclick: () => this.h.onCloseEdit() }, "Back to ranking"),
        el("button", { onclick: () => this.h.onOpenEdit() }, "Review / re-rank")
      )
    );
  }

  /** All decks handled: summary + export. */
  renderDone() {
    this.clear();
    this.root.append(...this.topbar(false));
    const s = this.session.state;
    const list = el("ul", { class: "summary-list" });
    for (const tier of TIERS) {
      const n = (s.buckets[tier.id] ?? []).reduce((sum, g) => sum + g.length, 0);
      if (!n) continue;
      list.append(
        el("li", { style: `--tint:${TIER_TINT[tier.id]}` },
          el("span", {}, tier.label), el("span", {}, `${n} deck${n === 1 ? "" : "s"}`))
      );
    }
    this.root.append(
      el("div", {},
        el("h1", {}, "All decks placed."),
        list,
        s.skipped.length
          ? el("p", { class: "sub" }, `${s.skipped.length} skipped (not in the export — restore them from Review).`)
          : "",
        el("div", { class: "secondary-row" },
          el("button", { onclick: () => this.h.onExport(), style: "font-weight:600" }, "Download CSV"),
          el("button", { onclick: () => this.h.onOpenScale() }, "View scale"),
          el("button", { onclick: () => this.h.onOpenEdit() }, "Review placements")
        )
      )
    );
  }
}
