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
import { downloadCsv } from "./exportCsv.js";
import { UI } from "./ui.js";

let catalog = null;
let session = null;
let players = [];

const ui = new UI(document.getElementById("app"), {
  onStart, onBracket, onAnswer, onDefer, onSkip,
  onUndo, onEdgeMove, onRerank, onExport, onOpenEdit, onCloseEdit,
  onResolvePlace,
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

function onStart(player) {
  const existing = Session.load(player);
  if (existing) {
    // The sheet may have changed since this session was saved: sync the
    // saved state with the fresh catalog before resuming.
    const { added, removed } = reconcileWithCatalog(existing.state, catalog.allIds());
    if (added || removed) {
      const bits = [];
      if (added) bits.push(`${added} new deck${added === 1 ? "" : "s"} added to your queue`);
      if (removed) bits.push(`${removed} removed deck${removed === 1 ? "" : "s"} cleared`);
      ui.flash = `The sheet changed since last time: ${bits.join(", ")}.`;
    }
    existing.commit();
    session = existing;
  } else {
    session = Session.start(player, catalog.allIds());
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

function onExport() {
  downloadCsv(session.state, catalog);
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
      return existing ? `${existing.placedCount()}/${existing.totalCount()}` : null;
    });
  } catch (err) {
    ui.renderError(err.message);
  }
}

boot();
