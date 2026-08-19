'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('./execution-bridge-monitor.js');

function storageWith(bridge, extras = {}) {
  const values = new Map(Object.entries(extras));
  if (bridge) values.set('etfDca.executionBridge.v1', JSON.stringify(bridge));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function loadMonitor(storage) {
  global.localStorage = storage;
  delete require.cache[modulePath];
  return require(modulePath);
}

function phase1Bridge(overrides = {}) {
  return {
    version: '1.0',
    bridgeId: 'bridge-1',
    ticker: '006208',
    createdAt: '2026-07-27T02:00:00.000Z',
    sourceApplication: 'ETF_DCA-plan',
    marketTimeframe: '1d',
    marketLevelTimeframe: '60m',
    zoneMode: 'aggressive',
    activeZone: { low: 235.25, high: 235.6 },
    h1H2Status: null,
    C1: null,
    C2: null,
    C3: null,
    C4: null,
    setupStatus: null,
    extensions: { futureField: true },
    customTopLevel: { preserved: true },
    ...overrides
  };
}

const context = {
  ticker: '006208',
  marketLevelTimeframe: '60m',
  zoneMode: 'aggressive',
  activeZone: { low: 235.25, high: 235.6 }
};

let storage = storageWith(phase1Bridge(), { p_cache: '{"portfolio":true}' });
let monitor = loadMonitor(storage);
let bridge = monitor.reconcileStoredBridge(context, Date.parse('2026-07-27T03:00:00.000Z'));
assert.equal(bridge.lifecycle.status, 'ACTIVE');
assert.equal(bridge.lifecycle.expiresAt, '2026-07-27T05:30:00.000Z');
assert.equal(bridge.customTopLevel.preserved, true);
assert.equal(bridge.extensions.futureField, true);
assert.equal(storage.values.get('p_cache'), '{"portfolio":true}');

const afterCloseExpiry = monitor.calculateExpiresAt('2026-07-31T06:00:00.000Z');
assert.equal(afterCloseExpiry, '2026-08-03T05:30:00.000Z');

bridge = monitor.transitionStoredBridge('bridge-1', 'PAUSED', null, Date.parse('2026-07-27T03:05:00.000Z'));
assert.equal(bridge.lifecycle.status, 'PAUSED');
bridge = monitor.transitionStoredBridge('bridge-1', 'ACTIVE', null, Date.parse('2026-07-27T03:06:00.000Z'));
assert.equal(bridge.lifecycle.status, 'ACTIVE');
bridge = monitor.transitionStoredBridge('bridge-1', 'COMPLETED', null, Date.parse('2026-07-27T03:07:00.000Z'));
assert.equal(bridge.lifecycle.status, 'COMPLETED');
assert.ok(bridge.lifecycle.completedAt);
assert.equal(monitor.transitionStoredBridge('bridge-1', 'ACTIVE'), null);

const tarOwnedState = {
  monitorResult: {
    assessmentState: 'WAIT_FOR_CONFIRMATION',
    evaluatedAt: '2026-07-27T02:59:00.000Z'
  },
  notificationState: {
    lastNotifiedState: null,
    lastNotifiedAt: null,
    entryConfirmation: { status: 'PENDING', consecutiveCount: 1, confirmedAt: null },
    futureNotificationField: 'preserve'
  }
};
storage = storageWith(phase1Bridge(tarOwnedState));
monitor = loadMonitor(storage);
const liveContext = {
  ...context,
  marketTimeframe: '1d',
  marketSessionState: 'LIVE',
  zoneMode: 'manual',
  activeZone: { low: 219.5, high: 221.8 },
  preferredEntry: null,
  maximumEntryPrice: null,
  invalidationLevel: 218.9,
  h1H2Status: { type: 'H2', fresh: true },
  C1: { met: true, provisional: true },
  C2: { met: false, provisional: true },
  C3: { met: false, provisional: true },
  C4: { classification: 'Weak Close', confirmed: false },
  setupStatus: { label: 'Monitoring intraday', provisional: true }
};
bridge = monitor.reconcileStoredBridge(liveContext, Date.parse('2026-07-27T03:00:00.000Z'));
assert.equal(bridge.lifecycle.status, 'ACTIVE', 'a valid source-context change no longer invalidates the monitor');
assert.deepEqual(bridge.activeZone, { low: 235.25, high: 235.6 }, 'context waits for the debounced synchronization');
const beforeSync = JSON.parse(storage.getItem('etfDca.executionBridge.v1'));
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
let scheduled = null;
try {
  global.setTimeout = (callback, delay) => {
    scheduled = { callback, delay };
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  assert.equal(monitor.scheduleSourceContextSync(liveContext), true);
  assert.equal(scheduled.delay, monitor.SOURCE_CONTEXT_SYNC_DELAY_MS);
  assert.deepEqual(
    JSON.parse(storage.getItem('etfDca.executionBridge.v1')).activeZone,
    beforeSync.activeZone,
    'source context does not update before the debounce completes'
  );
  scheduled.callback();
} finally {
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
}

bridge = JSON.parse(storage.getItem('etfDca.executionBridge.v1'));
assert.equal(bridge.bridgeId, 'bridge-1');
assert.equal(bridge.lifecycle.status, 'ACTIVE');
assert.deepEqual(bridge.activeZone, { low: 219.5, high: 221.8 });
assert.equal(bridge.zoneMode, 'manual');
assert.equal(bridge.C1.met, true);
assert.equal(bridge.C2.met, false);
assert.equal(bridge.setupStatus.label, 'Monitoring intraday');
assert.deepEqual(bridge.monitorResult, tarOwnedState.monitorResult);
assert.equal(bridge.notificationState.lastNotifiedAt, null);
assert.deepEqual(bridge.notificationState.entryConfirmation, tarOwnedState.notificationState.entryConfirmation);
assert.equal(bridge.notificationState.futureNotificationField, 'preserve');
assert.equal(bridge.notificationState.dataUnavailableSince, null);
assert.equal(bridge.extensions.futureField, true);
assert.ok(Number.isFinite(Date.parse(bridge.extensions.sourceContextUpdatedAt)));

const validRaw = storage.getItem('etfDca.executionBridge.v1');
assert.equal(monitor.scheduleSourceContextSync({ ...liveContext, activeZone: { low: null, high: 221.8 } }, 0), false);
assert.equal(storage.getItem('etfDca.executionBridge.v1'), validRaw, 'partial zone input is ignored');

storage = storageWith(phase1Bridge({
  lifecycle: {
    status: 'COMPLETED',
    updatedAt: '2026-07-27T03:00:00.000Z',
    expiresAt: '2026-07-27T05:30:00.000Z',
    completedAt: '2026-07-27T03:00:00.000Z'
  }
}));
monitor = loadMonitor(storage);
bridge = monitor.syncStoredBridgeContext(liveContext, Date.parse('2026-07-27T03:01:00.000Z'));
assert.deepEqual(bridge.activeZone, { low: 235.25, high: 235.6 }, 'terminal bridge context remains immutable');

storage = storageWith(phase1Bridge());
monitor = loadMonitor(storage);
bridge = monitor.reconcileStoredBridge(context, Date.parse('2026-07-27T06:00:00.000Z'));
assert.equal(bridge.lifecycle.status, 'EXPIRED');

const first = monitor.initializeNewBridge(phase1Bridge({ bridgeId: 'old' }));
const second = monitor.initializeNewBridge(phase1Bridge({ bridgeId: 'new' }));
assert.notEqual(first.bridgeId, second.bridgeId);
assert.equal(monitor.requiresReplacementConfirmation(first, '2330'), true);
assert.equal(monitor.requiresReplacementConfirmation(first, '006208'), false);

storage = storageWith(phase1Bridge());
monitor = loadMonitor(storage);
bridge = monitor.syncStoredBridgeContext({
  ...liveContext,
  currentPrice: 222,
  extensions: {
    marketContextV1: {
      context: 'bullish',
      automaticZoneEligible: true,
      invalidationLevel: 218.9
    }
  }
}, Date.parse('2026-07-27T03:02:00.000Z'));
assert.equal(bridge.lifecycle.status, 'ACTIVE', 'a temporary price exit must not invalidate the bridge');
assert.equal(bridge.lifecycle.reason, null);
storage = storageWith(phase1Bridge());
monitor = loadMonitor(storage);
bridge = monitor.syncStoredBridgeContext({
  ...liveContext,
  zoneMode: 'manual_override',
  extensions: {
    marketContextV1: {
      context: 'unclear',
      automaticZoneEligible: false,
      manualOverride: true,
      invalidationLevel: 218.9
    }
  }
}, Date.parse('2026-07-27T03:03:00.000Z'));
assert.equal(bridge.lifecycle.status, 'ACTIVE', 'a valid manual override must not invalidate the TAR-OBI monitor');
assert.equal(bridge.lifecycle.reason, null);
const originalNotification = global.Notification;
const leftNotifications = [];
try {
  global.Notification = function Notification(title, options) { leftNotifications.push({ title, options }); };
  global.Notification.permission = 'granted';
  storage = storageWith(phase1Bridge({ entryMode: 'left_side_starter', starterEligible: true, starterExecuted: false, invalidationLevel: 234.5 }));
  monitor = loadMonitor(storage);
  bridge = monitor.reconcileStoredBridge(context, Date.parse('2026-07-27T03:00:00.000Z'));
  assert.equal(leftNotifications.length, 1, 'LEFT notification emits on the current bridge false-to-true transition');
  assert.equal(leftNotifications[0].title, 'LEFT-SIDE STARTER — execution assessment available');
  monitor.reconcileStoredBridge(context, Date.parse('2026-07-27T03:01:00.000Z'));
  assert.equal(leftNotifications.length, 1, 'LEFT notification does not repeat without a new false-to-true transition');
  storage = storageWith(phase1Bridge({ entryMode: 'left_side_starter', starterEligible: true, starterExecuted: false, invalidationLevel: 234.5, monitorResult: { hardExecutionBlock: true, activeZone: { low: 235.25, high: 235.6 }, invalidationLevel: 234.5 } }));
  monitor = loadMonitor(storage);
  monitor.reconcileStoredBridge(context, Date.parse('2026-07-27T03:00:00.000Z'));
  assert.equal(leftNotifications.length, 1, 'a matching TAR-OBI hard execution block suppresses LEFT notification');
} finally {
  global.Notification = originalNotification;
}

console.log('ETF execution bridge monitor tests passed.');
