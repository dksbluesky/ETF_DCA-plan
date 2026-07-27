(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ExecutionBridgeMonitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STORAGE_KEY = 'etfDca.executionBridge.v1';
  const CONTRACT_VERSION = '1.0';
  const MARKET_CLOSE_HOUR = 13;
  const MARKET_CLOSE_MINUTE = 30;
  const LIFECYCLE_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'COMPLETED', 'EXPIRED', 'INVALIDATED']);
  const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'EXPIRED', 'INVALIDATED']);

  let lastRender = null;
  let storageListenerBound = false;

  function storageGet() {
    try {
      return root.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch (error) {
      return null;
    }
  }

  function storageSet(value) {
    try {
      root.localStorage?.setItem(STORAGE_KEY, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function parseBridge(raw) {
    if (!raw) return null;
    try {
      const bridge = JSON.parse(raw);
      return bridge?.version === CONTRACT_VERSION && bridge.bridgeId && bridge.ticker ? bridge : null;
    } catch (error) {
      return null;
    }
  }

  function isoTime(value) {
    const time = value instanceof Date ? value.getTime() : Number(value);
    return new Date(Number.isFinite(time) ? time : Date.now()).toISOString();
  }

  function taipeiParts(value) {
    const date = value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute)
    };
  }

  function addCalendarDay(parts) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }

  function weekday(parts) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  }

  /**
   * Calculates bridge expiration at 13:30 Asia/Taipei on the applicable weekday.
   * Weekends are skipped; public-market holidays are intentionally not handled in Phase 3.
   * @param {string|number|Date} createdAt Bridge creation time.
   * @returns {string} Explicit expiration timestamp in ISO format.
   */
  function calculateExpiresAt(createdAt) {
    const created = new Date(createdAt);
    const safeCreated = Number.isFinite(created.getTime()) ? created : new Date();
    const time = taipeiParts(safeCreated);
    let day = { year: time.year, month: time.month, day: time.day };
    const isWeekend = [0, 6].includes(weekday(day));
    const afterClose = time.hour > MARKET_CLOSE_HOUR
      || (time.hour === MARKET_CLOSE_HOUR && time.minute >= MARKET_CLOSE_MINUTE);
    if (isWeekend || afterClose) day = addCalendarDay(day);
    while ([0, 6].includes(weekday(day))) day = addCalendarDay(day);
    return new Date(Date.UTC(day.year, day.month - 1, day.day, MARKET_CLOSE_HOUR - 8, MARKET_CLOSE_MINUTE)).toISOString();
  }

  function defaultNotificationState(existing) {
    return {
      lastNotifiedState: null,
      lastNotifiedAt: null,
      lastLifecycleNotifiedStatus: null,
      lastLifecycleNotifiedAt: null,
      dataUnavailableSince: null,
      lastDataUnavailableNotifiedAt: null,
      ...(existing || {})
    };
  }

  /**
   * Adds optional Phase 3 fields to a new or legacy bridge without changing setup context.
   * @param {object} bridge Existing Phase 1-compatible bridge.
   * @param {number|Date} [now] Injectable clock for tests.
   * @returns {object} Backward-compatible bridge with Phase 3 fields.
   */
  function initializeNewBridge(bridge, now = Date.now()) {
    const createdAt = bridge.createdAt || isoTime(now);
    const lifecycle = bridge.lifecycle && LIFECYCLE_STATUSES.includes(bridge.lifecycle.status)
      ? { ...bridge.lifecycle }
      : {
          status: 'ACTIVE',
          updatedAt: createdAt,
          expiresAt: calculateExpiresAt(createdAt),
          reason: null,
          completedAt: null
        };
    if (!lifecycle.expiresAt) lifecycle.expiresAt = calculateExpiresAt(createdAt);
    return {
      ...bridge,
      lifecycle,
      monitorResult: bridge.monitorResult || null,
      notificationState: defaultNotificationState(bridge.notificationState),
      extensions: { ...(bridge.extensions || {}) }
    };
  }

  function numericEqual(left, right) {
    if (left === null || left === undefined || left === '') {
      return right === null || right === undefined || right === '';
    }
    if (right === null || right === undefined || right === '') return false;
    const a = Number(left);
    const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-8;
  }

  /**
   * Compares only source-identity fields that define the ETF setup.
   * @param {object} bridge Stored bridge.
   * @param {object} context Current Entry Watch context.
   * @returns {string|null} Invalidation reason, or null when the setup still matches.
   */
  function sourceMismatchReason(bridge, context) {
    if (!context) return null;
    if (String(bridge.ticker || '').toUpperCase() !== String(context.ticker || '').toUpperCase()) {
      return 'Source ticker changed.';
    }
    if (String(bridge.zoneMode || '') !== String(context.zoneMode || '')) {
      return 'Active Zone mode changed.';
    }
    if (String(bridge.marketLevelTimeframe || '') !== String(context.marketLevelTimeframe || '')) {
      return 'Market Level timeframe changed.';
    }
    if (!numericEqual(bridge.activeZone?.low, context.activeZone?.low)
      || !numericEqual(bridge.activeZone?.high, context.activeZone?.high)) {
      return 'Active Zone changed.';
    }
    return null;
  }

  function lifecycleUpdate(bridge, status, now, reason = null) {
    const updatedAt = isoTime(now);
    return {
      ...bridge,
      lifecycle: {
        ...bridge.lifecycle,
        status,
        updatedAt,
        reason,
        completedAt: status === 'COMPLETED' ? updatedAt : bridge.lifecycle?.completedAt || null
      }
    };
  }

  function writeIfUnchanged(originalRaw, bridge) {
    if (storageGet() !== originalRaw) return false;
    return storageSet(JSON.stringify(bridge));
  }

  /**
   * Adds legacy lifecycle fields, expires old bridges, and invalidates changed ETF setups.
   * Only the bridge matching the supplied ticker is source-compared.
   * @param {object} context Current Entry Watch setup context.
   * @param {number|Date} [now] Injectable clock for tests.
   * @returns {object|null} Latest stored bridge after reconciliation.
   */
  function reconcileStoredBridge(context, now = Date.now()) {
    const raw = storageGet();
    const stored = parseBridge(raw);
    if (!stored) return null;
    let next = initializeNewBridge(stored, now);
    const time = now instanceof Date ? now.getTime() : Number(now);
    const status = next.lifecycle.status;
    if (['ACTIVE', 'PAUSED'].includes(status)
      && Number.isFinite(Date.parse(next.lifecycle.expiresAt))
      && (Number.isFinite(time) ? time : Date.now()) >= Date.parse(next.lifecycle.expiresAt)) {
      next = lifecycleUpdate(next, 'EXPIRED', now, 'Bridge reached its Taiwan trading-day expiration.');
    } else if (['ACTIVE', 'PAUSED'].includes(status)
      && String(next.ticker).toUpperCase() === String(context?.ticker || '').toUpperCase()) {
      const reason = sourceMismatchReason(next, context);
      if (reason) next = lifecycleUpdate(next, 'INVALIDATED', now, reason);
    }
    const changed = JSON.stringify(next) !== raw;
    if (changed && !writeIfUnchanged(raw, next)) return parseBridge(storageGet());
    return changed ? next : stored;
  }

  /**
   * Changes a bridge lifecycle through an allowed user transition.
   * @param {string} bridgeId Expected current bridge ID.
   * @param {'ACTIVE'|'PAUSED'|'COMPLETED'} targetStatus Requested status.
   * @param {string|null} [reason] Optional lifecycle reason.
   * @param {number|Date} [now] Injectable clock for tests.
   * @returns {object|null} Updated bridge, or null when rejected/stale.
   */
  function transitionStoredBridge(bridgeId, targetStatus, reason = null, now = Date.now()) {
    const raw = storageGet();
    const stored = parseBridge(raw);
    if (!stored || stored.bridgeId !== bridgeId) return null;
    const bridge = initializeNewBridge(stored, now);
    const current = bridge.lifecycle.status;
    const allowed = (current === 'ACTIVE' && ['PAUSED', 'COMPLETED'].includes(targetStatus))
      || (current === 'PAUSED' && ['ACTIVE', 'COMPLETED'].includes(targetStatus));
    if (!allowed) return null;
    const next = lifecycleUpdate(bridge, targetStatus, now, reason);
    return writeIfUnchanged(raw, next) ? next : null;
  }

  /**
   * Returns whether a bridge is in a final lifecycle state.
   * @param {object|null} bridge Bridge object.
   * @returns {boolean} True for completed, expired, or invalidated bridges.
   */
  function isTerminal(bridge) {
    return TERMINAL_STATUSES.includes(bridge?.lifecycle?.status);
  }

  /**
   * Returns whether replacing a one-active-bridge session requires confirmation.
   * @param {object|null} bridge Existing bridge.
   * @param {string} ticker Requested ticker.
   * @returns {boolean} True only for another ticker's active or paused bridge.
   */
  function requiresReplacementConfirmation(bridge, ticker) {
    return ['ACTIVE', 'PAUSED'].includes(bridge?.lifecycle?.status)
      && String(bridge.ticker || '').toUpperCase() !== String(ticker || '').toUpperCase();
  }

  function statusLabel(status) {
    return {
      ACTIVE: 'Active',
      PAUSED: 'Paused',
      COMPLETED: 'Completed',
      EXPIRED: 'Expired',
      INVALIDATED: 'Invalidated'
    }[status] || 'Not Started';
  }

  function formatTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return 'Unavailable';
    return new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  }

  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 4 }) : 'Unavailable';
  }

  function bindStorageListener() {
    if (storageListenerBound || typeof root.addEventListener !== 'function') return;
    storageListenerBound = true;
    root.addEventListener('storage', event => {
      if (event.key !== STORAGE_KEY || !lastRender) return;
      const { container, context, actions } = lastRender;
      if (container?.isConnected === false) return;
      renderPanel(container, context, actions);
    });
  }

  /**
   * Renders ETF_DCA-plan's informational monitor result and lifecycle controls.
   * It never feeds TAR-OBI results into Entry Watch calculations.
   * @param {HTMLElement} container Execution Bridge panel container.
   * @param {object} context Current Entry Watch setup context.
   * @param {object} actions Host actions for start/open/toast behavior.
   * @returns {void}
   */
  function renderPanel(container, context, actions = {}) {
    if (!container) return;
    lastRender = { container, context, actions };
    bindStorageListener();

    const stored = reconcileStoredBridge(context);
    const ticker = String(context?.ticker || '').trim().toUpperCase();
    const current = stored && String(stored.ticker).toUpperCase() === ticker ? stored : null;
    const status = current?.lifecycle?.status || null;
    const result = current?.monitorResult || null;
    const entryReady = result?.assessmentState === 'ENTRY_CONDITIONS_MET';
    const border = entryReady ? '#52c41a' : 'var(--border)';
    const borderWidth = entryReady ? '2px' : '1px';
    const background = entryReady ? '#f6ffed' : 'var(--surface2)';
    const otherActive = stored && !current && ['ACTIVE', 'PAUSED'].includes(stored.lifecycle?.status);

    let buttons = '';
    if (!current) {
      buttons = '<button type="button" class="btn btn-outline btn-sm" data-bridge-action="start">Start TAR-OBI Monitor</button>';
    } else if (TERMINAL_STATUSES.includes(status)) {
      buttons = `
        <button type="button" class="btn btn-outline btn-sm" data-bridge-action="open">Open TAR-OBI Monitor</button>
        <button type="button" class="btn btn-primary btn-sm" data-bridge-action="start">Start New Monitor</button>`;
    } else {
      buttons = `
        <button type="button" class="btn btn-outline btn-sm" data-bridge-action="open">Open TAR-OBI Monitor</button>
        <button type="button" class="btn btn-outline btn-sm" data-bridge-action="${status === 'PAUSED' ? 'resume' : 'pause'}">${status === 'PAUSED' ? 'Resume' : 'Pause'}</button>
        <button type="button" class="btn btn-outline btn-sm" data-bridge-action="end">End Monitor</button>`;
    }

    container.innerHTML = `
      <div style="margin-top:12px;padding:10px 14px;background:${background};border:${borderWidth} solid ${border};border-radius:10px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:0.5px;margin-bottom:6px">${current ? 'TAR-OBI MONITOR' : 'EXECUTION BRIDGE'}</div>
        <div style="font-size:12px;margin-bottom:8px"><span style="color:var(--muted)">Status: </span><b data-bridge-field="status"></b></div>
        <div data-bridge-result style="${result ? '' : 'display:none'};font-size:12px;line-height:1.7;margin-bottom:8px">
          <div><span style="color:var(--muted)">${status === 'COMPLETED' ? 'Final Assessment' : 'Assessment'}: </span><b data-bridge-field="assessment"></b></div>
          <div><span style="color:var(--muted)">Current Price: </span><b data-bridge-field="price"></b></div>
          <div><span style="color:var(--muted)">Last Evaluated: </span><b data-bridge-field="evaluated"></b></div>
          <div data-bridge-completed style="${status === 'COMPLETED' ? '' : 'display:none'}"><span style="color:var(--muted)">Completed At: </span><b data-bridge-field="completed"></b></div>
        </div>
        <div data-bridge-reason style="${current?.lifecycle?.reason ? '' : 'display:none'};font-size:12px;color:#874d00;margin-bottom:8px"></div>
        <div data-bridge-other style="${otherActive ? '' : 'display:none'};font-size:12px;color:#874d00;margin-bottom:8px"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${buttons}</div>
        <div style="font-size:10px;color:var(--muted);line-height:1.5;margin-top:8px">TAR-OBI results are informational execution context only and do not change Entry Watch decisions.</div>
      </div>`;

    const setText = (field, value) => {
      const element = container.querySelector(`[data-bridge-field="${field}"]`);
      if (element) element.textContent = value;
    };
    setText('status', current ? statusLabel(status) : 'Not Started');
    setText('assessment', result?.assessmentState || 'Unavailable');
    setText('price', formatPrice(result?.currentPrice));
    setText('evaluated', formatTime(result?.evaluatedAt));
    setText('completed', formatTime(current?.lifecycle?.completedAt));
    const reasonElement = container.querySelector('[data-bridge-reason]');
    if (reasonElement) reasonElement.textContent = current?.lifecycle?.reason || '';
    const otherElement = container.querySelector('[data-bridge-other]');
    if (otherElement && otherActive) {
      otherElement.textContent = `${stored.ticker} currently has a ${statusLabel(stored.lifecycle.status).toLowerCase()} monitor. Starting ${ticker} will replace it.`;
    }

    container.querySelector('[data-bridge-action="start"]')?.addEventListener('click', () => {
      const latest = reconcileStoredBridge(context);
      if (requiresReplacementConfirmation(latest, ticker)) {
        const confirmed = typeof root.confirm === 'function'
          && root.confirm(`Replace the active ${latest.ticker} TAR-OBI monitor with ${ticker}?`);
        if (!confirmed) return;
      }
      try {
        actions.startBridge?.(context);
        renderPanel(container, context, actions);
        actions.openMonitor?.();
      } catch (error) {
        actions.toast?.(error.message, 'err');
      }
    });
    container.querySelector('[data-bridge-action="open"]')?.addEventListener('click', () => actions.openMonitor?.());
    container.querySelector('[data-bridge-action="pause"]')?.addEventListener('click', () => {
      transitionStoredBridge(current.bridgeId, 'PAUSED');
      renderPanel(container, context, actions);
    });
    container.querySelector('[data-bridge-action="resume"]')?.addEventListener('click', () => {
      transitionStoredBridge(current.bridgeId, 'ACTIVE');
      renderPanel(container, context, actions);
    });
    container.querySelector('[data-bridge-action="end"]')?.addEventListener('click', () => {
      transitionStoredBridge(current.bridgeId, 'COMPLETED');
      renderPanel(container, context, actions);
    });
  }

  return Object.freeze({
    STORAGE_KEY,
    CONTRACT_VERSION,
    MARKET_CLOSE_HOUR,
    MARKET_CLOSE_MINUTE,
    LIFECYCLE_STATUSES,
    TERMINAL_STATUSES,
    calculateExpiresAt,
    initializeNewBridge,
    sourceMismatchReason,
    reconcileStoredBridge,
    transitionStoredBridge,
    isTerminal,
    requiresReplacementConfirmation,
    renderPanel
  });
});
