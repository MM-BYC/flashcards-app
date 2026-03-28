/* ============================================================
   storage.js — Part 5: Persistence helpers
   ============================================================
   Responsibilities:
     - Define LocalStorage key names in one place (no scattered strings).
     - Expose loadState(state) and saveState(state) with:
         • Schema versioning — detects stale/incompatible data.
         • Safe JSON.parse — malformed data never crashes the app.
         • Shape normalisation — guarantees state.decks is always a
           well-formed array regardless of what LocalStorage contains.
     - Remain framework-free: no imports, no build step.
       Loaded via <script src="storage.js"> before app.js.

   WHY a separate file (not inline in app.js):
     - Single-responsibility: app.js owns UI logic; storage.js owns I/O.
     - Independently testable: paste storage.js into a console and call
       loadState / saveState without any DOM present.
     - Easier to swap (e.g. switch from LocalStorage to IndexedDB later)
       without touching app.js.

   VERSIONING STRATEGY
   ───────────────────
   A lightweight version number (SCHEMA_VERSION) is stored alongside
   the deck data under a separate key (fc_schema_ver).

   On load:
     1. Read the stored version number.
     2. If absent  → first-ever load; accept data as-is (or empty).
     3. If current → normal load; normalise shapes.
     4. If older   → attempt migration (currently: v1→v2 is a no-op
                     because the schema hasn't changed; placeholder shown).
     5. If newer   → data was written by a future version of the app;
                     load what we can, log a warning, don't overwrite.

   This prevents the most common LocalStorage bug: silently loading
   data that was written by a different schema version, producing
   undefined field accesses or corrupt state.

   OVERWRITE-SAFETY
   ────────────────
   saveState() writes keys individually (decks, activeDeck, schemaVer).
   It does NOT call localStorage.clear() — that would delete unrelated
   keys set by browser extensions or other apps on the same origin.
   Each key is written atomically (setItem is synchronous and the browser
   holds a write lock per origin), so a partial write is not possible
   within a single saveState() call.
   ============================================================ */

'use strict';

/* ─── Schema version ──────────────────────────────────────────────────────── */

/**
 * Increment this when the stored data shape changes in a breaking way.
 * Current shape (v1):
 *   decks: Array<{ id: string, name: string, cards: Array<{ id, front, back }> }>
 * @type {number}
 */
const SCHEMA_VERSION = 1;

/* ─── Key registry ────────────────────────────────────────────────────────── */

/**
 * All LocalStorage key strings in one place.
 * Defined here so app.js never has a raw string like 'fc_decks' —
 * a typo in a key name produces a silent miss, not an error.
 * @readonly
 */
const LS_KEYS = {
  decks:      'fc_decks',
  activeDeck: 'fc_active_deck',
  schemaVer:  'fc_schema_ver',
};

/* ─── Shape helpers ───────────────────────────────────────────────────────── */

/**
 * Normalise a raw card object from LocalStorage into a guaranteed shape.
 * Generates a new uid() for any missing id so the card is always addressable.
 * Coerces front/back to strings so later .toLowerCase() calls never throw.
 *
 * @param {*} raw
 * @returns {{ id:string, front:string, back:string }}
 */
function _normaliseCard(raw) {
  return {
    id:    typeof raw?.id    === 'string' && raw.id    ? raw.id    : _uid(),
    front: typeof raw?.front === 'string'              ? raw.front : String(raw?.front ?? ''),
    back:  typeof raw?.back  === 'string'              ? raw.back  : String(raw?.back  ?? ''),
  };
}

/**
 * Normalise a raw deck object from LocalStorage into a guaranteed shape.
 * @param {*} raw
 * @returns {{ id:string, name:string, cards:Array }}
 */
function _normaliseDeck(raw) {
  return {
    id:    typeof raw?.id   === 'string' && raw.id   ? raw.id   : _uid(),
    name:  typeof raw?.name === 'string' && raw.name ? raw.name : 'Untitled',
    cards: Array.isArray(raw?.cards) ? raw.cards.map(_normaliseCard) : [],
  };
}

/**
 * Collision-resistant UID.
 * Duplicated from app.js so storage.js has no dependency on app.js —
 * either file can be loaded in isolation.
 * @returns {string}
 */
function _uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ─── Migration table ─────────────────────────────────────────────────────── */

/**
 * Migration functions keyed by the version they upgrade FROM.
 * Each receives the raw parsed decks array and returns the migrated array.
 * Add an entry here whenever SCHEMA_VERSION is incremented.
 *
 * Example (future):
 *   2: decks => decks.map(d => ({ ...d, color: d.color ?? '#ffffff' }))
 *
 * @type {Record<number, (decks: any[]) => any[]>}
 */
const MIGRATIONS = {
  // v1 → v2 placeholder (no schema change yet — identity migration)
  // 1: decks => decks,
};

/**
 * Run any pending migrations on a raw decks array.
 * Walks from storedVersion up to SCHEMA_VERSION - 1 applying each step.
 * @param {any[]} decks
 * @param {number} storedVersion
 * @returns {any[]}
 */
function _migrate(decks, storedVersion) {
  let result = decks;
  for (let v = storedVersion; v < SCHEMA_VERSION; v++) {
    if (typeof MIGRATIONS[v] === 'function') {
      result = MIGRATIONS[v](result);
      console.info(`[Storage] Migrated schema v${v} → v${v + 1}`);
    }
  }
  return result;
}

/* ─── Public API ──────────────────────────────────────────────────────────── */

/**
 * Load persisted data from LocalStorage into the provided state object.
 * Mutates state.decks and state.activeDeckId in place.
 *
 * Safe to call even if:
 *   - LocalStorage is empty (first visit)         → state unchanged (stays empty)
 *   - LocalStorage contains malformed JSON         → caught, state unchanged
 *   - Stored schema version is older than current → migration applied
 *   - Stored schema version is newer than current → best-effort load, no overwrite
 *
 * @param {{ decks: any[], activeDeckId: string|null }} state — mutated in place
 */
function loadState(state) {
  try {
    // ── 1. Check schema version ─────────────────────────────────────────────
    const rawVer = localStorage.getItem(LS_KEYS.schemaVer);
    const storedVersion = rawVer !== null ? parseInt(rawVer, 10) : null;

    if (storedVersion !== null && storedVersion > SCHEMA_VERSION) {
      // Data was written by a newer app version. Load what we can but DO NOT
      // overwrite — the user might return to the newer version later.
      console.warn(
        `[Storage] Stored schema v${storedVersion} > app schema v${SCHEMA_VERSION}. ` +
        'Loading read-only; save disabled to prevent data loss.'
      );
      // Fall through — normalisation below will recover what it can.
    }

    // ── 2. Parse and migrate decks ──────────────────────────────────────────
    const rawDecks = localStorage.getItem(LS_KEYS.decks);
    if (rawDecks !== null) {
      // JSON.parse can throw on malformed input (e.g. truncated write, manual edit).
      let parsed;
      try {
        parsed = JSON.parse(rawDecks);
      } catch (parseErr) {
        console.warn('[Storage] Corrupted decks JSON — starting fresh.', parseErr);
        // Don't crash; leave state.decks as-is (empty array from app.js init).
        return;
      }

      if (!Array.isArray(parsed)) {
        // Stored value isn't an array — might be a leftover string from a
        // previous app iteration. Discard and start fresh rather than crash.
        console.warn('[Storage] Unexpected decks type (not array) — starting fresh.');
        return;
      }

      // Apply migrations if stored version is older.
      const effectiveVersion = storedVersion ?? 1; // treat missing version as v1
      const migrated = _migrate(parsed, effectiveVersion);

      // Normalise every deck and card to guarantee the expected shape.
      state.decks = migrated.map(_normaliseDeck);
    }

    // ── 3. Restore active deck ──────────────────────────────────────────────
    const savedActive = localStorage.getItem(LS_KEYS.activeDeck);
    if (savedActive && state.decks.some(d => d.id === savedActive)) {
      // Only restore if the deck still exists — it may have been deleted in
      // another tab, or migration may have assigned it a new ID.
      state.activeDeckId = savedActive;
    }
    // If savedActive no longer matches any deck, activeDeckId stays null
    // and the UI shows the empty state — correct behaviour.

  } catch (err) {
    // Outer catch: handles unexpected errors (e.g. SecurityError if
    // LocalStorage is blocked in a sandboxed iframe).
    console.warn('[Storage] loadState failed — starting fresh.', err);
  }
}

/**
 * Persist the current state to LocalStorage.
 * Writes three keys: decks array, active deck ID, schema version.
 * Never calls localStorage.clear() — only touches fc_* keys.
 *
 * Called after every state mutation (create/update/delete deck or card).
 *
 * @param {{ decks: any[], activeDeckId: string|null }} state
 */
function saveState(state) {
  try {
    // Serialise decks. JSON.stringify can throw if the data contains
    // circular references or non-serialisable values (shouldn't happen
    // with plain objects, but guard defensively).
    const serialised = JSON.stringify(state.decks);
    localStorage.setItem(LS_KEYS.decks, serialised);

    // Active deck: write if set, remove key if null (clean housekeeping —
    // leaving a stale key pointing to a deleted deck would cause a silent
    // "deck not found" on next load, which loadState already handles, but
    // removing it is cleaner).
    if (state.activeDeckId) {
      localStorage.setItem(LS_KEYS.activeDeck, state.activeDeckId);
    } else {
      localStorage.removeItem(LS_KEYS.activeDeck);
    }

    // Always write the current schema version so future migrations can
    // compare against it. Written last — if the decks write above threw,
    // the version key won't be updated, which means next load will retry
    // migration rather than silently use stale data.
    localStorage.setItem(LS_KEYS.schemaVer, String(SCHEMA_VERSION));

  } catch (err) {
    // Common cause: storage quota exceeded (user has many large decks).
    // Log clearly — silent failure here would mean the user loses data
    // on next reload without any warning.
    console.error('[Storage] saveState failed — data not persisted!', err);
  }
}
