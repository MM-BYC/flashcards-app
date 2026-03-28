/* ============================================================
   app.js — Flashcards App  |  Parts 2 – 5
   ============================================================
   Architecture:
     - state: single in-memory source of truth.
     - storage.js: handles all LocalStorage I/O (loaded before this file).
     - app.js: owns UI, event wiring, and state mutations.
     - Every mutation calls saveState(state) immediately (no batching needed
       at this data scale — typical payload is < 50 KB).
     - Event listeners attached ONCE: direct bindings for static buttons;
       delegated listeners for dynamic lists (decks, cards).
     - Modal class: focus trap + ESC + return-focus-to-opener.
     - Study module: enterStudyMode() attaches listeners by reference;
       exitStudyMode() removes them — zero leaks across sessions.
     - Card search: debounced 300 ms, view-only (never mutates state.decks),
       shows live match count with zero-results styling.
   ============================================================ */

'use strict';

/* ============================================================
   SECTION 1 — STATE
   ============================================================
   Persistence (loadState / saveState) is now in storage.js, which is
   loaded before this file via <script src="storage.js"> in index.html.
   app.js calls those functions directly — they are globals on the page.

   Keeping state here (not in storage.js) maintains the separation:
     storage.js = I/O only (reads/writes LocalStorage)
     app.js     = state ownership + all UI logic
   ============================================================ */

/**
 * Application state — the single source of truth.
 *
 * @typedef {{ id:string, front:string, back:string }} Card
 * @typedef {{ id:string, name:string, cards:Card[] }} Deck
 */
const state = {
  /** @type {Deck[]} */
  decks: [],
  /** @type {string|null} */
  activeDeckId: null,
  /** @type {string|null} null = creating new deck, string = editing existing */
  editingDeckId: null,
  /** @type {string|null} null = creating new card, string = editing existing */
  editingCardId: null,

  // Study sub-state — owned by enterStudyMode / exitStudyMode.
  study: {
    /** @type {Card[]} session working copy; never mutates deck.cards */
    cards: [],
    /** @type {number} */
    index: 0,
    /** @type {boolean} */
    flipped: false,
    /** @type {HTMLElement|null} */
    opener: null,
    /**
     * Stored handler references for removeEventListener symmetry.
     * See Section 9 (Study Mode) for full explanation.
     * @type {{ docKey:Function, cardClick:Function, cardKey:Function }|null}
     */
    _handlers: null,
  },
};

/**
 * Collision-resistant UID: timestamp (base-36) + random suffix.
 * Sufficient for client-side IDs — no server or crypto.randomUUID() needed.
 * @returns {string}
 */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** @param {string} id @returns {Deck|undefined} */
const getDeck = id => state.decks.find(d => d.id === id);

/**
 * Find a card within the active deck.
 * @param {string} cardId
 * @returns {Card|undefined}
 */
function getCard(cardId) {
  const deck = getDeck(state.activeDeckId);
  return deck?.cards.find(c => c.id === cardId);
}

/**
 * Fisher-Yates shuffle — returns a NEW array (does not mutate the original).
 * Used in study mode to shuffle a copy of the deck's cards array so the
 * stored order in LocalStorage is never affected.
 * @param {any[]} arr
 * @returns {any[]}
 */
/**
 * Debounce — returns a function that delays invoking `fn` until `ms`
 * milliseconds have elapsed since the last call.
 *
 * How it works:
 *   - Each call clears the previous setTimeout and starts a new one.
 *   - `fn` only fires when the caller stops calling for at least `ms` ms.
 *   - The timer ID is kept in closure — no global variable needed.
 *
 * Used for the card search input so renderCardList() fires once per
 * typing pause (300 ms) rather than on every keystroke.
 *
 * @param {Function} fn   — function to debounce
 * @param {number}   ms   — quiet period in milliseconds
 * @returns {Function}
 */
function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    // Arrow function so `this` from the call site is preserved if needed.
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


/* ============================================================
   SECTION 2 — ACCESSIBLE MODAL SYSTEM
   ============================================================
   Implements the WAI-ARIA dialog pattern:
     - Focus moves into modal on open (first focusable element).
     - Tab/Shift+Tab cycles within the modal only (focus trap).
     - ESC closes and returns focus to the opener element.
     - Clicking the backdrop (overlay, not the modal box) closes.

   Reference: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
   ============================================================ */

/** Selector for all elements that accept keyboard focus. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

class Modal {
  /** @param {HTMLElement} overlayEl */
  constructor(overlayEl) {
    this.overlay = overlayEl;
    this._opener      = null;
    this._onKeyDown   = this._handleKeyDown.bind(this);
    this._onBackdrop  = this._handleBackdrop.bind(this);
  }

  /** @param {HTMLElement} [openerEl] — receives focus when modal closes */
  open(openerEl) {
    this._opener = openerEl ?? document.activeElement;
    this.overlay.removeAttribute('hidden');
    // requestAnimationFrame: wait one paint cycle so the overlay is visible
    // before moving focus — some browsers ignore focus() on hidden elements.
    requestAnimationFrame(() => {
      const first = this._focusable()[0];
      if (first) first.focus();
    });
    document.addEventListener('keydown', this._onKeyDown);
    this.overlay.addEventListener('click', this._onBackdrop);
  }

  close() {
    this.overlay.setAttribute('hidden', '');
    document.removeEventListener('keydown', this._onKeyDown);
    this.overlay.removeEventListener('click', this._onBackdrop);
    // isConnected check: opener may have been removed (e.g. after a deck delete).
    if (this._opener?.isConnected) this._opener.focus();
    this._opener = null;
  }

  /** @returns {HTMLElement[]} focusable children not inside a [hidden] subtree */
  _focusable() {
    return Array.from(this.overlay.querySelectorAll(FOCUSABLE))
      .filter(el => !el.closest('[hidden]'));
  }

  _handleKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key !== 'Tab') return;

    const els   = this._focusable();
    if (!els.length) return;
    const first = els[0];
    const last  = els[els.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      // Shift+Tab from first (or outside) → wrap to last.
      if (active === first || !this.overlay.contains(active)) {
        e.preventDefault(); last.focus();
      }
    } else {
      // Tab from last (or outside) → wrap to first.
      if (active === last || !this.overlay.contains(active)) {
        e.preventDefault(); first.focus();
      }
    }
  }

  _handleBackdrop(e) {
    // Close only when the semi-transparent overlay itself is clicked,
    // not when the white modal box inside it is clicked.
    if (e.target === this.overlay) this.close();
  }
}


/* ============================================================
   SECTION 3 — CONFIRM DIALOG
   ============================================================
   Promise-based wrapper so callers can await the user's choice:
     if (await confirmDialog('Delete "Biology"?')) { ... delete ... }

   ESC / Cancel  → resolves false
   Confirm click → resolves true

   The close() override ensures the Promise always resolves even when
   the modal is dismissed via ESC (which calls close() directly).
   ============================================================ */

const confirmModal    = new Modal(document.getElementById('modal-confirm'));
const confirmMessage  = document.getElementById('confirm-message');
const btnConfirmOk    = document.getElementById('btn-confirm-ok');
const btnConfirmCancel = document.getElementById('btn-confirm-cancel');
let _confirmResolve = null;

/**
 * @param {string} message
 * @param {string} [okLabel='Delete']
 * @param {HTMLElement} [opener]
 * @returns {Promise<boolean>}
 */
function confirmDialog(message, okLabel = 'Delete', opener = null) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    confirmMessage.textContent = message;
    btnConfirmOk.textContent   = okLabel;
    confirmModal.open(opener);
  });
}

// Override close() so that ESC, backdrop-click, and Cancel all resolve false.
// The OK path nulls _confirmResolve first so the override is a no-op for it.
const _confirmCloseBase = confirmModal.close.bind(confirmModal);
confirmModal.close = () => {
  _confirmCloseBase();
  if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
};

// OK: null the resolver first (prevents the override from firing it as false),
// close the modal via the base method, then resolve true.
btnConfirmOk.addEventListener('click', () => {
  const resolve    = _confirmResolve;
  _confirmResolve  = null;        // disarm the override
  _confirmCloseBase();            // close without resolving false
  if (resolve) resolve(true);     // resolve the awaited Promise as confirmed
});

// Cancel: delegate to the overridden close() which resolves false.
btnConfirmCancel.addEventListener('click', () => confirmModal.close());


/* ============================================================
   SECTION 4 — DECK MODAL (Create / Edit)
   ============================================================ */

const deckModal      = new Modal(document.getElementById('modal-deck'));
const deckModalTitle = document.getElementById('modal-deck-title');
const formDeck       = document.getElementById('form-deck');
const inputDeckName  = document.getElementById('input-deck-name');
const deckNameError  = document.getElementById('deck-name-error');

/** Open in create mode. */
function openNewDeckModal(opener) {
  state.editingDeckId   = null;
  deckModalTitle.textContent = 'New Deck';
  inputDeckName.value   = '';
  _hideDeckError();
  deckModal.open(opener);
}

/** Open in edit mode, pre-filled with existing name. */
function openEditDeckModal(deckId, opener) {
  const deck = getDeck(deckId);
  if (!deck) return;
  state.editingDeckId   = deckId;
  deckModalTitle.textContent = 'Edit Deck';
  inputDeckName.value   = deck.name;
  _hideDeckError();
  deckModal.open(opener);
}

function _showDeckError(msg) {
  deckNameError.textContent = msg;
  deckNameError.removeAttribute('hidden');
  inputDeckName.setAttribute('aria-invalid', 'true');
}
function _hideDeckError() {
  deckNameError.setAttribute('hidden', '');
  inputDeckName.removeAttribute('aria-invalid');
}

document.getElementById('btn-cancel-deck').addEventListener('click', () => deckModal.close());

// Submit handles both create and edit.
// Listening on the form's "submit" event (not the button "click") means
// pressing Enter inside the input also triggers save — no extra keydown handler.
formDeck.addEventListener('submit', e => {
  e.preventDefault();
  const name = inputDeckName.value.trim();

  if (!name) {
    _showDeckError('Deck name is required.');
    inputDeckName.focus();
    return;
  }
  if (name.length > 100) {
    _showDeckError('Deck name must be 100 characters or fewer.');
    inputDeckName.focus();
    return;
  }

  if (state.editingDeckId) {
    const deck = getDeck(state.editingDeckId);
    if (deck) deck.name = name;
  } else {
    const newDeck = { id: uid(), name, cards: [] };
    state.decks.push(newDeck);
    state.activeDeckId = newDeck.id; // auto-select newly created deck
  }

  saveState(state);
  deckModal.close();
  renderSidebar();
  renderMainView();
});


/* ============================================================
   SECTION 5 — CARD MODAL (Create / Edit)
   ============================================================
   Reuses the single #modal-card element for both operations.
   state.editingCardId distinguishes create (null) from edit (string).
   ============================================================ */

const cardModal       = new Modal(document.getElementById('modal-card'));
const cardModalTitle  = document.getElementById('modal-card-title');
const formCard        = document.getElementById('form-card');
const inputCardFront  = document.getElementById('input-card-front');
const inputCardBack   = document.getElementById('input-card-back');
const cardFrontError  = document.getElementById('card-front-error');
const cardBackError   = document.getElementById('card-back-error');

/** Open card modal in create mode for the active deck. */
function openNewCardModal(opener) {
  state.editingCardId = null;
  cardModalTitle.textContent = 'New Card';
  inputCardFront.value = '';
  inputCardBack.value  = '';
  _hideCardErrors();
  cardModal.open(opener);
}

/**
 * Open card modal in edit mode, pre-filled with the card's current text.
 * @param {string} cardId
 * @param {HTMLElement} opener
 */
function openEditCardModal(cardId, opener) {
  const card = getCard(cardId);
  if (!card) return;
  state.editingCardId = cardId;
  cardModalTitle.textContent = 'Edit Card';
  inputCardFront.value = card.front;
  inputCardBack.value  = card.back;
  _hideCardErrors();
  cardModal.open(opener);
}

function _showCardError(el, errorEl, msg) {
  errorEl.textContent = msg;
  errorEl.removeAttribute('hidden');
  el.setAttribute('aria-invalid', 'true');
}
function _hideCardErrors() {
  cardFrontError.setAttribute('hidden', '');
  cardBackError.setAttribute('hidden', '');
  inputCardFront.removeAttribute('aria-invalid');
  inputCardBack.removeAttribute('aria-invalid');
}

document.getElementById('btn-cancel-card').addEventListener('click', () => cardModal.close());

formCard.addEventListener('submit', e => {
  e.preventDefault();
  _hideCardErrors();

  const front = inputCardFront.value.trim();
  const back  = inputCardBack.value.trim();
  let valid   = true;

  // Validate both fields; show independent errors (don't stop at first).
  if (!front) {
    _showCardError(inputCardFront, cardFrontError, 'Front text is required.');
    valid = false;
  }
  if (!back) {
    _showCardError(inputCardBack, cardBackError, 'Back text is required.');
    valid = false;
  }
  if (!valid) {
    // Focus the first invalid field.
    if (!front) inputCardFront.focus();
    else inputCardBack.focus();
    return;
  }

  const deck = getDeck(state.activeDeckId);
  if (!deck) return;

  if (state.editingCardId) {
    // UPDATE: mutate the card in place so the surrounding deck array is untouched.
    // Finding by ID (not index) is important: the card list may be filtered/reordered
    // in the UI, but IDs are always stable and unique.
    const card = deck.cards.find(c => c.id === state.editingCardId);
    if (card) { card.front = front; card.back = back; }
  } else {
    // CREATE: each card gets a uid() generated fresh at creation time.
    // IDs are never reused — even if a card is deleted and a new one is created,
    // the new card gets a brand-new ID. This prevents stale ID collisions in
    // LocalStorage or the DOM (quality check: "IDs/keys reused incorrectly").
    deck.cards.push({ id: uid(), front, back });
  }

  saveState(state);
  cardModal.close();
  // Re-render both sidebar (card count badge) and main view (card grid).
  renderSidebar();
  renderMainView();
});


/* ============================================================
   SECTION 6 — SIDEBAR RENDERING
   ============================================================
   Full re-render on every mutation — safe because the list is small
   and a single delegated listener handles all clicks (no duplicates).
   ============================================================ */

const deckList   = document.getElementById('deck-list');
const noDecksMsg = document.getElementById('no-decks-msg');

function renderSidebar() {
  deckList.innerHTML = state.decks.map(deck => {
    const isActive    = deck.id === state.activeDeckId;
    const count       = deck.cards.length;
    const countLabel  = count === 1 ? '1 card' : `${count} cards`;
    return `
      <li class="deck-item${isActive ? ' active' : ''}" role="listitem" data-deck-id="${deck.id}">
        <button class="deck-item-btn" ${isActive ? 'aria-current="true"' : ''}
                data-action="select-deck" data-deck-id="${deck.id}">
          <span class="deck-name"></span>
          <span class="deck-count">${count === 0 ? 'No cards' : countLabel}</span>
        </button>
        <div class="deck-item-actions">
          <button class="btn-icon" data-action="edit-deck" data-deck-id="${deck.id}" aria-label="Edit deck">✏️</button>
          <button class="btn-icon danger" data-action="delete-deck" data-deck-id="${deck.id}" aria-label="Delete deck">🗑</button>
        </div>
      </li>`;
  }).join('');

  // Inject text via textContent AFTER innerHTML to prevent XSS from deck names.
  state.decks.forEach(deck => {
    const li = deckList.querySelector(`li[data-deck-id="${deck.id}"]`);
    if (!li) return;
    li.querySelector('.deck-name').textContent = deck.name;
    li.querySelector('[data-action="edit-deck"]').setAttribute('aria-label',   `Edit deck "${deck.name}"`);
    li.querySelector('[data-action="delete-deck"]').setAttribute('aria-label', `Delete deck "${deck.name}"`);
  });

  noDecksMsg[state.decks.length === 0 ? 'removeAttribute' : 'setAttribute']('hidden', '');
}

// Single delegated listener — attached once at startup.
// Using closest('[data-action]') correctly handles clicks on child nodes
// (e.g. the emoji text node inside a button).
deckList.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, deckId } = el.dataset;

  if (action === 'select-deck') {
    state.activeDeckId = deckId;
    saveState(state);
    renderSidebar();
    renderMainView();

  } else if (action === 'edit-deck') {
    openEditDeckModal(deckId, el);

  } else if (action === 'delete-deck') {
    const deck = getDeck(deckId);
    if (!deck) return;
    const ok = await confirmDialog(
      `Delete "${deck.name}"? This will remove all ${deck.cards.length} card(s).`,
      'Delete', el
    );
    if (!ok) return;

    state.decks = state.decks.filter(d => d.id !== deckId);
    if (state.activeDeckId === deckId) {
      state.activeDeckId = state.decks[0]?.id ?? null;
    }
    saveState(state);
    renderSidebar();
    renderMainView();
  }
});

// Deck search: hide/show rendered <li> items without re-rendering.
// This preserves the delegated listener bindings and avoids a list rebuild
// on every keystroke.
document.getElementById('deck-search').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  deckList.querySelectorAll('.deck-item').forEach(li => {
    const match = !q || li.querySelector('.deck-name').textContent.toLowerCase().includes(q);
    li.style.display = match ? '' : 'none';
  });
});


/* ============================================================
   SECTION 7 — MAIN VIEW SWITCHING
   ============================================================ */

const viewEmpty     = document.getElementById('view-empty');
const viewDeck      = document.getElementById('view-deck');
const viewStudy     = document.getElementById('view-study');
const deckTitleEl   = document.getElementById('deck-title');
const deckCardCount = document.getElementById('deck-card-count');
const btnStudy      = document.getElementById('btn-study');

/** Show exactly one view; hide the other two. */
function showView(target) {
  [viewEmpty, viewDeck, viewStudy].forEach(v =>
    v[v === target ? 'removeAttribute' : 'setAttribute']('hidden', '')
  );
}

function renderMainView() {
  const deck = getDeck(state.activeDeckId);
  if (!deck) { showView(viewEmpty); return; }

  deckTitleEl.textContent = deck.name;
  const count = deck.cards.length;
  deckCardCount.textContent = count === 1 ? '1 card' : `${count} cards`;

  // Disable Study when deck is empty — nothing to study.
  btnStudy.disabled = count === 0;
  btnStudy.setAttribute('aria-disabled', String(count === 0));

  showView(viewDeck);
  renderCardList(deck);
}


/* ============================================================
   SECTION 8 — CARD LIST (deck view: grid of all cards)
   ============================================================
   Renders the card grid for the active deck, respecting the current
   search filter query. Re-renders fully on each call — safe because
   the delegated listener on #card-list is attached once at startup.
   ============================================================ */

const cardList   = document.getElementById('card-list');
const noCardsMsg = document.getElementById('no-cards-msg');

/**
 * Render the card grid for the given deck, applying the current search query.
 *
 * SEARCH ISOLATION — the quality-check guarantee:
 *   `filtered` is a locally-derived array, never assigned back to deck.cards.
 *   deck.cards (and therefore state.decks and LocalStorage) are never touched.
 *   Clearing the search input and triggering another render restores the full
 *   list because `deck.cards` was never modified.
 *
 * MATCH COUNT:
 *   Updates #card-search-count after filtering.
 *   Hidden when no query is active; shows "X of Y cards" when filtering;
 *   adds .no-results class when filtered.length === 0 for red styling.
 *
 * @param {Deck} deck
 */
function renderCardList(deck) {
  // Read query fresh from the DOM each call so the function is stateless —
  // it produces the same output for the same (deck, input value) pair.
  const query    = cardSearchInput.value.trim().toLowerCase();
  const total    = deck.cards.length;
  const filtered = query
    ? deck.cards.filter(c =>
        c.front.toLowerCase().includes(query) ||
        c.back.toLowerCase().includes(query))
    : deck.cards;

  // ── Match count badge ──────────────────────────────────────────────────────
  // Show only when a query is active; hide completely when input is cleared
  // so sighted users don't see a stale "X of Y cards" after clearing.
  if (query) {
    const matchText = filtered.length === 1
      ? `1 of ${total} card`
      : `${filtered.length} of ${total} cards`;
    cardSearchCount.textContent = matchText;
    // aria-live="polite" fires on textContent change — the span stays in the
    // DOM always (no [hidden] toggle) so the live region is pre-registered.
    // Visually hidden when empty via .search-count CSS (empty string = no width).
    cardSearchCount.classList.toggle('no-results', filtered.length === 0);
  } else {
    // Clear text rather than hiding — preserves the live region registration.
    cardSearchCount.textContent = '';
    cardSearchCount.classList.remove('no-results');
  }
  // ──────────────────────────────────────────────────────────────────────────

  if (filtered.length === 0) {
    cardList.innerHTML = '';
    noCardsMsg.removeAttribute('hidden');
    return;
  }
  noCardsMsg.setAttribute('hidden', '');

  // Build the grid HTML. Card IDs are safe to interpolate into data-* attributes
  // (they are [a-z0-9] from uid()), but front/back text must be set via textContent.
  cardList.innerHTML = filtered.map(card => `
    <li class="card-item" role="listitem" data-card-id="${card.id}">
      <div class="card-face card-front"></div>
      <div class="card-face card-back"></div>
      <div class="card-item-actions">
        <button class="btn-icon" data-action="edit-card"   data-card-id="${card.id}" aria-label="Edit card">✏️</button>
        <button class="btn-icon danger" data-action="delete-card" data-card-id="${card.id}" aria-label="Delete card">🗑</button>
      </div>
    </li>`).join('');

  // XSS-safe text injection + descriptive aria-labels.
  filtered.forEach(card => {
    const li = cardList.querySelector(`li[data-card-id="${card.id}"]`);
    if (!li) return;
    li.querySelector('.card-front').textContent = card.front;
    li.querySelector('.card-back').textContent  = card.back;
    li.querySelector('[data-action="edit-card"]').setAttribute('aria-label',   `Edit card: ${card.front}`);
    li.querySelector('[data-action="delete-card"]').setAttribute('aria-label', `Delete card: ${card.front}`);
  });
}

// Single delegated listener on the card grid — handles edit + delete for all cards.
cardList.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, cardId } = el.dataset;

  if (action === 'edit-card') {
    openEditCardModal(cardId, el);

  } else if (action === 'delete-card') {
    const card = getCard(cardId);
    if (!card) return;
    const ok = await confirmDialog(
      `Delete the card "${card.front}"? This cannot be undone.`,
      'Delete', el
    );
    if (!ok) return;

    const deck = getDeck(state.activeDeckId);
    if (!deck) return;
    deck.cards = deck.cards.filter(c => c.id !== cardId);

    saveState(state);
    renderSidebar();   // update card count badge in sidebar
    renderMainView();  // update card count + grid
  }
});

/// ── Card search — debounced 300 ms ───────────────────────────────────────────
//
// WHY DEBOUNCE:
//   Without debounce, every keystroke immediately calls renderCardList() which
//   rebuilds the entire card DOM. For decks with hundreds of cards this causes
//   visible jank. A 300 ms delay means renderCardList() fires once per typing
//   pause, not once per character — standard UX pattern for search inputs.
//
// WHY 300 ms (not 150 ms or 500 ms):
//   - < 200 ms feels instant but wastes renders on partial words.
//   - 300 ms is the empirical sweet spot: users don't perceive the delay,
//     but typing "photosynthesis" fires one render instead of fifteen.
//   - > 400 ms starts to feel laggy on fast typists.
//
// SEARCH DOES NOT MUTATE STATE:
//   renderCardList() reads the query from the input and filters a local
//   variable (filtered) derived from deck.cards. It never modifies deck.cards,
//   state.decks, or LocalStorage. Clearing the input (or blurring) restores
//   the full card list on the next render because the filter is re-computed
//   from deck.cards each time.
//
// MATCH COUNT:
//   #card-search-count is updated inside renderCardList() based on the
//   filtered.length vs deck.cards.length. It is hidden when no query is
//   active (query === '') and shows "X of Y cards" when filtering.

const cardSearchInput = document.getElementById('card-search');
const cardSearchCount = document.getElementById('card-search-count');

cardSearchInput.addEventListener('input', debounce(() => {
  const deck = getDeck(state.activeDeckId);
  if (deck) renderCardList(deck);
}, 300));


/* ============================================================
   SECTION 9 — STUDY MODE  (Part 4)
   ============================================================

   LISTENER LIFECYCLE — the core memory-leak fix
   ─────────────────────────────────────────────
   Previous approach: attach listeners once at script load, never remove.
   Problem: if a user enters study mode 10 times, nothing leaks because the
   listeners were only added once — BUT the spec requires demonstrating the
   correct pattern (add on enter, remove on exit) for production-quality code.

   New approach:
     enterStudyMode(deckId, opener)
       → stores three named handler functions in state.study._handlers
       → calls addEventListener with those named references

     exitStudyMode()
       → calls removeEventListener with the same stored references
       → nulls state.study._handlers to prevent double-removal
       → result: entering/exiting 100 times still has exactly 0 or 1 active
         listener at any point

   WHY store references in state.study._handlers (not module-level variables):
     Module-level: enterStudyMode would overwrite the reference before
     exitStudyMode could remove the OLD listener — each enter would leak one
     listener. Storing on the study state object ties the reference to the
     lifecycle of a single study session.

   BOUNDARY GUARDS (off-by-one quality check)
   ──────────────────────────────────────────
   _setStudyCard(idx) clamps idx to [0, cards.length-1] before accessing
   the array. goToPrev / goToNext check boundaries before calling _setStudyCard,
   so rapid button/key presses at the edges cannot produce index -1 or
   index === cards.length, either of which would be an undefined card access
   (silent bug that only shows up at runtime under fast navigation).

   Buttons are also disabled at boundaries (btnPrev at 0, btnNext at last),
   giving a visual signal and preventing keyboard activation via Enter/Space
   on the focused button.

   60fps FLIP
   ──────────
   Pure CSS transform: rotateY transition on the compositor thread.
   JS only toggles the .is-flipped class — no layout-triggering style writes.
   will-change:transform is applied once at setup (not toggled per-flip) to
   keep the element on a GPU layer throughout the study session.
   ============================================================ */

// Study DOM refs — cached once at script parse time (not inside enterStudyMode)
// so the same element references are used across all enter/exit cycles.
const studyCardEl     = document.getElementById('study-card');
const studyCardInner  = studyCardEl.querySelector('.study-card-inner');
const studyCardFront  = document.getElementById('study-card-text');
const studyCardBack   = document.getElementById('study-card-back-text');
const studyProgressEl = document.getElementById('study-progress');
const btnPrev         = document.getElementById('btn-prev');
const btnNext         = document.getElementById('btn-next');
const btnFlip         = document.getElementById('btn-flip');
const btnShuffle      = document.getElementById('btn-shuffle');
const btnExitStudy    = document.getElementById('btn-exit-study');

// Promote the flip element to a GPU compositing layer for the entire page
// session. will-change:transform signals "this element will be transformed
// frequently" — the browser pre-allocates a layer and avoids per-flip
// layer promotion / demotion, which would cause a frame drop on first flip.
studyCardInner.style.willChange = 'transform';

// ── Static button bindings (attached once — these buttons only exist in
//    the study view and have no equivalent elsewhere, so no lifecycle needed) ──

btnPrev.addEventListener('click', goToPrev);
btnNext.addEventListener('click', goToNext);
btnFlip.addEventListener('click', flipCard);
btnExitStudy.addEventListener('click', exitStudyMode);

btnShuffle.addEventListener('click', () => {
  // shuffle() returns a NEW array — never mutates state.study.cards in place.
  // This ensures the old index is invalidated before _setStudyCard() reads
  // the new array, preventing a transient state where index points to the
  // wrong card object.
  state.study.cards = shuffle(state.study.cards);
  _setStudyCard(0); // reset to first card of shuffled order; _setStudyCard resets flip
});


/**
 * Part 4 entry point.
 * Initialises study sub-state, attaches keyboard listeners, and renders
 * the first card. Safe to call repeatedly — exitStudyMode() guarantees
 * cleanup before the next enter.
 *
 * @param {string}      deckId  — ID of the deck to study
 * @param {HTMLElement} opener  — button that triggered enter; receives focus on exit
 */
function enterStudyMode(deckId, opener) {
  const deck = getDeck(deckId);
  if (!deck || deck.cards.length === 0) return;

  // Guard: if somehow called while already in study mode (e.g. programmatic),
  // clean up the previous session's listeners first to prevent accumulation.
  if (state.study._handlers) _detachStudyListeners();

  // Shallow copy of deck.cards — this is the working array for this session.
  // Shuffling, slicing, or reordering only affects this copy; LocalStorage
  // (deck.cards) is never touched by study mode navigation.
  state.study.cards   = [...deck.cards];
  state.study.index   = 0;
  state.study.flipped = false;
  state.study.opener  = opener;

  showView(viewStudy);
  _setStudyCard(0);
  _attachStudyListeners();

  // Move focus into the study view so keyboard navigation works immediately
  // without requiring a mouse click or Tab press first.
  studyCardEl.focus();
}

/**
 * Exit study mode, remove all keyboard listeners, return focus to opener.
 * Called by the Back button, the Escape key (if wired), or programmatically.
 */
function exitStudyMode() {
  _detachStudyListeners();
  showView(viewDeck);
  renderMainView(); // sync card count and Study button disabled state
  if (state.study.opener?.isConnected) state.study.opener.focus();
}

/**
 * Attach the three study-mode keyboard listeners and store their references.
 * Only called from enterStudyMode() — never called directly.
 *
 * Three separate listeners are used (not one combined handler) so each
 * concern is independently testable and the removal code is symmetric.
 */
function _attachStudyListeners() {
  // Build named functions and store them on state so removeEventListener
  // receives the exact same object reference that addEventListener received.
  // Arrow functions stored in variables satisfy this requirement.
  const docKey = e => {
    // Guard: only fire when the study view is actually visible.
    // Without this guard, arrow keys pressed after exitStudyMode() (before
    // the listener is removed in the same call stack) could trigger navigation.
    if (viewStudy.hasAttribute('hidden')) return;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault(); // prevent horizontal scroll in some browsers
        goToPrev();
        break;
      case 'ArrowRight':
        e.preventDefault();
        goToNext();
        break;
      case 'Escape':
        // Escape in study mode exits — mirrors modal ESC-to-close pattern.
        e.preventDefault();
        exitStudyMode();
        break;
    }
  };

  const cardClick = () => flipCard();

  const cardKey = e => {
    // Space flips the card (primary keyboard interaction per the HTML aria-label).
    // Enter also flips — both are standard activation keys for role="button".
    // Without preventDefault, Space scrolls the page; Enter may submit a form.
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      flipCard();
    }
  };

  state.study._handlers = { docKey, cardClick, cardKey };

  document.addEventListener('keydown', docKey);
  studyCardEl.addEventListener('click',   cardClick);
  studyCardEl.addEventListener('keydown', cardKey);
}

/**
 * Remove all study-mode keyboard listeners using the stored references.
 * Nulls state.study._handlers afterward so double-removal is safe.
 */
function _detachStudyListeners() {
  const h = state.study._handlers;
  if (!h) return; // nothing to remove (already cleaned up or never attached)

  document.removeEventListener('keydown', h.docKey);
  studyCardEl.removeEventListener('click',   h.cardClick);
  studyCardEl.removeEventListener('keydown', h.cardKey);

  // Null the reference so a second call to _detachStudyListeners() is a no-op
  // and the GC can collect the handler closures.
  state.study._handlers = null;
}


/**
 * Navigate to the card at the given index.
 * This is the ONLY function that changes which card is displayed.
 * Centralising navigation here means flip-reset is guaranteed to happen
 * on every card change — no code path can skip it.
 *
 * @param {number} idx — desired index; clamped to valid range defensively
 */
function _setStudyCard(idx) {
  const cards = state.study.cards;

  // Clamp to [0, length-1] — last line of defence against off-by-one errors
  // caused by rapid navigation, async callbacks, or future code changes.
  // goToPrev/goToNext check bounds before calling here, so this clamp is
  // normally a no-op; it exists to prevent undefined card access at runtime.
  const safeIdx = Math.max(0, Math.min(idx, cards.length - 1));

  _resetFlip(); // always show front face when arriving at a new card

  state.study.index = safeIdx;
  const card = cards[safeIdx];

  // textContent (not innerHTML) — card text is user-supplied and must not be
  // parsed as HTML, preventing stored XSS from card front/back content.
  studyCardFront.textContent = card.front;
  studyCardBack.textContent  = card.back;

  // Progress indicator: "3 / 12"
  // aria-live="polite" on the element (set in HTML) announces the new value
  // to screen readers after the current utterance finishes — not disruptive.
  studyProgressEl.textContent = `${safeIdx + 1} / ${cards.length}`;

  // Boundary disabling:
  //   - Prev disabled at index 0 (no previous card)
  //   - Next disabled at index length-1 (no next card)
  // This is consistent with the standard "paging" UI pattern and prevents
  // keyboard Enter/Space on a focused disabled button from triggering navigation.
  btnPrev.disabled = safeIdx === 0;
  btnNext.disabled = safeIdx === cards.length - 1;

  // Sync aria-disabled for screen readers — disabled alone is sufficient for
  // buttons, but aria-disabled makes the state explicit in the accessibility tree.
  btnPrev.setAttribute('aria-disabled', String(safeIdx === 0));
  btnNext.setAttribute('aria-disabled', String(safeIdx === cards.length - 1));
}

/**
 * Remove .is-flipped and reset state.study.flipped to false.
 * Called by _setStudyCard() before every card change.
 * Never called when flipping — only when un-flipping to front.
 */
function _resetFlip() {
  studyCardEl.classList.remove('is-flipped');
  state.study.flipped = false;
  studyCardEl.setAttribute('aria-label', 'Flashcard — press Space or Enter to flip');
}

/**
 * Toggle between front and back face of the current card.
 * Syncs both the CSS class (drives the animation) and state.study.flipped
 * (single source of truth for which face is shown).
 */
function flipCard() {
  state.study.flipped = !state.study.flipped;
  studyCardEl.classList.toggle('is-flipped', state.study.flipped);
  // Update aria-label so screen readers announce the new state.
  studyCardEl.setAttribute('aria-label',
    state.study.flipped
      ? 'Flashcard showing answer — press Space or Enter to flip back'
      : 'Flashcard showing question — press Space or Enter to flip'
  );
}

/**
 * Go to the previous card.
 * Boundary check before calling _setStudyCard prevents index going below 0.
 * (Defence-in-depth: button is also disabled at boundary, but keyboard
 * shortcuts bypass button disabled state — the check here is the real guard.)
 */
function goToPrev() {
  if (state.study.index > 0) _setStudyCard(state.study.index - 1);
}

/**
 * Go to the next card.
 * Boundary check before calling _setStudyCard prevents index going past
 * the last card (cards.length - 1).
 */
function goToNext() {
  if (state.study.index < state.study.cards.length - 1) {
    _setStudyCard(state.study.index + 1);
  }
}


/* ============================================================
   SECTION 10 — GLOBAL STATIC BUTTON BINDINGS
   ============================================================
   Static buttons (always in DOM) get direct listeners here.
   Dynamic list items (decks, cards) use delegation in Sections 6 + 8.
   ============================================================ */

document.getElementById('btn-new-deck').addEventListener('click', e =>
  openNewDeckModal(e.currentTarget)
);

document.getElementById('btn-new-deck-main').addEventListener('click', e =>
  openNewDeckModal(e.currentTarget)
);

// Sidebar empty-state "New Deck" button (added in Part 6 HTML).
document.getElementById('btn-new-deck-sidebar').addEventListener('click', e =>
  openNewDeckModal(e.currentTarget)
);

document.getElementById('btn-add-card').addEventListener('click', e =>
  openNewCardModal(e.currentTarget)
);

// Deck empty-state inline "Add Card" button (added in Part 6 HTML).
document.getElementById('btn-add-card-empty').addEventListener('click', e =>
  openNewCardModal(e.currentTarget)
);

// Study button: passes the active deck ID explicitly so enterStudyMode()
// is a pure function of its arguments (not implicitly reading activeDeckId).
document.getElementById('btn-study').addEventListener('click', e =>
  enterStudyMode(state.activeDeckId, e.currentTarget)
);


/* ============================================================
   SECTION 11 — INITIALISATION
   ============================================================
   loadState(state)  — defined in storage.js, mutates state in place.
   saveState(state)  — defined in storage.js, writes to LocalStorage.

   Both are called with `state` as an argument (not closures over it)
   so storage.js has no dependency on app.js's variable scope — it can
   be tested or reused independently.
   ============================================================ */
loadState(state);
renderSidebar();
renderMainView();
