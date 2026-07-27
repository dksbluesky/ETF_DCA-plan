'use strict';

const assert = require('node:assert/strict');
const values = new Map([['p_cache', '{"existing":true}']]);
global.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); }
};

require('./execution-bridge-monitor.js');
const bridgeApi = require('./execution-bridge.js');
const context = {
  ticker: '006208',
  marketTimeframe: '1d',
  marketLevelTimeframe: '60m',
  zoneMode: 'aggressive',
  activeZone: { low: 235.25, high: 235.6 }
};

const first = bridgeApi.createBridgeObject(context);
const second = bridgeApi.createBridgeObject(context);
assert.equal(first.version, '1.0');
assert.equal(first.lifecycle.status, 'ACTIVE');
assert.equal(first.monitorResult, null);
assert.equal(first.notificationState.lastNotifiedState, null);
assert.notEqual(first.bridgeId, second.bridgeId);

bridgeApi.saveBridge(first);
assert.equal(values.get('p_cache'), '{"existing":true}');

console.log('Execution Bridge Phase 3 integration tests passed.');
