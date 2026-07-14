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
    // The dock positions thumbnails in pixels, so it must relayout when the
    // viewport changes (rotation, window resize).
    window.addEventListener("resize", () => this._layoutDock());
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
          ? [el("button", { onclick: () => this.h.onOpenEdit() }, "Review")]
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

  deckCard(deckId, { eyebrow = "Place this deck", small = false, tierId = null, onclick = null } = {}) {
    const d = this.deck(deckId);
    const attrs = { class: `deck-card${small ? " vs" : ""}${onclick ? " tappable" : ""}` };
    if (onclick) {
      // A tappable card should be a real button to keyboards & assistive tech.
      attrs.role = "button";
      attrs.tabIndex = 0;
      attrs.onclick = onclick;
      attrs.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onclick(); } };
    }
    return el(
      "div",
      attrs,
      this.artBanner(d, small),
      ...(eyebrow ? [el("div", { class: "eyebrow" }, eyebrow)] : []),
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
          el("p", {}, "Check SHEET_ID and PLAYER_TABS in js/config.js, and that the sheet is shared as “anyone with the link can view.”"),
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
    this.root.append(this.deckCard(deckId, { eyebrow: null }));

    const btn = (tier) =>
      el(
        "button",
        {
          class: "bracket-btn",
          style: `--tint:${TIER_TINT[tier.id]}`,
          onclick: () => this.h.onBracket(tier.id),
        },
        tier.label
      );

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
      ),
      this.dock()
    );
  }

  /** Binary-insertion comparison, as a duel: the new deck on the left, the
   *  already-placed pivot on the right — tap whichever is STRONGER.
   *  (Left = new deck stronger; right = pivot stronger, i.e. new is weaker.)
   *  The new deck keeps a fixed side so the eye never has to re-find it. */
  renderCompare(step) {
    this.clear();
    this.root.append(...this.topbar());
    this.root.append(
      el("div", { class: "vs-label" }, "Tap the stronger deck"),
      el("div", { class: "duel" },
        this.deckCard(step.deckId, {
          eyebrow: "Placing", small: true,
          onclick: () => this.h.onAnswer("stronger"),
        }),
        this.deckCard(step.vsId, {
          eyebrow: "Already placed", small: true, tierId: step.tier,
          onclick: () => this.h.onAnswer("weaker"),
        })
      ),
      el("div", { class: "answer-row single" },
        el("button", { class: "same", onclick: () => this.h.onAnswer("same") }, "About the same")
      ),
      this.dock()
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
      ),
      this.dock()
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
      ),
      this.dock()
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
      ),
      this.dock()
    );
  }

  /* ---- the Dock: an always-visible horizontal power timeline -------------
     Fixed to the bottom of every session screen. The axis is the jade→ember
     gradient running weak → strong; each placed deck's art sits ON the axis
     at its exact decimal score, like events on a timeline. When two decks
     would overlap horizontally (ties land at identical x), they stack
     vertically instead, and the dock grows upward to fit. ------------------*/

  dock() {
    const scores = computeScores(this.session.state.buckets);
    // Ascending score; ties ordered by name so stacks are stable frame to frame.
    this._dockEntries = [...scores.entries()]
      .map(([id, { score }]) => {
        const d = this.deck(id);
        return { id, score, name: d.deckName, owner: d.owner, art: d.artUrl };
      })
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

    const canvas = el("div", { class: "dock-canvas" });

    // Axis bar + boundary ticks. Majors at whole brackets, minors at the
    // Low/Mid/High thirds — same 1..6 → 0..1 mapping as the thumbnails.
    const axis = el("div", { class: "dock-axis" });
    const tickAt = (v, major) =>
      el("span", {
        class: `dock-tick${major ? " major" : ""}`,
        style: `left:${((v - 1) / 5) * 100}%`,
      });
    for (const v of [2, 3, 4, 5]) axis.append(tickAt(v, true));
    for (const base of [2, 3, 4]) {
      axis.append(tickAt(base + 1 / 3, false), tickAt(base + 2 / 3, false));
    }

    const labels = el("div", { class: "dock-labels" },
      ...["B1", "B2", "B3", "B4", "B5"].map((b) => el("span", {}, b))
    );

    const dock = el("div", { class: "dock" },
      el("div", { class: "dock-info-slot" }), canvas, axis, labels);
    // Layout needs real pixel widths, which only exist once in the DOM.
    requestAnimationFrame(() => this._layoutDock());
    return dock;
  }

  /** Tap a thumbnail → its details + a Re-rank action appear above the axis.
   *  Deliberately two-step: thumbs are small on phones, and a single
   *  mis-tap must never silently un-place a deck. Tapping the same thumb
   *  again (or ✕) dismisses. */
  _selectDockDeck(entry) {
    const slot = this.root.querySelector(".dock-info-slot");
    if (!slot) return;
    if (this._dockSelected === entry.id) {
      this._dockSelected = null;
      slot.replaceChildren();
    } else {
      this._dockSelected = entry.id;
      slot.replaceChildren(
        el("div", { class: "dock-info" },
          el("span", { class: "dock-info-name" },
            entry.name, " ",
            el("span", { class: "who" }, `· ${entry.owner} · ${entry.score.toFixed(2)}`)),
          el("button", {
            onclick: () => { this._dockSelected = null; this.h.onRerank(entry.id); },
          }, "Re-rank"),
          el("button", { class: "ghost", onclick: () => this._selectDockDeck(entry) }, "✕")
        )
      );
    }
    // Repaint selection outlines without a full relayout.
    for (const t of this.root.querySelectorAll(".dock-thumb")) {
      t.classList.toggle("selected", t.dataset.id === this._dockSelected);
    }
  }

  _layoutDock() {
    const canvas = this.root.querySelector(".dock-canvas");
    if (!canvas || !this._dockEntries) return;
    const W = canvas.clientWidth;
    const THUMB = W < 480 ? 26 : 34; // smaller thumbs on phones
    const LANE = Math.round(THUMB * 0.76); // vertical step (slight shingle)
    const MAX_LANES = 5;

    // Adaptive density: start with comfortable horizontal spacing; if the
    // stacks grow too tall for the viewport, tighten the gap (thumbs shingle
    // harder) until the tallest stack fits. Exact ties always stack no
    // matter the gap, which is precisely the behavior we want.
    let gap = Math.round(THUMB * 0.6);
    let placed, maxLane;
    do {
      placed = [];
      maxLane = 0;
      const laneRight = [];
      for (const e of this._dockEntries) {
        const x = ((e.score - 1) / 5) * (W - THUMB);
        let lane = 0;
        while (laneRight[lane] !== undefined && x - laneRight[lane] < gap) lane++;
        laneRight[lane] = x;
        maxLane = Math.max(maxLane, lane);
        placed.push({ e, x, lane });
      }
      gap -= 3;
    } while (maxLane >= MAX_LANES && gap > 3);

    // Height cap: many similar scores can pile into a very tall stack (see
    // dense playgroups). Rather than let the dock eat the screen, compress
    // the vertical step so the tallest stack fits MAX_H — thumbs shingle
    // like a fanned hand of cards, and every deck stays visible and
    // tappable (tap → info bar → re-rank).
    const MAX_H = W < 480 ? 92 : 130;
    const laneStep = maxLane > 0
      ? Math.min(LANE, Math.max(7, Math.floor((MAX_H - THUMB) / maxLane)))
      : LANE;

    canvas.replaceChildren();
    for (const { e, x, lane } of placed) {
      const thumb = e.art
        ? el("img", {
            class: "dock-thumb", src: e.art, alt: e.name, loading: "lazy",
            onerror: (ev) => ev.target.replaceWith(this._placeholderThumb(e)),
          })
        : this._placeholderThumb(e);
      thumb.title = `${e.name} (${e.owner}) — ${e.score.toFixed(2)}`;
      thumb.dataset.id = e.id;
      thumb.classList.toggle("selected", this._dockSelected === e.id);
      thumb.addEventListener("click", () => this._selectDockDeck(e));
      thumb.style.left = `${x}px`;
      thumb.style.bottom = `${lane * laneStep}px`;
      thumb.style.width = thumb.style.height = `${THUMB}px`;
      thumb.style.zIndex = lane + 1; // upper stack levels render above
      canvas.append(thumb);
    }
    canvas.style.height = `${maxLane * laneStep + THUMB + 4}px`;
  }

  _placeholderThumb(e) {
    // No art URL: a monogram chip so the deck still shows on the timeline.
    const initials = e.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    return el("span", { class: "dock-thumb placeholder" }, initials);
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
          el("button", { onclick: () => this.h.onOpenEdit() }, "Review placements")
        )
      ),
      this.dock()
    );
  }
}
