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

storage = storageWith(phase1Bridge());
monitor = loadMonitor(storage);
bridge = monitor.reconcileStoredBridge({ ...context, activeZone: { low: 234, high: 235.6 } }, Date.parse('2026-07-27T03:00:00.000Z'));
assert.equal(bridge.lifecycle.status, 'INVALIDATED');
assert.match(bridge.lifecycle.reason, /Active Zone/);

storage = storageWith(phase1Bridge());
monitor = loadMonitor(storage);
bridge = monitor.reconcileStoredBridge(context, Date.parse('2026-07-27T06:00:00.000Z'));
assert.equal(bridge.lifecycle.status, 'EXPIRED');

const first = monitor.initializeNewBridge(phase1Bridge({ bridgeId: 'old' }));
const second = monitor.initializeNewBridge(phase1Bridge({ bridgeId: 'new' }));
assert.notEqual(first.bridgeId, second.bridgeId);
assert.equal(monitor.requiresReplacementConfirmation(first, '2330'), true);
assert.equal(monitor.requiresReplacementConfirmation(first, '006208'), false);

console.log('ETF execution bridge monitor tests passed.');
