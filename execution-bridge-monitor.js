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
  const SOURCE_CONTEXT_SYNC_DELAY_MS = 350;
  const SOURCE_CONTEXT_FIELDS = Object.freeze([
    'marketTimeframe', 'marketLevelTimeframe', 'marketSessionState', 'zoneMode', 'activeZone',
    'preferredEntry', 'maximumEntryPrice', 'invalidationLevel', 'entryMode', 'starterEligible',
    'starterAllocationPct', 'starterExecuted', 'starterRisk', 'h1H2Status', 'C1', 'C2', 'C3', 'C4', 'setupStatus'
  ]);

  let lastRender = null;
  let storageListenerBound = false;
  let sourceContextSyncTimer = null;

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

    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate()
    };
  }

  function weekday(parts) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  }

  /**
   * Calculates bridge expiration at 13:30 Asia/Taipei on the applicable weekday.
   * Weekends are skipped; public-market holidays are intentionally not handled in Phase 3.
   *
   * @param {string|number|Date} createdAt Bridge creation time.
   * @returns {string} Explicit expiration timestamp in ISO format.
   */
  function calculateExpiresAt(createdAt) {
    const created = new Date(createdAt);
    const safeCreated = Number.isFinite(created.getTime()) ? created : new Date();
    const time = taipeiParts(safeCreated);

    let day = {
      year: time.year,
      month: time.month,
      day: time.day
    };

    const isWeekend = [0, 6].includes(weekday(day));

    const afterClose = time.hour > MARKET_CLOSE_HOUR
      || (
        time.hour === MARKET_CLOSE_HOUR
        && time.minute >= MARKET_CLOSE_MINUTE
      );

    if (isWeekend || afterClose) {
      day = addCalendarDay(day);
    }

    while ([0, 6].includes(weekday(day))) {
      day = addCalendarDay(day);
    }

    return new Date(Date.UTC(
      day.year,
      day.month - 1,
      day.day,
      MARKET_CLOSE_HOUR - 8,
      MARKET_CLOSE_MINUTE
    )).toISOString();
  }

  function defaultNotificationState(existing) {
    return {
      lastNotifiedState: null,
      lastNotifiedAt: null,
      lastLifecycleNotifiedStatus: null,
      lastLifecycleNotifiedAt: null,
      dataUnavailableSince: null,
      lastDataUnavailableNotifiedAt: null,
      leftStarterEligible: false,
      leftStarterNotifiedAt: null,
      ...(existing || {})
    };
  }

  function hasCurrentTarHardExecutionBlock(bridge) {
    const result = bridge?.monitorResult;
    if (result?.hardExecutionBlock !== true && result?.executionHardBlocked !== true) return false;
    const zoneMatches = numericEqual(result.activeZone?.low, bridge.activeZone?.low)
      && numericEqual(result.activeZone?.high, bridge.activeZone?.high);
    const invalidationMatches = numericEqual(result.invalidationLevel, bridge.invalidationLevel);
    return zoneMatches && invalidationMatches;
  }

  function reconcileLeftStarterNotification(bridge, now = Date.now()) {
    const notificationState = defaultNotificationState(bridge?.notificationState);
    const eligible = bridge?.entryMode === 'left_side_starter'
      && bridge?.starterEligible === true
      && bridge?.starterExecuted !== true;
    const transitioned = notificationState.leftStarterEligible !== true && eligible;
    const next = {
      ...bridge,
      notificationState: {
        ...notificationState,
        leftStarterEligible: eligible
      }
    };
    if (transitioned && !hasCurrentTarHardExecutionBlock(bridge)) {
      if (typeof root.Notification === 'function' && root.Notification.permission === 'granted') {
        new root.Notification('LEFT-SIDE STARTER — execution assessment available', {
          body: 'Small DCA starter only; this is not RIGHT confirmation or BUY NOW.'
        });
      }
      next.notificationState.leftStarterNotifiedAt = isoTime(now);
    }
    return next;
  }
  /**
   * Adds optional Phase 3 fields to a new or legacy bridge without changing setup context.
   *
   * @param {object} bridge Existing Phase 1-compatible bridge.
   * @param {number|Date} [now] Injectable clock for tests.
   * @returns {object} Backward-compatible bridge with Phase 3 fields.
   */
  function initializeNewBridge(bridge, now = Date.now()) {
    const createdAt = bridge.createdAt || isoTime(now);

    const lifecycle = bridge.lifecycle
      && LIFECYCLE_STATUSES.includes(bridge.lifecycle.status)
        ? { ...bridge.lifecycle }
        : {
            status: 'ACTIVE',
            updatedAt: createdAt,
            expiresAt: calculateExpiresAt(createdAt),
            reason: null,
            completedAt: null
          };

    if (!lifecycle.expiresAt) {
      lifecycle.expiresAt = calculateExpiresAt(createdAt);
    }

    return {
      ...bridge,
      lifecycle,
      monitorResult: bridge.monitorResult || null,
      notificationState: defaultNotificationState(bridge.notificationState),
      extensions: {
        ...(bridge.extensions || {})
      }
    };
  }

  function numericEqual(left, right) {
    if (
      left === null
      || left === undefined
      || left === ''
    ) {
      return right === null
        || right === undefined
        || right === '';
    }

    if (
      right === null
      || right === undefined
      || right === ''
    ) {
      return false;
    }

    const a = Number(left);
    const b = Number(right);

    return Number.isFinite(a)
      && Number.isFinite(b)
      && Math.abs(a - b) < 1e-8;
  }

  /**
   * Compares only source-identity fields that define the ETF setup.
   *
   * @param {object} bridge Stored bridge.
   * @param {object} context Current Entry Watch context.
   * @returns {string|null} Invalidation reason, or null when the setup still matches.
   */
  function sourceMismatchReason(bridge, context) {
    if (!context) return null;

    if (
      String(bridge.ticker || '').toUpperCase()
      !== String(context.ticker || '').toUpperCase()
    ) {
      return 'Source ticker changed.';
    }

    if (
      String(bridge.zoneMode || '')
      !== String(context.zoneMode || '')
    ) {
      return 'Active Zone mode changed.';
    }

    if (
      String(bridge.marketLevelTimeframe || '')
      !== String(context.marketLevelTimeframe || '')
    ) {
      return 'Market Level timeframe changed.';
    }

    if (
      !numericEqual(
        bridge.activeZone?.low,
        context.activeZone?.low
      )
      || !numericEqual(
        bridge.activeZone?.high,
        context.activeZone?.high
      )
    ) {
      return 'Active Zone changed.';
    }

    return null;
  }

  function sourceLongZoneInvalidationReason(context) {
    const marketContext = context?.extensions?.marketContextV1;
    // Legacy bridges without the context extension preserve their original behavior.
    if (!marketContext) return null;
    const manualOverride = ['manual_override', 'manual', 'manual_reassessment'].includes(context?.activeZoneSource || context?.zoneMode) && marketContext.manualOverride === true;
    if (!manualOverride && (marketContext.context !== 'bullish' || marketContext.automaticZoneEligible !== true)) {
      return 'No valid bullish Active Zone remains.';
    }
    const low = Number(context?.activeZone?.low);
    const high = Number(context?.activeZone?.high);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) {
      return 'The selected Active Zone is no longer valid.';
    }
    return null;
  }
  function validSourceContext(context) {
    const low = Number(context?.activeZone?.low);
    const high = Number(context?.activeZone?.high);

    return Boolean(String(context?.ticker || '').trim())
      && Number.isFinite(low)
      && Number.isFinite(high)
      && low > 0
      && high > 0
      && low <= high;
  }

  function sourceContextPatch(context) {
    return {
      marketTimeframe: context.marketTimeframe || '1d',
      marketLevelTimeframe: context.marketLevelTimeframe || null,
      marketSessionState: context.marketSessionState || null,
      zoneMode: context.zoneMode || null,

      activeZone: {
        low: Number(context.activeZone.low),
        high: Number(context.activeZone.high)
      },

      preferredEntry: context.preferredEntry ?? null,
      maximumEntryPrice: context.maximumEntryPrice ?? null,
      invalidationLevel: context.invalidationLevel ?? null,

      entryMode:
        context.entryMode === 'left_side_starter'
           ? 'left_side_starter'
           : context.entryMode === 'confirmed'
             ? 'confirmed'
             : 'pending',

      starterEligible:
        context.starterEligible === true,

      starterAllocationPct:
        context.starterAllocationPct ?? null,

      starterExecuted:
        context.starterExecuted === true,

      starterRisk:
        context.starterRisk
        && typeof context.starterRisk === 'object'
          ? JSON.parse(
              JSON.stringify(context.starterRisk)
            )
          : null,

      h1H2Status: context.h1H2Status || null,
      C1: context.C1 || null,
      C2: context.C2 || null,
      C3: context.C3 || null,
      C4: context.C4 || null,
      setupStatus: context.setupStatus || null
    };
  }

  function sourceContextChanged(bridge, patch) {
    return SOURCE_CONTEXT_FIELDS.some(
      field =>
        JSON.stringify(bridge[field] ?? null)
        !== JSON.stringify(patch[field] ?? null)
    );
  }

  function mergeSourceContext(bridge, context, now) {
    if (!validSourceContext(context)) {
      return bridge;
    }

    const patch = sourceContextPatch(context);

    if (!sourceContextChanged(bridge, patch)) {
      return bridge;
    }

    return {
      ...bridge,
      ...patch,

      extensions: {
        ...(bridge.extensions || {}),
        ...(context.extensions?.marketContextV1 ? { marketContextV1: context.extensions.marketContextV1 } : {}),
        sourceContextUpdatedAt: isoTime(now)
      }
    };
  }
  /**
   * Merges the latest valid ETF Entry Watch context
   * into the same active bridge.
   *
   * TAR-owned lifecycle, monitor result,
   * notification and confirmation fields are preserved.
   *
   * @param {object} context Current Entry Watch setup context.
   * @param {number|Date} [now] Injectable clock for tests.
   * @param {number} [remainingAttempts]
   * Compare-and-set retries after a concurrent TAR write.
   * @returns {object|null} Latest stored bridge.
   */
  function syncStoredBridgeContext(
    context,
    now = Date.now(),
    remainingAttempts = 1
  ) {
    const raw = storageGet();
    const stored = parseBridge(raw);

    if (!stored) return null;

    const current =
      initializeNewBridge(
        stored,
        now
      );

    if (
      ![
        'ACTIVE',
        'PAUSED'
      ].includes(
        current.lifecycle?.status
      )
    ) {
      return stored;
    }

    const invalidationReason = sourceLongZoneInvalidationReason(context);
    if (invalidationReason) {
      const expired = lifecycleUpdate(current, 'EXPIRED', now, invalidationReason);
      return writeIfUnchanged(raw, expired) ? expired : parseBridge(storageGet());
    }

    if (!validSourceContext(context)) return stored;

    if (
      String(
        current.ticker || ''
      ).toUpperCase()
      !== String(
        context.ticker || ''
      ).toUpperCase()
    ) {
      return stored;
    }

    const updated = reconcileLeftStarterNotification(
      mergeSourceContext(
        current,
        context,
        now
      ),
      now
    );

    if (
      JSON.stringify(updated)
      === raw
    ) {
      return stored;
    }

    if (
      writeIfUnchanged(
        raw,
        updated
      )
    ) {
      return updated;
    }

    return remainingAttempts > 0
      ? syncStoredBridgeContext(
          context,
          now,
          remainingAttempts - 1
        )
      : parseBridge(
          storageGet()
        );
  }

  /**
   * Debounces one-way source-context synchronization
   * after manual zone or Starter input.
   *
   * Invalid or partially entered zones are ignored.
   *
   * @param {object} context Current Entry Watch setup context.
   * @param {number} [delayMs] Injectable debounce delay for tests.
   * @returns {boolean}
   * True when a valid context update was scheduled.
   */
  function scheduleSourceContextSync(
    context,
    delayMs = SOURCE_CONTEXT_SYNC_DELAY_MS
  ) {
    if (
      sourceContextSyncTimer !== null
      && typeof root.clearTimeout === 'function'
    ) {
      root.clearTimeout(
        sourceContextSyncTimer
      );

      sourceContextSyncTimer =
        null;
    }

    if (
      !validSourceContext(context)
    ) {
      return false;
    }

    if (
      typeof root.setTimeout
        !== 'function'
    ) {
      syncStoredBridgeContext(
        context
      );

      return true;
    }

    const snapshot =
      JSON.parse(
        JSON.stringify(context)
      );

    sourceContextSyncTimer =
      root.setTimeout(
        () => {
          sourceContextSyncTimer =
            null;

          syncStoredBridgeContext(
            snapshot
          );
        },

        Math.max(
          0,
          Number(delayMs) || 0
        )
      );

    sourceContextSyncTimer
      ?.unref
      ?.();

    return true;
  }

  function lifecycleUpdate(
    bridge,
    status,
    now,
    reason = null
  ) {
    const updatedAt =
      isoTime(now);

    return {
      ...bridge,

      lifecycle: {
        ...bridge.lifecycle,
        status,
        updatedAt,
        reason,

        completedAt:
          status === 'COMPLETED'
            ? updatedAt
            : bridge.lifecycle
                ?.completedAt
              || null
      }
    };
  }

  function writeIfUnchanged(
    originalRaw,
    bridge
  ) {
    if (
      storageGet()
      !== originalRaw
    ) {
      return false;
    }

    return storageSet(
      JSON.stringify(bridge)
    );
  }

  /**
   * Adds legacy lifecycle fields
   * and expires old bridges.
   *
   * Valid setup context synchronization is handled separately.
   * An authoritative no-zone source state expires the linked bridge here.
   *
   * @param {object} context Current Entry Watch setup context.
   * @param {number|Date} [now] Injectable clock for tests.
   * @returns {object|null}
   * Latest stored bridge after reconciliation.
   */
  function reconcileStoredBridge(
    context,
    now = Date.now()
  ) {
    const raw =
      storageGet();

    const stored =
      parseBridge(raw);

    if (!stored) {
      return null;
    }

    let next =
      initializeNewBridge(
        stored,
        now
      );

    const time =
      now instanceof Date
        ? now.getTime()
        : Number(now);

    const status =
      next.lifecycle.status;

    if (
      [
        'ACTIVE',
        'PAUSED'
      ].includes(status)
      && Number.isFinite(
        Date.parse(
          next.lifecycle.expiresAt
        )
      )
      && (
        Number.isFinite(time)
          ? time
          : Date.now()
      ) >= Date.parse(
        next.lifecycle.expiresAt
      )
    ) {
      next =
        lifecycleUpdate(
          next,
          'EXPIRED',
          now,
          'Bridge reached its Taiwan trading-day expiration.'
        );
    }

    if (['ACTIVE', 'PAUSED'].includes(next.lifecycle.status)) {
      const invalidationReason = sourceLongZoneInvalidationReason(context);
      if (invalidationReason) next = lifecycleUpdate(next, 'EXPIRED', now, invalidationReason);
    }

    next = reconcileLeftStarterNotification(next, now);

    const changed =
      JSON.stringify(next)
      !== raw;

    if (
      changed
      && !writeIfUnchanged(
        raw,
        next
      )
    ) {
      return parseBridge(
        storageGet()
      );
    }

    return changed
      ? next
      : stored;
  }

  /**
   * Changes a bridge lifecycle
   * through an allowed user transition.
   *
   * @param {string} bridgeId Expected current bridge ID.
   * @param {'ACTIVE'|'PAUSED'|'COMPLETED'} targetStatus
   * Requested status.
   * @param {string|null} [reason] Optional lifecycle reason.
   * @param {number|Date} [now] Injectable clock for tests.
   * @returns {object|null}
   * Updated bridge, or null when rejected/stale.
   */
  function transitionStoredBridge(
    bridgeId,
    targetStatus,
    reason = null,
    now = Date.now()
  ) {
    const raw =
      storageGet();

    const stored =
      parseBridge(raw);

    if (
      !stored
      || stored.bridgeId
        !== bridgeId
    ) {
      return null;
    }

    const bridge =
      initializeNewBridge(
        stored,
        now
      );

    const current =
      bridge.lifecycle.status;

    const allowed =
      (
        current === 'ACTIVE'
        && [
          'PAUSED',
          'COMPLETED'
        ].includes(
          targetStatus
        )
      )
      || (
        current === 'PAUSED'
        && [
          'ACTIVE',
          'COMPLETED'
        ].includes(
          targetStatus
        )
      );

    if (!allowed) {
      return null;
    }

    const next =
      lifecycleUpdate(
        bridge,
        targetStatus,
        now,
        reason
      );

    return writeIfUnchanged(
      raw,
      next
    )
      ? next
      : null;
  }

  /**
   * Returns whether a bridge
   * is in a final lifecycle state.
   *
   * @param {object|null} bridge Bridge object.
   * @returns {boolean}
   * True for completed, expired, or invalidated bridges.
   */
  function isTerminal(bridge) {
    return TERMINAL_STATUSES
      .includes(
        bridge?.lifecycle?.status
      );
  }

  /**
   * Returns whether replacing a one-active-bridge session
   * requires confirmation.
   *
   * @param {object|null} bridge Existing bridge.
   * @param {string} ticker Requested ticker.
   * @returns {boolean}
   * True only for another ticker's active or paused bridge.
   */
  function requiresReplacementConfirmation(
    bridge,
    ticker
  ) {
    return [
      'ACTIVE',
      'PAUSED'
    ].includes(
      bridge?.lifecycle?.status
    )
      && String(
        bridge.ticker || ''
      ).toUpperCase()
      !== String(
        ticker || ''
      ).toUpperCase();
  }

  function statusLabel(status) {
    return {
      ACTIVE: 'Active',
      PAUSED: 'Paused',
      COMPLETED: 'Completed',
      EXPIRED: 'Expired',
      INVALIDATED: 'Invalidated'
    }[status]
      || 'Not Started';
  }

  function formatTime(value) {
    if (
      !value
      || !Number.isFinite(
        Date.parse(value)
      )
    ) {
      return 'Unavailable';
    }

    return new Date(value)
      .toLocaleString(
        'zh-TW',
        {
          timeZone:
            'Asia/Taipei',

          hour12:
            false
        }
      );
  }

  function formatPrice(value) {
    if (
      value === null
      || value === undefined
      || value === ''
    ) {
      return 'Unavailable';
    }

    const number =
      Number(value);

    return Number.isFinite(number)
      ? number.toLocaleString(
          undefined,
          {
            maximumFractionDigits: 4
          }
        )
      : 'Unavailable';
  }

   function entryModeLabel(mode) {
   if (mode === 'left_side_starter') {
    return 'Left-Side Starter';
   }

   if (mode === 'confirmed') {
    return 'Confirmed / Right-Side';
   }

   return 'Pending / Intraday Monitoring';
}

  function starterStatusLabel(
    bridge,
    result
  ) {
    if (
      bridge?.starterExecuted === true
      || result?.starterExecuted === true
    ) {
      return 'Executed';
    }

    if (
      bridge?.starterEligible === true
      || result?.starterEligible === true
    ) {
      return 'Eligible';
    }

    return 'Not Eligible';
  }



  function starterRiskLabel(
    bridge,
    result
  ) {
    const risk =
      result?.starterRisk
      || bridge?.starterRisk;

    if (
      !risk
      || typeof risk !== 'object'
    ) {
      return 'Unavailable';
    }

    const level =
      String(
        risk.level || 'Unavailable'
      );

    const reasons =
      Array.isArray(risk.reasons)
        ? risk.reasons
            .filter(Boolean)
        : [];

    return reasons.length
      ? `${level} — ${reasons.join('; ')}`
      : level;
  }

  function bindStorageListener() {
    if (
      storageListenerBound
      || typeof root.addEventListener
        !== 'function'
    ) {
      return;
    }

    storageListenerBound =
      true;

    root.addEventListener(
      'storage',
      event => {
        if (
          event.key !== STORAGE_KEY
          || !lastRender
        ) {
          return;
        }

        const {
          container,
          context,
          actions
        } = lastRender;

        if (
          container?.isConnected
            === false
        ) {
          return;
        }

        renderPanel(
          container,
          context,
          actions
        );
      }
    );
  }
  /**
   * Renders ETF_DCA-plan's informational monitor result
   * and lifecycle controls.
   *
   * It never feeds TAR-OBI results
   * into Entry Watch calculations.
   *
   * @param {HTMLElement} container
   * Execution Bridge panel container.
   *
   * @param {object} context
   * Current Entry Watch setup context.
   *
   * @param {object} actions
   * Host actions for start/open/toast behavior.
   *
   * @returns {void}
   */
  function renderPanel(
    container,
    context,
    actions = {}
  ) {
    if (!container) {
      return;
    }

    lastRender = {
      container,
      context,
      actions
    };

    bindStorageListener();

    const stored =
      reconcileStoredBridge(
        context
      );

    scheduleSourceContextSync(
      context
    );

    const ticker =
      String(
        context?.ticker || ''
      )
        .trim()
        .toUpperCase();

    const current =
      stored
      && String(
        stored.ticker
      ).toUpperCase()
        === ticker
        ? stored
        : null;

    const status =
      current?.lifecycle?.status
      || null;

    const result =
      current?.monitorResult
      || null;

    const entryReady =
      result?.assessmentState
        === 'ENTRY_CONDITIONS_MET';

    const leftSidePositive =
      [
        'LEFT_SIDE_STARTER_ELIGIBLE',
        'LEFT_SIDE_EXECUTION_ACCEPTABLE'
      ].includes(
        result?.assessmentState
      );

    const leftSideHighRisk =
      result?.assessmentState
        === 'HIGH_RISK_LEFT_SIDE_ENTRY';

    const border =
      entryReady
        ? '#52c41a'
        : leftSidePositive
          ? '#d69e2e'
          : leftSideHighRisk
            ? '#dd6b20'
            : 'var(--border)';

    const borderWidth =
      entryReady
      || leftSidePositive
      || leftSideHighRisk
        ? '2px'
        : '1px';

    const background =
      entryReady
        ? '#f6ffed'
        : leftSidePositive
          ? '#fffff0'
          : leftSideHighRisk
            ? '#fffaf0'
            : 'var(--surface2)';

    const otherActive =
      stored
      && !current
      && [
        'ACTIVE',
        'PAUSED'
      ].includes(
        stored.lifecycle?.status
      );

    const sourceLongZoneBlocked = Boolean(sourceLongZoneInvalidationReason(context));
    let buttons = '';

    if (sourceLongZoneBlocked) {
      buttons = `<span style="font-size:11px;color:var(--muted)">Bridge unavailable: no valid Active Long Zone.</span>`;
    } else if (!current) {
      buttons = `
        <button
          type="button"
          class="btn btn-outline btn-sm"
          data-bridge-action="start"
        >
          Start TAR-OBI Monitor
        </button>
      `;
    } else if (
      TERMINAL_STATUSES.includes(
        status
      )
    ) {
      buttons = `
        <button
          type="button"
          class="btn btn-outline btn-sm"
          data-bridge-action="open"
        >
          Open TAR-OBI Monitor
        </button>

        <button
          type="button"
          class="btn btn-primary btn-sm"
          data-bridge-action="start"
        >
          Start New Monitor
        </button>
      `;
    } else {
      buttons = `
        <button
          type="button"
          class="btn btn-outline btn-sm"
          data-bridge-action="open"
        >
          Open TAR-OBI Monitor
        </button>

        <button
          type="button"
          class="btn btn-outline btn-sm"
          data-bridge-action="${
            status === 'PAUSED'
              ? 'resume'
              : 'pause'
          }"
        >
          ${
            status === 'PAUSED'
              ? 'Resume'
              : 'Pause'
          }
        </button>

        <button
          type="button"
          class="btn btn-outline btn-sm"
          data-bridge-action="end"
        >
          End Monitor
        </button>
      `;
    }

    container.innerHTML = `
      <div
        style="
          margin-top:12px;
          padding:10px 14px;
          background:${background};
          border:${borderWidth} solid ${border};
          border-radius:10px
        "
      >
        <div
          style="
            font-size:11px;
            font-weight:700;
            color:var(--muted);
            letter-spacing:0.5px;
            margin-bottom:6px
          "
        >
          ${
            current
              ? 'TAR-OBI MONITOR'
              : 'EXECUTION BRIDGE'
          }
        </div>

        <div
          style="
            font-size:12px;
            margin-bottom:8px
          "
        >
          <span style="color:var(--muted)">
            Status:
          </span>

          <b data-bridge-field="status"></b>
        </div>

        ${status === 'EXPIRED' ? '<div style="font-size:12px;color:#874d00;line-height:1.5;margin-bottom:8px">TAR-OBI execution assessment is not currently active. Start New Monitor to assess a new current setup.</div>' : ''}

        <div
          data-bridge-result
          style="
            ${
              result
                ? ''
                : 'display:none'
            };
            font-size:12px;
            line-height:1.7;
            margin-bottom:8px
          "
        >
          <div>
            <span style="color:var(--muted)">
              ${
                status === 'COMPLETED'
                  ? 'Final Assessment'
                  : 'Assessment'
              }:
            </span>

            <b data-bridge-field="assessment"></b>
          </div>

          <div>
            <span style="color:var(--muted)">
              Entry Mode:
            </span>

            <b data-bridge-field="entry-mode"></b>
          </div>

          <div data-bridge-starter>
            <span style="color:var(--muted)">
              Starter Status:
            </span>

            <b data-bridge-field="starter-status"></b>
          </div>


          <div data-bridge-starter>
            <span style="color:var(--muted)">
              Starter Risk:
            </span>

            <b data-bridge-field="starter-risk"></b>
          </div>

          <div>
            <span style="color:var(--muted)">
              Current Price:
            </span>

            <b data-bridge-field="price"></b>
          </div>

          <div>
            <span style="color:var(--muted)">
              Last Evaluated:
            </span>

            <b data-bridge-field="evaluated"></b>
          </div>

          <div
            data-bridge-completed
            style="${
              status === 'COMPLETED'
                ? ''
                : 'display:none'
            }"
          >
            <span style="color:var(--muted)">
              Completed At:
            </span>

            <b data-bridge-field="completed"></b>
          </div>
        </div>

        <div
          data-bridge-reason
          style="
            ${
              current?.lifecycle?.reason
                ? ''
                : 'display:none'
            };
            font-size:12px;
            color:#874d00;
            margin-bottom:8px
          "
        ></div>

        <div
          data-bridge-other
          style="
            ${
              otherActive
                ? ''
                : 'display:none'
            };
            font-size:12px;
            color:#874d00;
            margin-bottom:8px
          "
        ></div>

        <div
          style="
            display:flex;
            gap:6px;
            flex-wrap:wrap
          "
        >
          ${buttons}
        </div>

        <div
          style="
            font-size:10px;
            color:var(--muted);
            line-height:1.5;
            margin-top:8px
          "
        >
          TAR-OBI results are informational execution context only and do not change Entry Watch decisions.
        </div>
      </div>
    `;

    const setText = (
      field,
      value
    ) => {
      const element =
        container.querySelector(
          `[data-bridge-field="${field}"]`
        );

      if (element) {
        element.textContent =
          value;
      }
    };

    const sourceForStarter =
      result
      && result.entryMode
        ? {
            ...current,
            ...result
          }
        : current
          || context;

   const effectiveEntryMode =
       current?.entryMode
       || context?.entryMode
       || result?.entryMode
       || 'pending';

    setText(
      'status',
      current
        ? statusLabel(status)
        : 'Not Started'
    );

    setText(
      'assessment',
      result?.assessmentState
      || 'Unavailable'
    );

    setText(
      'entry-mode',
      entryModeLabel(
        effectiveEntryMode
      )
    );

    setText(
      'starter-status',
      starterStatusLabel(
        sourceForStarter,
        result
      )
    );


    setText(
      'starter-risk',
      starterRiskLabel(
        sourceForStarter,
        result
      )
    );

    setText(
      'price',
      formatPrice(
        result?.currentPrice
      )
    );

    setText(
      'evaluated',
      formatTime(
        result?.evaluatedAt
      )
    );

    setText(
      'completed',
      formatTime(
        current
          ?.lifecycle
          ?.completedAt
      )
    );

    const starterMode =
      effectiveEntryMode
        === 'left_side_starter';

    container
      .querySelectorAll(
        '[data-bridge-starter]'
      )
      .forEach(
        element => {
          element.style.display =
            starterMode
              ? ''
              : 'none';
        }
      );

    const reasonElement =
      container.querySelector(
        '[data-bridge-reason]'
      );

    if (reasonElement) {
      reasonElement.textContent =
        current
          ?.lifecycle
          ?.reason
        || '';
    }

    const otherElement =
      container.querySelector(
        '[data-bridge-other]'
      );

    if (
      otherElement
      && otherActive
    ) {
      otherElement.textContent =
        `${
          stored.ticker
        } currently has a ${
          statusLabel(
            stored.lifecycle.status
          ).toLowerCase()
        } monitor. Starting ${
          ticker
        } will replace it.`;
    }

    container
      .querySelector(
        '[data-bridge-action="start"]'
      )
      ?.addEventListener(
        'click',
        () => {
          const latest =
            reconcileStoredBridge(
              context
            );

          if (
            requiresReplacementConfirmation(
              latest,
              ticker
            )
          ) {
            const confirmed =
              typeof root.confirm
                === 'function'
              && root.confirm(
                `Replace the active ${latest.ticker} TAR-OBI monitor with ${ticker}?`
              );

            if (!confirmed) {
              return;
            }
          }

          try {
            actions
              .startBridge
              ?.(context);

            renderPanel(
              container,
              context,
              actions
            );

            actions
              .openMonitor
              ?.();
          } catch (error) {
            actions
              .toast
              ?.(
                error.message,
                'err'
              );
          }
        }
      );

    container
      .querySelector(
        '[data-bridge-action="open"]'
      )
      ?.addEventListener(
        'click',
        () => {
          actions
            .openMonitor
            ?.();
        }
      );

    container
      .querySelector(
        '[data-bridge-action="pause"]'
      )
      ?.addEventListener(
        'click',
        () => {
          transitionStoredBridge(
            current.bridgeId,
            'PAUSED'
          );

          renderPanel(
            container,
            context,
            actions
          );
        }
      );

    container
      .querySelector(
        '[data-bridge-action="resume"]'
      )
      ?.addEventListener(
        'click',
        () => {
          transitionStoredBridge(
            current.bridgeId,
            'ACTIVE'
          );

          renderPanel(
            container,
            context,
            actions
          );
        }
      );

    container
      .querySelector(
        '[data-bridge-action="end"]'
      )
      ?.addEventListener(
        'click',
        () => {
          transitionStoredBridge(
            current.bridgeId,
            'COMPLETED'
          );

          renderPanel(
            container,
            context,
            actions
          );
        }
      );
  }

  return Object.freeze({
    STORAGE_KEY,
    CONTRACT_VERSION,
    MARKET_CLOSE_HOUR,
    MARKET_CLOSE_MINUTE,
    LIFECYCLE_STATUSES,
    TERMINAL_STATUSES,
    SOURCE_CONTEXT_SYNC_DELAY_MS,
    calculateExpiresAt,
    initializeNewBridge,
    sourceMismatchReason,
    reconcileStoredBridge,
    syncStoredBridgeContext,
    scheduleSourceContextSync,
    transitionStoredBridge,
    isTerminal,
    requiresReplacementConfirmation,
    hasCurrentTarHardExecutionBlock,
    reconcileLeftStarterNotification,
    renderPanel
  });
});
