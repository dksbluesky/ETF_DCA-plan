'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const values = new Map([['p_cache', '{"existing":true}']]);
global.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); }
};
global.document = {};
let opened = null;
let assigned = null;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0, userAgentData: { mobile: false } }
});
global.location = { assign(url) { assigned = url; } };
global.open = (...args) => {
  assert.ok(values.has('etfDca.executionBridge.v1'), 'Bridge must be saved before navigation.');
  opened = args;
  return {};
};

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
assert.deepEqual(opened, [bridge.TAR_OBI_URL, '_blank']);
assert.equal(assigned, null);

opened = null;
assigned = null;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', maxTouchPoints: 5, userAgentData: { mobile: true } }
});
assert.equal(bridge.openTarObiMonitor(), 'same-tab');
assert.equal(opened, null);
assert.equal(assigned, bridge.TAR_OBI_URL);

opened = null;
assigned = null;
global.location = {
  hostname: '127.0.0.1',
  origin: 'http://127.0.0.1:8080',
  assign(url) { assigned = url; }
};
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0, userAgentData: { mobile: false } }
});
assert.equal(bridge.resolveTarObiUrl(), 'http://127.0.0.1:8080/TAR-OBI/entry-assessment.html');
assert.equal(bridge.openTarObiMonitor(), 'new-tab');
assert.deepEqual(opened, ['http://127.0.0.1:8080/TAR-OBI/entry-assessment.html', '_blank']);

opened = null;
assigned = null;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Mobile/15E148', maxTouchPoints: 5, userAgentData: { mobile: false } }
});
assert.equal(bridge.openTarObiMonitor(), 'same-tab');
assert.equal(opened, null);
assert.equal(assigned, 'http://127.0.0.1:8080/TAR-OBI/entry-assessment.html');

const leftInput = { isDcaPosition: true, activeLongZoneIsValid: true, activeZone: { low: 230.8, high: 233.35 }, currentPrice: 232, c1ok: true, invalidationLevel: 229.5, starterExecuted: false, rightSideSetupConfirmed: false };
let left = bridge.evaluateLeftStarter(leftInput);
assert.equal(left.starterEligible, true, 'valid authoritative Active Zone plus C1 authorizes LEFT');
assert.equal(left.entryMode, 'left_side_starter');
left = bridge.evaluateLeftStarter({ ...leftInput, isDcaPosition: false });
assert.equal(left.starterEligible, true, 'LEFT eligibility is available for first-buy and already-owned positions');
left = bridge.evaluateLeftStarter({ ...leftInput, rightSideSetupConfirmed: true });
assert.deepEqual([left.starterEligible, left.entryMode], [false, 'confirmed'], 'RIGHT confirmation supersedes LEFT');
left = bridge.evaluateLeftStarter({ ...leftInput, activeLongZoneIsValid: false });
assert.equal(left.starterEligible, false, 'invalid or unavailable Active Zone blocks LEFT');
left = bridge.evaluateLeftStarter({ ...leftInput, currentPrice: 229.4 });
assert.equal(left.starterEligible, false, 'invalidation breach blocks LEFT');
left = bridge.evaluateLeftStarter({ ...leftInput, starterExecuted: true });
assert.equal(left.starterEligible, false, 'executed starter cannot be authorized again');
left = bridge.evaluateLeftStarter({ ...leftInput, activeZone: { low: 230.8, high: 233.35 } });
assert.equal(left.starterEligible, true, 'a valid Active Manual Zone can authorize LEFT independently of Suggested Zone state');
left = bridge.evaluateLeftStarter({ ...leftInput, activeZone: { low: 234, high: 235 } });
assert.equal(left.starterEligible, false, 'a Manual Zone or reassessment change that removes price from the Active Zone withdraws LEFT');

const entryWatchHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert.match(entryWatchHtml, /function confirmLeftStarterExecution\(\)/, 'starterExecuted has an explicit user-confirmation path');
assert.match(entryWatchHtml, /starterEligible \? '<button[^>]+onclick="confirmLeftStarterExecution\(\)"[^>]*>Record LEFT Starter executed<\/button>' : ''/, 'eligible LEFT Starter exposes the user-confirmed executed action');
assert.doesNotMatch(entryWatchHtml, /id=\\"wc-starter-executed\\"/, 'obsolete checkbox wiring cannot set starterExecuted implicitly');

assert.throws(() => bridge.createBridgeObject({}), /requires a ticker/);

console.log('Execution Bridge tests passed.');
