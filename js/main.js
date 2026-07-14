// ---------------------------------------------------------------------------
// main.js — bootstrapping and wiring. Owns the session lifecycle and routes
// every UI event through the ranking engine, committing state after each
// mutation so the app is always resumable.
// ---------------------------------------------------------------------------

import { loadAllDecks } from "./sheetsLoader.js";
import { Catalog } from "./catalog.js";
import { Session } from "./state.js";
import {
  nextStep, chooseBracket, answerComparison, deferCurrent,
  skipCurrent, acceptEdgeMove, rerankDeck, reconcileWithCatalog,
} from "./ranking.js";
import { downloadCsv, emailCsv, copyForSheet } from "./exportCsv.js";
import { UI } from "./ui.js";

let catalog = null;
let session = null;
let players = [];

const ui = new UI(document.getElementById("app"), {
  onStart, onBracket, onAnswer, onDefer, onSkip,
  onUndo, onEdgeMove, onRerank, onExport, onOpenEdit, onCloseEdit,
  onResolvePlace, onResetSession, onEmail, onCopy,
});

/** Route a ranking-engine step descriptor to the right screen. */
function render(step) {
  switch (step.type) {
    case "bracket":    ui.renderBracket(step.deckId); break;
    case "compare":    ui.renderCompare(step); break;
    case "edgePrompt": ui.renderEdgePrompt(step); break;
    case "done":       ui.renderDone(); break;
  }
}

function proceed() {
  const step = nextStep(session.state);
  session.commit(); // nextStep may recycle deferred decks into the queue
  render(step);
}

/* ---- handlers ------------------------------------------------------------ */

/** Deck IDs visible to a session, per its scope. Owner matching uses the
 *  worksheet tab name, which is also the player name in the dropdown. */
function scopedIds(player, scope) {
  const ids = catalog.allIds();
  if (scope === "mine") return ids.filter((id) => catalog.get(id).owner === player);
  if (scope === "others") return ids.filter((id) => catalog.get(id).owner !== player);
  return ids;
}

function onStart(player, scope) {
  const existing = Session.load(player);
  if (existing) {
    // A saved session keeps its original scope — switching scope mid-run
    // would silently prune already-ranked decks, so we don't allow it.
    const savedScope = existing.state.scope ?? "all";
    // The sheet may have changed since this session was saved: sync the
    // saved state with the fresh catalog (scoped) before resuming.
    const { added, removed } = reconcileWithCatalog(
      existing.state, scopedIds(player, savedScope));
    if (added || removed) {
      const bits = [];
      if (added) bits.push(`${added} new deck${added === 1 ? "" : "s"} added to your queue`);
      if (removed) bits.push(`${removed} removed deck${removed === 1 ? "" : "s"} cleared`);
      ui.flash = `The sheet changed since last time: ${bits.join(", ")}.`;
    }
    existing.commit();
    session = existing;
  } else {
    session = Session.start(player, scopedIds(player, scope), scope);
  }
  ui.session = session;
  proceed();
}


function onBracket(tierId) {
  session.snapshot();
  const step = chooseBracket(session.state, tierId);
  session.commit();
  render(step);
}

function onAnswer(answer) {
  session.snapshot();
  const step = answerComparison(session.state, answer);
  session.commit();
  render(step);
}

function onDefer() {
  // Peek first: the third defer doesn't mutate state, it demands a decision.
  const deckId = session.state.queue[0];
  if ((session.state.deferCounts[deckId] ?? 0) >= 2) {
    ui.renderMustResolve(deckId);
    return;
  }
  session.snapshot();
  const { step } = deferCurrent(session.state);
  session.commit();
  render(step);
}

/** From the place-or-skip dialog: "make my best guess" → back to brackets. */
function onResolvePlace() {
  render({ type: "bracket", deckId: session.state.queue[0] });
}

function onSkip() {
  session.snapshot();
  const step = skipCurrent(session.state);
  session.commit();
  render(step);
}

function onUndo() {
  if (session.undo()) proceed();
}

/** Edge prompt answer. The deck is already placed at the tier edge; "move"
 *  shifts it to the adjacent tier, "keep" just continues. */
function onEdgeMove(step, accept) {
  if (!accept) {
    render(step.next);
    return;
  }
  session.snapshot();
  const next = acceptEdgeMove(session.state, step.deckId, step.tier, step.direction);
  session.commit();
  render(next);
}

function onRerank(deckId) {
  session.snapshot();
  // If the user re-ranks the very deck mid-insertion, cancel that insertion
  // first so it can't exist in two places at once.
  if (session.state.current?.deckId === deckId) session.state.current = null;
  rerankDeck(session.state, deckId);
  session.commit();
  proceed();
}

/** "Start over" (confirmed in the UI): erase the saved session so the
 *  player can begin fresh, possibly with a different scope. */
function onResetSession(player) {
  Session.clear(player);
}

function onExport() {
  downloadCsv(session.state, catalog);
}

function onEmail() {
  emailCsv(session.state, catalog);
}

function onCopy() {
  return copyForSheet(session.state, catalog); // promise: UI shows Copied!/failed
}

function onOpenEdit() {
  ui.renderEdit();
}

function onCloseEdit() {
  proceed();
}

/* ---- boot ----------------------------------------------------------------- */

async function boot() {
  ui.renderLoading();
  try {
    const { players: tabNames, decks } = await loadAllDecks();
    catalog = new Catalog(decks);
    ui.catalog = catalog;
    players = tabNames;
    if (catalog.size === 0) {
      ui.renderError("The sheet loaded, but no decks were found. Check the 'Deck Name' column headers.");
      return;
    }
    ui.renderStart(players, (player) => {
      const existing = Session.load(player);
      return existing
        ? {
            progress: `${existing.placedCount()}/${existing.totalCount()}`,
            scope: existing.state.scope ?? "all",
          }
        : null;
    });
  } catch (err) {
    ui.renderError(err.message);
  }
}

boot();
