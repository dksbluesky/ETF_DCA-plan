'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const monitor = fs.readFileSync(path.join(__dirname, 'execution-bridge-monitor.js'), 'utf8');
const bridge = require('./execution-bridge.js');

assert.match(html, /const noActiveLongZone = !hasValidActiveLongZone;/);
assert.match(html, /Historical H1\/H2 detected — not actionable because no valid Active Long Zone\./);
assert.match(html, /statusEl\.innerHTML = noActiveLongZone/);
assert.match(html, /window\.ExecutionBridgeMonitor\?\.reconcileStoredBridge\(watchSnapshot\);/);
assert.match(html, /if \(hasValidActiveLongZone\) \{\s*window\.ExecutionBridge\?\.render\(bridgeContainer, watchSnapshot\);/);
assert.match(html, /Reference only — no valid Active Long Zone; cannot activate long monitoring or TAR-OBI bridge\./);
assert.match(html, /aggressiveApplyEl\.disabled = !hasValidAutomaticActiveZone \|\| !aggressive;/);
assert.match(html, /conservativeApplyEl\.disabled = !hasValidAutomaticActiveZone \|\| !conservative;/);
assert.match(html, /Active Long Zone A — Pullback Reversal/);
assert.match(html, /Active Long Zone B — V-Reversal Continuation/);
assert.match(html, /Active Long Zone C — Shallow Trend Continuation/);
assert.match(html, /Range: NT\$\$\{selectedActiveZone\?\.low\.toFixed\(2\)\}–NT\$\$\{selectedActiveZone\?\.high\.toFixed\(2\)\} · Invalidation: NT\$\$\{marketContext\?\.invalidationLevel\?\.toFixed\(2\) \?\? 'Unavailable'\}/);
assert.match(monitor, /function sourceLongZoneInvalidationReason\(context\)/);
assert.match(monitor, /lifecycleUpdate\(current, 'INVALIDATED', now, invalidationReason\)/);
assert.equal(bridge.canStartForContext({
  activeZone: null,
  extensions: { marketContextV1: { context: 'range', automaticZoneEligible: false } }
}), false);
assert.equal(bridge.canStartForContext({
  activeZone: { low: 100, high: 101 },
  extensions: { marketContextV1: { context: 'bullish', automaticZoneEligible: true } }
}), true);

console.log('Active Zone governing-state tests passed.');