'use strict';

const assert = require('node:assert/strict');

const values = new Map([['p_cache', '{"existing":true}']]);
global.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); }
};
global.document = {};
global.open = () => { throw new Error('The bridge must not launch another application.'); };

const bridge = require('./execution-bridge.js');

const context = {
  ticker: '00981a',
  marketTimeframe: '1d',
  marketLevelTimeframe: 'daily',
  marketSessionState: 'CLOSED',
  zoneMode: 'aggressive',
  activeZone: { low: 10.5, high: 11.25 },
  preferredEntry: null,
  maximumEntryPrice: null,
  invalidationLevel: 9.9,
  h1H2Status: { type: 'H2', fresh: true, lowVolume: true },
  C1: { met: true, provisional: false },
  C2: { met: true, provisional: false },
  C3: { met: false, provisional: false },
  C4: { classification: 'Strong Close', confirmed: true },
  setupStatus: { label: 'Existing Entry Watch result', provisional: false }
};

const created = bridge.createBridgeObject(context);
assert.equal(created.version, '1.0');
assert.equal(created.ticker, '00981A');
assert.deepEqual(created.activeZone, { low: 10.5, high: 11.25 });
assert.equal(created.preferredEntry, null);
assert.equal(created.maximumEntryPrice, null);
assert.equal(created.invalidationLevel, 9.9);
assert.deepEqual(created.extensions, {});

bridge.saveBridge(created);
assert.deepEqual(bridge.loadBridge(), created);
assert.equal(values.get('p_cache'), '{"existing":true}');

bridge.removeBridge();
assert.equal(bridge.loadBridge(), null);
assert.equal(values.get('p_cache'), '{"existing":true}');

values.set(bridge.STORAGE_KEY, '{invalid json');
assert.equal(bridge.loadBridge(), null);
assert.equal(values.get('p_cache'), '{"existing":true}');

const statusElement = { textContent: '' };
const startButton = {
  addEventListener(eventName, handler) {
    assert.equal(eventName, 'click');
    this.click = handler;
  }
};
const container = {
  innerHTML: '',
  querySelector(selector) {
    return selector === '[data-bridge-status]' ? statusElement : startButton;
  }
};

bridge.render(container, context);
assert.equal(statusElement.textContent, 'Not Started');
startButton.click();
assert.equal(bridge.loadBridge().ticker, '00981A');
assert.match(statusElement.textContent, /^Started /);
assert.equal(values.get('p_cache'), '{"existing":true}');

assert.throws(() => bridge.createBridgeObject({}), /requires a ticker/);

console.log('Execution Bridge tests passed.');
