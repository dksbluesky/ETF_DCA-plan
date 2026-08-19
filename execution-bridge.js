(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ExecutionBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STORAGE_KEY = 'etfDca.executionBridge.v1';
  const CONTRACT_VERSION = '1.0';
  const TAR_OBI_URL = 'https://dksbluesky.github.io/TAR-OBI/entry-assessment.html';
  const SOURCE_APPLICATION = 'ETF_DCA-plan';

  function optionalNumber(value) {
    const number = Number(value);
    return value !== null && value !== '' && Number.isFinite(number) ? number : null;
  }

  function createBridgeId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
      const random = Math.random() * 16 | 0;
      const value = character === 'x' ? random : (random & 0x3 | 0x8);
      return value.toString(16);
    });
  }

  function getStorage() {
    if (!root.localStorage) throw new Error('Execution Bridge storage is unavailable.');
    return root.localStorage;
  }

  /**
   * Creates a versioned execution handoff from an already-calculated Entry Watch snapshot.
   * This function copies context only and makes no trading decision.
   * @param {object} context Finished Entry Watch setup context.
   * @returns {object} A new version 1 execution bridge object.
   */
  function createBridgeObject(context) {
    if (!context || !String(context.ticker || '').trim()) {
      throw new Error('Execution Bridge requires a ticker.');
    }

    const zoneLow = optionalNumber(context.activeZone?.low);
    const zoneHigh = optionalNumber(context.activeZone?.high);
    const createdAt = new Date().toISOString();

    const bridge = {
      version: CONTRACT_VERSION,
      bridgeId: createBridgeId(),
      ticker: String(context.ticker).trim().toUpperCase(),
      createdAt,
      sourceApplication: SOURCE_APPLICATION,
      marketTimeframe: context.marketTimeframe || '1d',
      marketLevelTimeframe: context.marketLevelTimeframe || null,
      marketSessionState: context.marketSessionState || null,
      zoneMode: context.zoneMode || null,
      activeZone: zoneLow !== null && zoneHigh !== null
        ? { low: zoneLow, high: zoneHigh }
        : null,
      preferredEntry: optionalNumber(context.preferredEntry),
      maximumEntryPrice: optionalNumber(context.maximumEntryPrice),
      invalidationLevel: optionalNumber(context.invalidationLevel),

      // Optional entry-mode metadata. These fields extend the v1 bridge without
      // changing existing lifecycle, monitor, notification, or trading behavior.
      entryMode: context.entryMode === 'left_side_starter' ? 'left_side_starter' : (context.entryMode === 'confirmed' ? 'confirmed' : 'pending'),
      starterEligible: context.starterEligible === true,
      starterAllocationPct: optionalNumber(context.starterAllocationPct),
      starterExecuted: context.starterExecuted === true,
      starterRisk: context.starterRisk && typeof context.starterRisk === 'object'
        ? { ...context.starterRisk }
        : null,

      h1H2Status: context.h1H2Status || null,
      C1: context.C1 || null,
      C2: context.C2 || null,
      C3: context.C3 || null,
      C4: context.C4 || null,
      setupStatus: context.setupStatus || null,
      extensions: context.extensions && typeof context.extensions === 'object'
        ? JSON.parse(JSON.stringify(context.extensions))
        : {}
    };
    return root.ExecutionBridgeMonitor?.initializeNewBridge(bridge) || bridge;
  }

  /**
   * Persists one current execution handoff in the dedicated bridge namespace.
   * @param {object} bridge Versioned bridge object to persist.
   * @returns {object} The persisted bridge object.
   */
  function saveBridge(bridge) {
    if (!bridge || bridge.version !== CONTRACT_VERSION || !bridge.bridgeId) {
      throw new Error('Invalid Execution Bridge object.');
    }
    getStorage().setItem(STORAGE_KEY, JSON.stringify(bridge));
    return bridge;
  }

  /**
   * Loads the current version 1 handoff without reading ETF_DCA-plan storage.
   * @returns {object|null} The stored bridge, or null when absent or invalid.
   */
  function loadBridge() {
    const raw = getStorage().getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const bridge = JSON.parse(raw);
      return bridge && bridge.version === CONTRACT_VERSION && bridge.bridgeId ? bridge : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Removes only the execution bridge namespace.
   * @returns {void}
   */
  function removeBridge() {
    getStorage().removeItem(STORAGE_KEY);
  }

  /**
   * Creates and persists a handoff from finished setup context.
   * @param {object} context Finished Entry Watch setup context.
   * @returns {object} The new persisted bridge object.
   */
  function canStartForContext(context) {
    const marketContext = context?.extensions?.marketContextV1;
    if (!marketContext) return true;
    const low = Number(context?.activeZone?.low);
    const high = Number(context?.activeZone?.high);
    const validZone = Number.isFinite(low) && Number.isFinite(high) && low > 0 && high >= low;
    const automaticLongZone = marketContext.context === 'bullish' && marketContext.automaticZoneEligible === true;
    const manualOverride = context?.zoneMode === 'manual_override' && marketContext.manualOverride === true;
    return validZone && (automaticLongZone || manualOverride);
  }  function startBridge(context) {
    if (!canStartForContext(context)) throw new Error('No valid Active Long Zone is available for TAR-OBI monitoring.');
    const bridge = saveBridge(createBridgeObject(context));
    root.EtfDcaDecisionJournal?.recordBridgeStart?.(context, bridge);
    return bridge;
  }

  function evaluateLeftStarter(input = {}) {
    const zoneLow = optionalNumber(input.activeZone?.low);
    const zoneHigh = optionalNumber(input.activeZone?.high);
    const price = optionalNumber(input.currentPrice);
    const invalidationLevel = optionalNumber(input.invalidationLevel);
    const activeLongZoneIsValid = input.activeLongZoneIsValid === true
      && zoneLow !== null && zoneHigh !== null && zoneLow > 0 && zoneHigh >= zoneLow;
    const priceInsideAuthoritativeActiveZone = activeLongZoneIsValid
      && price !== null && price >= zoneLow - 1e-9 && price <= zoneHigh + 1e-9;
    const structuralInvalidationAvailable = invalidationLevel !== null && invalidationLevel > 0;
    const priceAboveInvalidation = structuralInvalidationAvailable
      && price !== null && price >= invalidationLevel - 1e-9;
    const starterEligible = activeLongZoneIsValid
      && priceInsideAuthoritativeActiveZone
      && input.c1ok === true
      && structuralInvalidationAvailable
      && priceAboveInvalidation
      && input.starterExecuted !== true
      && input.rightSideSetupConfirmed !== true;
    return {
      starterEligible,
      entryMode: input.rightSideSetupConfirmed === true ? 'confirmed' : (starterEligible ? 'left_side_starter' : 'pending'),
      activeLongZoneIsValid,
      priceInsideAuthoritativeActiveZone,
      structuralInvalidationAvailable,
      priceAboveInvalidation
    };
  }
  function isMobileOrTablet() {
    const navigatorInfo = root.navigator || {};
    const userAgent = String(navigatorInfo.userAgent || '');
    return navigatorInfo.userAgentData?.mobile === true
      || /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(userAgent)
      || (/Macintosh/i.test(userAgent) && Number(navigatorInfo.maxTouchPoints) > 1);
  }

  function navigateSameTab() {
    if (!root.location) return false;
    if (typeof root.location.assign === 'function') {
      root.location.assign(TAR_OBI_URL);
    } else {
      root.location.href = TAR_OBI_URL;
    }
    return true;
  }

  /**
   * Opens TAR-OBI after a bridge has been saved.
   * Desktop uses a new tab; mobile and tablet devices use the current tab.
   * @returns {'new-tab'|'same-tab'|'unavailable'} Navigation mode used.
   */
  function openTarObiMonitor() {
    try {
      if (isMobileOrTablet()) {
        return navigateSameTab() ? 'same-tab' : 'unavailable';
      }
      if (typeof root.open === 'function') {
        root.open(TAR_OBI_URL, '_blank');
        return 'new-tab';
      }
      return navigateSameTab() ? 'same-tab' : 'unavailable';
    } catch (error) {
      try {
        return navigateSameTab() ? 'same-tab' : 'unavailable';
      } catch (fallbackError) {
        return 'unavailable';
      }
    }
  }

  /**
   * Renders the optional Entry Watch bridge panel and binds its Start action.
   * @param {HTMLElement} container Element that will contain the bridge panel.
   * @param {object} context Finished Entry Watch setup context.
   * @returns {void}
   */
  function render(container, context) {
    if (!container || !root.document) return;
    if (typeof root.ExecutionBridgeMonitor?.renderPanel === 'function') {
      root.ExecutionBridgeMonitor.renderPanel(container, context, {
        canStartForContext,
    evaluateLeftStarter,
        startBridge,
        openMonitor: openTarObiMonitor,
        toast(message, type) {
          if (typeof root.toast === 'function') root.toast(message, type);
        }
      });
      return;
    }

    const stored = loadBridge();
    const currentTicker = String(context?.ticker || '').trim().toUpperCase();
    const isCurrent = stored?.ticker === currentTicker;
    const statusText = isCurrent
      ? `Started ${new Date(stored.createdAt).toLocaleString()}`
      : 'Not Started';

    container.innerHTML = `
      <div style="margin-top:12px;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:0.5px;margin-bottom:6px">EXECUTION BRIDGE</div>
        <div style="font-size:12px;margin-bottom:8px"><span style="color:var(--muted)">Status: </span><b data-bridge-status></b></div>
        <button type="button" class="btn btn-outline btn-sm" data-bridge-start>Start TAR-OBI Monitor</button>
      </div>`;

    const statusElement = container.querySelector('[data-bridge-status]');
    const startButton = container.querySelector('[data-bridge-start]');
    statusElement.textContent = statusText;
    startButton.addEventListener('click', () => {
      try {
        const bridge = startBridge(context);
        statusElement.textContent = `Started ${new Date(bridge.createdAt).toLocaleString()}`;
        if (typeof root.toast === 'function') {
          root.toast('Execution handoff prepared. Opening TAR-OBI.', 'ok');
        }
        openTarObiMonitor();
      } catch (error) {
        if (typeof root.toast === 'function') root.toast(error.message, 'err');
      }
    });
  }

  return Object.freeze({
    STORAGE_KEY,
    CONTRACT_VERSION,
    TAR_OBI_URL,
    createBridgeObject,
    saveBridge,
    loadBridge,
    removeBridge,
    canStartForContext,
    evaluateLeftStarter,
        startBridge,
    openTarObiMonitor,
    render
  });
});
