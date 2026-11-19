const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync(require.resolve('./execution-bridge-cloud.js'), 'utf8');
const key = 'A'.repeat(43);
const bridge = { version: '1.0', bridgeId: 'current', ticker: '006208',
  createdAt: '2026-11-19T01:00:00Z', sourceApplication: 'ETF_DCA-plan',
  monitorResult: { evaluatedAt: '2026-11-19T01:01:00Z', assessmentState: 'OLD' } };
const values = new Map([['etfDca.cloudBridge.url.v1', 'https://sync.example'],
  ['etfDca.cloudBridge.pairingKey.v1', key], ['etfDca.executionBridge.v1', JSON.stringify(bridge)]]);
let requests = [];
let remote = { ...bridge, monitorResult: { evaluatedAt: '2026-11-19T01:02:00Z', assessmentState: 'NEW' } };
let refreshes = 0;
const sandbox = {
  URL, AbortController, Date, Uint8Array, module: { exports: {} }, setTimeout, clearTimeout,
  localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
  ExecutionBridgeMonitor: { refreshPanel: () => { refreshes++; } },
  fetch: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/v1/bridge') ? { bridge: remote } : { bridgeId: bridge.bridgeId }));
  }
};
vm.runInNewContext(code, sandbox);
const client = sandbox.module.exports;

(async () => {
  assert.equal(await client.publishSource(bridge), false, 'cloud is opt-in');
  assert.equal(requests.length, 0);
  values.set(client.ENABLED_KEY, 'true');
  assert.equal(await client.publishSource(bridge), true);
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(JSON.parse(requests[0].options.body).bridge.bridgeId, 'current');
  assert.equal(await client.pullResult(), true);
  assert.equal(JSON.parse(values.get('etfDca.executionBridge.v1')).monitorResult.assessmentState, 'NEW');
  assert.equal(refreshes, 1);

  remote = { ...remote, bridgeId: 'other' };
  assert.equal(await client.pullResult(), false);
  assert.equal(JSON.parse(values.get('etfDca.executionBridge.v1')).bridgeId, 'current', 'other monitor cannot replace local ETF Bridge');
  console.log('ETF_DCA Cloud Bridge client tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
