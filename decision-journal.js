(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EtfDcaDecisionJournal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STORAGE_KEY = 'etfDca.decisionJournal.v1';
  const VERSION = 1;
  const MAX_ENTRIES = 1000;

  function storageGet(key) {
    try { return root.localStorage?.getItem(key) ?? null; } catch (error) { return null; }
  }

  function storageSet(key, value) {
    try { root.localStorage?.setItem(key, value); return true; } catch (error) { return false; }
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizedTicker(value) {
    return String(value || '').trim().toUpperCase();
  }

  function readStore() {
    try {
      const parsed = JSON.parse(storageGet(STORAGE_KEY) || 'null');
      return parsed?.version === VERSION && Array.isArray(parsed.entries)
        ? parsed
        : { version: VERSION, entries: [] };
    } catch (error) {
      return { version: VERSION, entries: [] };
    }
  }

  function writeStore(store) {
    return storageSet(STORAGE_KEY, JSON.stringify({
      version: VERSION,
      entries: store.entries.slice(-MAX_ENTRIES)
    }));
  }

  function conditionValue(value) {
    if (!value || typeof value !== 'object') return null;
    return {
      met: value.met === true,
      provisional: value.provisional === true
    };
  }

  function c4Value(value) {
    if (!value || typeof value !== 'object') return null;
    return {
      classification: value.classification || null,
      decision: value.decision || null,
      confirmed: value.confirmed === true
    };
  }

  function zoneRange(value) {
    return {
      low: finiteNumber(value?.low),
      high: finiteNumber(value?.high)
    };
  }

  function manualDraftValue(value) {
    return {
      low: finiteNumber(value?.low),
      high: finiteNumber(value?.high),
      edited: typeof value?.edited === 'boolean' ? value.edited : null
    };
  }

  function activeManualZoneValue(value) {
    return {
      low: finiteNumber(value?.low),
      high: finiteNumber(value?.high),
      source: value?.source || null,
      manualAppliedAt: typeof value?.manualAppliedAt === 'string' ? value.manualAppliedAt : null
    };
  }

  function manualReassessmentValue(value) {
    return {
      completedDailyDate: value?.completedDailyDate || null,
      completedClose: finiteNumber(value?.completedClose),
      suggestedZoneLow: finiteNumber(value?.suggestedZoneLow),
      suggestedZoneHigh: finiteNumber(value?.suggestedZoneHigh),
      result: value?.result || null,
      counter: finiteNumber(value?.counter),
      threshold: finiteNumber(value?.threshold),
      ready: typeof value?.ready === 'boolean' ? value.ready : null,
      resetState: value?.resetState || null,
      resetAt: typeof value?.resetAt === 'string' ? value.resetAt : null
    };
  }

  /**
   * Calculates read-only opening-gap context. This function does not produce an entry signal.
   * @param {object} input Quote, zone and optional ATR values.
   * @returns {object|null} Normalized gap context, or null when quote inputs are unavailable.
   */
  function calculateGapContext(input) {
    const open = finiteNumber(input?.open);
    const previousClose = finiteNumber(input?.previousClose);
    if (!(open > 0) || !(previousClose > 0)) return null;

    const difference = open - previousClose;
    const percent = difference / previousClose * 100;
    const zoneLow = finiteNumber(input?.activeZone?.low);
    const zoneHigh = finiteNumber(input?.activeZone?.high);
    const atr = finiteNumber(input?.atr);
    let zoneRelation = 'ACTIVE_ZONE_UNAVAILABLE';
    if (zoneLow !== null && zoneHigh !== null) {
      zoneRelation = open < zoneLow
        ? 'BELOW_ACTIVE_ZONE'
        : open > zoneHigh
          ? 'ABOVE_ACTIVE_ZONE'
          : 'INSIDE_ACTIVE_ZONE';
    }

    return {
      direction: percent > 0 ? 'GAP_UP' : percent < 0 ? 'GAP_DOWN' : 'FLAT_OPEN',
      open,
      previousClose,
      difference,
      percent,
      atrMultiple: atr > 0 ? Math.abs(difference) / atr : null,
      zoneRelation
    };
  }

  function signature(snapshot) {
    return JSON.stringify({
      activeZone: snapshot.activeZone || null,
      zoneMode: snapshot.zoneMode || null,
      systemSuggestedZone: snapshot.systemSuggestedZone || null,
      manualDraft: snapshot.manualDraft || null,
      activeManualZone: snapshot.activeManualZone || null,
      manualReassessment: snapshot.manualReassessment || null,
      h1H2Status: snapshot.h1H2Status?.type || null,
      C1: conditionValue(snapshot.C1),
      C2: conditionValue(snapshot.C2),
      C3: conditionValue(snapshot.C3),
      C4: c4Value(snapshot.C4),
      setupStatus: snapshot.setupStatus?.label || snapshot.setupStatus || null,
      marketSessionState: snapshot.marketSessionState || null,
      quoteDate: snapshot.quoteDate || null,
      gapDirection: snapshot.gapContext?.direction || null,
      gapZoneRelation: snapshot.gapContext?.zoneRelation || null,
      marketContext: snapshot.extensions?.marketContextV1?.context || null,
      zoneType: snapshot.extensions?.marketContextV1?.zoneType || null
    });
  }

  function eventTypes(previous, snapshot) {
    if (!previous) {
      return snapshot.gapContext
        ? ['INITIAL_SNAPSHOT', 'OPENING_GAP']
        : ['INITIAL_SNAPSHOT'];
    }

    const events = [];
    if (JSON.stringify(previous.activeZone) !== JSON.stringify(snapshot.activeZone)
      || previous.zoneMode !== snapshot.zoneMode) events.push('ACTIVE_ZONE_CHANGED');
    if (JSON.stringify(previous.systemSuggestedZone) !== JSON.stringify(snapshot.systemSuggestedZone)) events.push('SYSTEM_SUGGESTED_ZONE_CHANGED');
    if (JSON.stringify(previous.manualDraft) !== JSON.stringify(snapshot.manualDraft)) events.push('MANUAL_DRAFT_CHANGED');
    if (JSON.stringify(previous.activeManualZone) !== JSON.stringify(snapshot.activeManualZone)) events.push('ACTIVE_MANUAL_ZONE_CHANGED');
    if (JSON.stringify(previous.manualReassessment) !== JSON.stringify(snapshot.manualReassessment)) events.push('MANUAL_REASSESSMENT_CHANGED');
    if ((previous.h1H2Status?.type || null) !== (snapshot.h1H2Status?.type || null)) events.push('H_SIGNAL_CHANGED');
    if (JSON.stringify([previous.C1, previous.C2, previous.C3, previous.C4])
      !== JSON.stringify([snapshot.C1, snapshot.C2, snapshot.C3, snapshot.C4])) events.push('CONDITIONS_CHANGED');
    if ((previous.setupStatus?.label || previous.setupStatus || null)
      !== (snapshot.setupStatus?.label || snapshot.setupStatus || null)) events.push('SETUP_STATUS_CHANGED');
    if (previous.quoteDate !== snapshot.quoteDate && snapshot.gapContext) events.push('OPENING_GAP');
    if (previous.marketSessionState !== 'CLOSED' && snapshot.marketSessionState === 'CLOSED') events.push('OFFICIAL_CLOSE');
    return events;
  }

  /**
   * Records a setup snapshot only when a meaningful setup event changed.
   * @param {object} input Current read-only Entry Watch context.
   * @returns {object|null} New journal entry, or null when deduplicated/invalid.
   */
  function recordSetupSnapshot(input) {
    const ticker = normalizedTicker(input?.ticker);
    if (!ticker) return null;
    const store = readStore();
    const previous = [...store.entries].reverse().find(entry =>
      entry.ticker === ticker
      && Object.prototype.hasOwnProperty.call(entry, 'marketSessionState')
    ) || null;
    const gapContext = input.gapContext || calculateGapContext(input);
    const snapshot = {
      ticker,
      recordedAt: new Date().toISOString(),
      evaluatedAt: input.evaluatedAt || new Date().toISOString(),
      quoteDate: input.quoteDate || null,
      currentPrice: finiteNumber(input.currentPrice),
      open: finiteNumber(input.open),
      high: finiteNumber(input.high),
      low: finiteNumber(input.low),
      previousClose: finiteNumber(input.previousClose),
      ema5: finiteNumber(input.ema5),
      atr: finiteNumber(input.atr),
      marketSessionState: input.marketSessionState || null,
      zoneMode: input.zoneMode || null,
      activeZone: input.activeZone || null,
      systemSuggestedZone: {
        aggressive: zoneRange(input.systemSuggestedZone?.aggressive),
        conservative: zoneRange(input.systemSuggestedZone?.conservative)
      },
      manualDraft: manualDraftValue(input.manualDraft),
      activeManualZone: activeManualZoneValue(input.activeManualZone),
      manualReassessment: manualReassessmentValue(input.manualReassessment),
      invalidationLevel: finiteNumber(input.invalidationLevel),
      h1H2Status: input.h1H2Status || null,
      C1: conditionValue(input.C1),
      C2: conditionValue(input.C2),
      C3: conditionValue(input.C3),
      C4: c4Value(input.C4),
      setupStatus: input.setupStatus || null,
      extensions: input.extensions?.marketContextV1 ? { marketContextV1: input.extensions.marketContextV1 } : {},
      gapContext
    };
    const events = eventTypes(previous, snapshot);
    if (!events.length || (previous && signature(previous) === signature(snapshot))) return null;
    const entry = { ...snapshot, events };
    store.entries.push(entry);
    return writeStore(store) ? entry : null;
  }

  /**
   * Records the user-initiated TAR-OBI bridge start without changing the bridge object.
   * @param {object} context Current setup context.
   * @param {object} bridge Persisted execution bridge.
   * @returns {object|null} New journal entry, or null on invalid input/storage failure.
   */
  function recordBridgeStart(context, bridge) {
    const ticker = normalizedTicker(bridge?.ticker || context?.ticker);
    if (!ticker) return null;
    const store = readStore();
    const entry = {
      ticker,
      recordedAt: new Date().toISOString(),
      evaluatedAt: bridge?.createdAt || new Date().toISOString(),
      events: ['BRIDGE_STARTED'],
      bridgeId: bridge?.bridgeId || null,
      activeZone: context?.activeZone || bridge?.activeZone || null,
      zoneMode: context?.zoneMode || bridge?.zoneMode || null,
      setupStatus: context?.setupStatus || bridge?.setupStatus || null,
      extensions: context?.extensions?.marketContextV1 ? { marketContextV1: context.extensions.marketContextV1 } : {}
    };
    store.entries.push(entry);
    return writeStore(store) ? entry : null;
  }

  /**
   * Returns newest journal entries, optionally filtered by ticker.
   * @param {object} [options] Query options.
   * @returns {object[]} Newest-first journal entries.
   */
  function listEntries(options = {}) {
    const ticker = normalizedTicker(options.ticker);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 10));
    return readStore().entries
      .filter(entry => !ticker || entry.ticker === ticker)
      .slice(-limit)
      .reverse();
  }

  function displayEvent(events) {
    const labels = {
      INITIAL_SNAPSHOT: 'Initial setup snapshot', OPENING_GAP: 'Opening gap captured',
      ACTIVE_ZONE_CHANGED: 'Active Zone changed', SYSTEM_SUGGESTED_ZONE_CHANGED: 'System Suggested Zone changed',
      MANUAL_DRAFT_CHANGED: 'Manual Draft changed', ACTIVE_MANUAL_ZONE_CHANGED: 'Active Manual Zone changed',
      MANUAL_REASSESSMENT_CHANGED: 'Manual reassessment changed', H_SIGNAL_CHANGED: 'H signal changed',
      CONDITIONS_CHANGED: 'C1–C4 changed', SETUP_STATUS_CHANGED: 'Setup status changed',
      OFFICIAL_CLOSE: 'Official close captured', BRIDGE_STARTED: 'TAR-OBI monitor started'
    };
    return (events || []).map(event => labels[event] || event).join(' · ');
  }

  function displayGap(gap) {
    if (!gap) return 'Unavailable';
    const relation = {
      ABOVE_ACTIVE_ZONE: 'opened above Active Zone',
      INSIDE_ACTIVE_ZONE: 'opened inside Active Zone',
      BELOW_ACTIVE_ZONE: 'opened below Active Zone',
      ACTIVE_ZONE_UNAVAILABLE: 'Active Zone unavailable'
    }[gap.zoneRelation];
    const sign = gap.percent > 0 ? '+' : '';
    const atr = Number.isFinite(gap.atrMultiple) ? ` · ${gap.atrMultiple.toFixed(2)} ATR` : '';
    return `${gap.direction.replaceAll('_', ' ')} ${sign}${gap.percent.toFixed(2)}% · ${relation}${atr}`;
  }

  /**
   * Renders a compact read-only Gap Context and automatic Decision Journal panel.
   * @param {HTMLElement} container Target container.
   * @param {object} snapshot Current setup snapshot.
   * @returns {void}
   */
  function renderPanel(container, snapshot) {
    if (!container || !root.document) return;
    const gap = snapshot?.gapContext || calculateGapContext(snapshot);
    const entries = listEntries({ ticker: snapshot?.ticker, limit: 5 });
    container.innerHTML = `
      <details style="margin-top:12px;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px">
        <summary style="cursor:pointer;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.5px">DECISION JOURNAL · GAP CONTEXT</summary>
        <div data-gap-context style="margin-top:8px;font-size:12px;font-weight:600"></div>
        <div style="margin-top:8px;font-size:10px;color:var(--muted)">Informational context only. It does not change Entry Watch decisions.</div>
        <div data-journal-entries style="margin-top:8px;display:grid;gap:5px"></div>
      </details>`;
    container.querySelector('[data-gap-context]').textContent = `Opening Gap: ${displayGap(gap)}`;
    const list = container.querySelector('[data-journal-entries]');
    if (!entries.length) {
      list.textContent = 'No automatic snapshots yet.';
      return;
    }
    entries.forEach(entry => {
      const row = root.document.createElement('div');
      row.style.cssText = 'font-size:11px;padding-top:5px;border-top:1px solid var(--border)';
      row.textContent = `${new Date(entry.evaluatedAt || entry.recordedAt).toLocaleString()} — ${displayEvent(entry.events)}`;
      list.appendChild(row);
    });
  }

  return Object.freeze({
    STORAGE_KEY,
    VERSION,
    calculateGapContext,
    recordSetupSnapshot,
    recordBridgeStart,
    listEntries,
    renderPanel
  });
});
