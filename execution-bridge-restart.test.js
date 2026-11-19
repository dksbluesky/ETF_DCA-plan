'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('./execution-bridge-monitor.js');

function scenario(dismissedBeforeRender) {
  const bridge = { version: '1.0', bridgeId: 'bridge-old', ticker: '006208',
    createdAt: new Date().toISOString(), sourceApplication: 'ETF_DCA-plan',
    marketTimeframe: '1d', marketLevelTimeframe: 'daily', zoneMode: 'manual',
    activeZone: { low: 238, high: 243 }, monitorResult: { assessmentState: 'ENTRY_CONDITIONS_MET' } };
  const values = new Map([['etfDca.executionBridge.v1', JSON.stringify(bridge)]]);
  const dismissalKey = 'tarObi.executionBridge.dismissedBridgeId.v1';
  if (dismissedBeforeRender) values.set(dismissalKey, bridge.bridgeId);
  global.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  delete require.cache[modulePath];
  const monitor = require(modulePath);
  const elements = new Map();
  const container = {
    innerHTML: '', isConnected: true,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        textContent: '', style: {}, listeners: {},
        addEventListener(type, callback) { this.listeners[type] = callback; }
      });
      return elements.get(selector);
    },
    querySelectorAll() { return []; }
  };
  const context = { ticker: '006208', marketLevelTimeframe: 'daily', zoneMode: 'manual',
    activeZone: { low: 203, high: 209 } };
  let started = 0;
  let opened = 0;
  monitor.renderPanel(container, context, {
    startBridge(current) {
      started++;
      const fresh = monitor.initializeNewBridge({ ...bridge, bridgeId: 'bridge-new',
        activeZone: current.activeZone, monitorResult: null, notificationState: null });
      values.set('etfDca.executionBridge.v1', JSON.stringify(fresh));
      return fresh;
    },
    openMonitor() { opened++; }
  });
  return { container, elements, values, dismissalKey, monitor, context,
    counts: () => ({ started, opened }) };
}

const alreadyDismissed = scenario(true);
assert.match(alreadyDismissed.container.innerHTML, /Restart TAR-OBI Monitor/);
assert.doesNotMatch(alreadyDismissed.container.innerHTML, /data-bridge-action="open"/);
alreadyDismissed.monitor.syncStoredBridgeContext(alreadyDismissed.context);
assert.deepEqual(JSON.parse(alreadyDismissed.values.get('etfDca.executionBridge.v1')).activeZone,
  { low: 238, high: 243 }, 'dismissed monitor does not mix a new zone with its old result');
alreadyDismissed.elements.get('[data-bridge-action="start"]').listeners.click();
assert.deepEqual(alreadyDismissed.counts(), { started: 1, opened: 1 });
assert.equal(JSON.parse(alreadyDismissed.values.get('etfDca.executionBridge.v1')).bridgeId, 'bridge-new');

const dismissedAfterRender = scenario(false);
assert.match(dismissedAfterRender.container.innerHTML, /data-bridge-action="open"/);
dismissedAfterRender.values.set(dismissedAfterRender.dismissalKey, 'bridge-old');
dismissedAfterRender.elements.get('[data-bridge-action="open"]').listeners.click();
assert.deepEqual(dismissedAfterRender.counts(), { started: 1, opened: 1 },
  'an already-rendered Open button starts a fresh Bridge after TAR dismisses the old one');
console.log('ETF_DCA TAR-OBI restart tests passed');
