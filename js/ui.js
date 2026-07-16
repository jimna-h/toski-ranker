// ---------------------------------------------------------------------------
// ui.js — rendering and event wiring only. No ranking logic, no storage.
//
// main.js constructs UI with a set of handler callbacks; every screen is a
// render function that rebuilds #app. At this scale, full re-render per
// action is simpler and plenty fast — no framework needed.
// ---------------------------------------------------------------------------

import { TIERS, tierById, ACTIVE_MODE, MODES } from "./config.js";
import { computeScores } from "./scoring.js";

/* ---- power-gradient tints -------------------------------------------------
   Each of the 11 tiers gets a color sampled from the jade→amber→ember axis.
   Computed once here (rather than 11 hand-picked hexes) so the timeline and
   any future aggregate view use the exact same function. */

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
/** Tier → tint, computed against the ACTIVE mode's tier count so both the
 *  11-step power scale and the 6-step dependency scale span the full
 *  gradient. A function rather than a precomputed map because the active
 *  mode can change between sessions. */
function tierTint(tierId) {
  const i = TIERS.findIndex((t) => t.id === tierId);
  return powerTint(i / (TIERS.length - 1));
}

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
   * @param {object} handlers callbacks provided by main.js.
   */
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.catalog = null;
    this.session = null;
    /** One-shot notice (e.g. "sheet changed") set by main.js. */
    this.flash = null;
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
      el("button", { class: "title", onclick: () => this.h.onHome(), title: "Back to start" }, "Toski Ranker"),
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

  /** "Decklist ↗" link, or nothing when the sheet has no Archidekt URL.
   *  stopPropagation keeps it usable inside tappable duel cards — opening
   *  the list must never count as answering the comparison. */
  decklistLink(d) {
    if (!d.archidektUrl) return "";
    return el("a", {
      class: "decklist-link",
      href: d.archidektUrl,
      target: "_blank",
      rel: "noopener",
      onclick: (e) => e.stopPropagation(),
    }, "Decklist ↗");
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
        : []),
      this.decklistLink(d)
    );
  }

  /* ---- screens ---- */

  renderLoading(msg = "Loading deck list from Google Sheets…") {
    this.clear();
    this.root.append(el("div", { class: "start" }, el("h1", {}, "Toski Ranker"), el("p", { class: "sub" }, msg)));
  }

  renderError(message) {
    this.clear();
    this.root.append(
      el("div", { class: "start" },
        el("h1", {}, "Toski Ranker"),
        el("div", { class: "error" },
          el("strong", {}, "Couldn't load the deck list."),
          el("p", {}, message),
          el("p", {}, "Check SHEET_ID and PLAYER_TABS in js/config.js, and that the sheet is shared as “anyone with the link can view.”"),
          el("button", { onclick: () => location.reload() }, "Try again")
        )
      )
    );
  }

  /** Player picker + scope choice. `sessionInfo(player)` returns
   *  { progress: "12/70", scope: "mine" } for a saved session, or null. */
  renderStart(players, sessionInfo) {
    this.clear();
    const select = el("select", {},
      el("option", { value: "" }, "Choose your name…"),
      ...players.map((p) => el("option", { value: p }, p))
    );

    // Mode: which scale this session ranks on. Each player can have one
    // session PER mode, so switching modes here switches which session
    // Resume points at rather than replacing anything.
    let mode = "power";
    const modeRow = el("div", { class: "scope-row mode-row" });
    const paintModes = () => {
      modeRow.replaceChildren(
        ...Object.values(MODES).map((m) =>
          el("button", {
            class: `scope-btn${mode === m.id ? " active" : ""}`,
            onclick: () => { mode = m.id; paintModes(); refresh(); },
          }, m.name)
        )
      );
    };

    // Scope: which decks this session rates. "All decks" is the default;
    // a resumed session keeps its saved scope (switching would prune work),
    // so the choice locks while a session exists — Start over unlocks it.
    const SCOPES = [["all", "All decks"], ["mine", "My decks"], ["others", "Not my decks"]];
    let scope = "all";
    let locked = false;
    const scopeRow = el("div", { class: "scope-row" });
    const paintScopes = () => {
      scopeRow.replaceChildren(
        ...SCOPES.map(([value, label]) =>
          el("button", {
            class: `scope-btn${scope === value ? " active" : ""}`,
            disabled: locked,
            onclick: () => { scope = value; paintScopes(); },
          }, label)
        )
      );
    };

    const go = el("button", { class: "go", disabled: true }, "Start ranking");
    const restartArea = el("div", {});

    /** Repaint scope / go / restart for the currently selected player. */
    const refresh = () => {
      const player = select.value;
      const info = player ? sessionInfo(player, mode) : null;
      go.disabled = !player;
      locked = !!info;
      if (info) scope = info.scope;
      paintScopes();
      go.textContent = info ? `Resume (${info.progress} placed)` : "Start ranking";
      go.dataset.mode = mode;

      restartArea.replaceChildren();
      if (info) {
        // Two-step restart: the destructive action always hides behind an
        // explicit confirmation that names what will be lost.
        const restartBtn = el("button", { class: "ghost-wide" }, "Start over from scratch");
        restartBtn.addEventListener("click", () => {
          restartArea.replaceChildren(
            el("div", { class: "notice" },
              el("strong", {}, `Erase ${player}'s progress?`),
              el("p", {}, `This permanently deletes ${player}'s ${MODES[mode].name.toLowerCase()} progress (${info.progress} placed) on this device. Are you sure?`),
              el("div", { class: "actions" },
                el("button", { onclick: () => { this.h.onResetSession(player, mode); refresh(); } }, "Yes, start over"),
                el("button", { onclick: refresh }, "Cancel")
              )
            )
          );
        });
        restartArea.append(restartBtn);
      }
    };
    paintModes();
    paintScopes();
    select.addEventListener("change", refresh);
    go.addEventListener("click", () => this.h.onStart(select.value, scope, mode));

    this.root.append(
      el("div", { class: "start" },
        el("h1", {}, "Toski Ranker"),
        el("p", { class: "sub" }, "Every deck, one at a time. Pick a bracket, answer a couple of comparisons, done. Progress saves automatically — close the tab whenever."),
        select,
        modeRow,
        scopeRow,
        go,
        restartArea
      )
    );
  }

  /** Bracket-choice screen for the deck at the front of the queue. */
  /** Modal listing every tier of the active mode with its full description.
   *  Opened by the \u24d8 button on the bracket screen \u2014 explicit tap, never
   *  hover, because tooltips are invisible on phones and ugly everywhere. */
  showTierInfo() {
    document.querySelector(".info-modal")?.remove();
    const modal = el("div", { class: "info-modal",
      onclick: (ev) => { if (ev.target === modal) modal.remove(); } },
      el("div", { class: "info-panel" },
        el("button", { class: "info-close", onclick: () => modal.remove() }, "\u2715"),
        el("h2", {}, "The tiers"),
        ...TIERS.filter((t) => t.blurb).map((t) =>
          el("div", { class: "info-tier", style: `--tint:${tierTint(t.id)}` },
            el("h3", {}, t.label),
            el("p", {}, t.blurb))),
      ));
    document.body.append(modal);
  }

  renderBracket(deckId) {
    this.clear();
    this.root.append(...this.topbar());
    this.root.append(this.deckCard(deckId, { eyebrow: null }));

    const btn = (tier) =>
      el(
        "button",
        {
          class: "bracket-btn",
          style: `--tint:${tierTint(tier.id)}`,
          onclick: () => this.h.onBracket(tier.id),
        },
        tier.label
      );

    // Row layout comes from the active mode (power: 1/3/3/3/1 mirroring the
    // bracket structure; dependency: 2 rows of 3).
    const rows = ACTIVE_MODE.rows;
    this.root.append(
      el("div", { class: "bracket-grid" },
        ...rows.map((idxs) =>
          el("div", { class: `bracket-row${idxs.length === 1 ? " single" : ""}` },
            ...idxs.map((i) => btn(TIERS[i]))
          )
        )
      ),
      el("div", { class: "secondary-row" },
        el("button", { onclick: () => this.h.onDefer() }, "Come back later"),
        TIERS.some((t) => t.blurb)
          ? el("button", { class: "info-btn", onclick: () => this.showTierInfo() },
              "\u24d8 What do these mean?")
          : ""
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
      const section = el("div", { class: "edit-tier", style: `--tint:${tierTint(tier.id)}` },
        el("h2", {}, tier.label)
      );
      // Strongest first within the tier — matches how players talk about lists.
      for (const group of [...groups].reverse()) {
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
      }
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
     vertically instead. ---------------------------------------------------*/

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

    // Axis bar + boundary ticks, all driven by the active mode's axis
    // config (power: majors at whole brackets, minors at the Low/Mid/High
    // thirds over 1–6; dependency: majors at tier bounds over 1–7).
    const { min, max, majorTicks, minorTicks, labels: axisLabels } = ACTIVE_MODE.axis;
    const axis = el("div", { class: "dock-axis" });
    const tickAt = (v, major) =>
      el("span", {
        class: `dock-tick${major ? " major" : ""}`,
        style: `left:${((v - min) / (max - min)) * 100}%`,
      });
    for (const v of majorTicks) axis.append(tickAt(v, true));
    for (const v of minorTicks) axis.append(tickAt(v, false));

    const labels = el("div", { class: "dock-labels" },
      ...axisLabels.map((b) => el("span", {}, b))
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
          this.decklistLink(this.deck(entry.id)),
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
    // Thumbnail size scales with crowding: with few decks (or a wide
    // screen) thumbs sit at full size; as average px-per-deck shrinks, so
    // do the thumbs — down to a floor that stays recognizable & tappable.
    const base = W < 480 ? 28 : 36;
    const n = this._dockEntries.length;
    const density = n > 0 ? W / n : Infinity; // px of axis per deck
    const THUMB = Math.round(Math.max(18, Math.min(base, density * 1.6)));
    const LANE = Math.round(THUMB * 0.76); // vertical step (slight shingle)
    const MAX_LANES = 5;

    // Adaptive density: start with comfortable horizontal spacing; if the
    // stacks grow too tall, tighten the gap (thumbs shingle harder) until
    // the tallest stack fits. Exact ties always stack no matter the gap,
    // which is precisely the behavior we want.
    let gap = Math.round(THUMB * 0.6);
    let placed, maxLane;
    do {
      placed = [];
      maxLane = 0;
      const laneRight = [];
      for (const e of this._dockEntries) {
        const { min, max } = ACTIVE_MODE.axis;
        const x = ((e.score - min) / (max - min)) * (W - THUMB);
        let lane = 0;
        while (laneRight[lane] !== undefined && x - laneRight[lane] < gap) lane++;
        laneRight[lane] = x;
        maxLane = Math.max(maxLane, lane);
        placed.push({ e, x, lane });
      }
      gap -= 3;
    } while (maxLane >= MAX_LANES && gap > 3);

    // Height cap: many similar scores can pile into a very tall stack.
    // Rather than let the dock eat the screen, compress the vertical step
    // so the tallest stack fits MAX_H — thumbs shingle like a fanned hand
    // of cards, and every deck stays visible and tappable.
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
    const initials = (e.name ?? "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    return el("span", { class: "dock-thumb placeholder" }, initials);
  }

  /** All decks handled: the full placements, rebuilt visually — every tier
   *  strongest-first (B5 at the top), each deck as an art chip. Multi-deck
   *  tie groups render as one visually joined cluster. */
  renderDone() {
    this.clear();
    this.root.append(...this.topbar(false));
    const s = this.session.state;

    const gallery = el("div", { class: "gallery" });
    // Strongest tier first — that's how players brag about lists.
    for (const tier of [...TIERS].reverse()) {
      const groups = s.buckets[tier.id];
      if (!groups?.length) continue;
      const section = el("div", { class: "gallery-tier", style: `--tint:${tierTint(tier.id)}` },
        el("h2", {}, tier.label));
      const rowEl = el("div", { class: "gallery-row" });
      // Groups strongest → weakest within the tier; a multi-deck group is a
      // tie and renders as one visually joined cluster.
      for (const group of [...groups].reverse()) {
        const cluster = el("div", { class: `gallery-cluster${group.length > 1 ? " tied" : ""}` });
        for (const id of group) {
          const d = this.deck(id);
          cluster.append(
            el("figure", { class: "gallery-deck" },
              d.artUrl
                ? el("img", { src: d.artUrl, alt: "", loading: "lazy",
                    onerror: (e) => { e.target.replaceWith(this._placeholderThumb({ name: d.deckName })); } })
                : this._placeholderThumb({ name: d.deckName }),
              el("figcaption", {}, d.deckName)
            )
          );
        }
        rowEl.append(cluster);
      }
      section.append(rowEl);
      gallery.append(section);
    }

    const copyBtn = el("button", {}, "Copy for spreadsheet");
    copyBtn.addEventListener("click", async () => {
      try {
        await this.h.onCopy();
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy for spreadsheet"; }, 1800);
      } catch {
        copyBtn.textContent = "Copy failed — use Download";
      }
    });

    this.root.append(
      el("div", {},
        el("h1", {}, "All decks placed."),
        gallery,
        s.skipped.length
          ? el("p", { class: "sub" }, `${s.skipped.length} skipped (not in the export — restore them from Review).`)
          : "",
        el("div", { class: "secondary-row export-row" },
          el("button", { onclick: () => this.h.onEmail(), class: "primary" }, "Send to James"),
          el("button", { onclick: () => this.h.onExport() }, "Download CSV"),
          copyBtn,
          el("button", { onclick: () => this.h.onOpenEdit() }, "Review placements")
        )
      ),
      this.dock()
    );
  }
}
