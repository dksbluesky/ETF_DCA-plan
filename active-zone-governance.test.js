'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const monitor = fs.readFileSync(path.join(__dirname, 'execution-bridge-monitor.js'), 'utf8');
const bridge = require('./execution-bridge.js');

const noZoneUiSource = html.match(/function recentConfirmedSwingDetails[\s\S]*?(?=function renderContextActiveZone)/)?.[0];
assert.ok(noZoneUiSource, 'no-zone UI helpers are present');
const noZoneUi = new Function('window', `${noZoneUiSource}; return { renderNoActiveLongZoneCard };`)({
  EtfDcaMarketContextZone: { DEFAULT_PARAMETERS: { swingWindow: 1 } }
});
const bearishFixture = [
  { date: '2026-07-01', open: 9.5, high: 10, low: 9, close: 9.7 },
  { date: '2026-07-02', open: 10, high: 12, low: 10, close: 11 },
  { date: '2026-07-03', open: 10, high: 11, low: 8, close: 9 },
  { date: '2026-07-04', open: 10, high: 11.5, low: 9, close: 10.5 },
  { date: '2026-07-05', open: 9, high: 10, low: 7, close: 8 },
  { date: '2026-07-06', open: 9, high: 10.5, low: 8, close: 9.5 }
];
const renderedNoZone = noZoneUi.renderNoActiveLongZoneCard(
  bearishFixture,
  '<details><summary>Historical H1/H2 detected — not actionable because no valid Active Long Zone.</summary></details>'
);
const renderedVRecoveryNoZone = noZoneUi.renderNoActiveLongZoneCard(
  bearishFixture,
  '<details><summary>Historical H1/H2 detected — not actionable because no valid Active Long Zone.</summary></details>',
  {
    noZoneSubtype: 'v_recovery_breakout_awaiting_hl',
    vRecoveryBreakout: {
      vLow: { price: 210.2, date: '2026-07-29' },
      priorHigh: { price: 240.1, date: '2026-07-22' },
      breakout: { close: 244.4, date: '2026-08-13' }
    }
  }
);

assert.match(html, /const noActiveLongZone = !hasValidActiveLongZone;/);
assert.match(html, /Historical H1\/H2 detected — not actionable because no valid Active Long Zone\./);
assert.match(html, /statusEl\.innerHTML = noActiveLongZone/);
assert.match(html, /window\.ExecutionBridgeMonitor\?\.reconcileStoredBridge\(watchSnapshot\);/);
assert.match(html, /if \(hasValidActiveLongZone\) \{\s*window\.ExecutionBridge\?\.render\(bridgeContainer, watchSnapshot\);/);
assert.match(renderedNoZone, /No Active Long Zone — current structure does not yet support a long setup\./);
assert.match(renderedNoZone, /No long Zone is selected; TAR-OBI long bridge is unavailable\./);
assert.match(renderedNoZone, /<details[^>]*>[\s\S]*<summary[^>]*>Structure details<\/summary>/);
assert.match(renderedNoZone, /Recent confirmed swings: LH NT\$11\.50 \(2026-07-04\) → LL NT\$7\.00 \(2026-07-05\)\./);
assert.match(renderedNoZone, /Context remains range\/unclear; this is not a short signal\./);
assert.match(renderedNoZone, /Historical H1\/H2 detected — not actionable because no valid Active Long Zone\./);
assert.doesNotMatch(renderedNoZone.split('<details')[0], /Lower High \+ Lower Low|LL \+ LH|bearish/i);
assert.match(renderedVRecoveryNoZone, /V-recovery breakout — awaiting post-breakout Higher Low/);
assert.match(renderedVRecoveryNoZone, /Price has recovered from the V low and broken above the prior swing high\./);
assert.match(renderedVRecoveryNoZone, /No Active Long Zone yet; wait for a confirmed retracement Higher Low before bridging to TAR-OBI\./);
assert.match(renderedVRecoveryNoZone, /<details[^>]*>[\s\S]*<summary[^>]*>Structure details<\/summary>/);
assert.match(renderedVRecoveryNoZone, /V low NT\$210\.20 \(2026-07-29\) → completed breakout close NT\$244\.40 \(2026-08-13\) above prior swing high NT\$240\.10 \(2026-07-22\)\. Awaiting a post-breakout Higher Low\./);
assert.doesNotMatch(renderedVRecoveryNoZone, /Recent confirmed swings:/);
assert.match(renderedVRecoveryNoZone, /Historical H1\/H2 detected — not actionable because no valid Active Long Zone\./);assert.match(html, /aggressiveApplyEl\.disabled = !hasValidAutomaticActiveZone \|\| !aggressive;/);
assert.match(html, /conservativeApplyEl\.disabled = !hasValidAutomaticActiveZone \|\| !conservative;/);
assert.match(html, /const greyUnavailableApply = element =>/);
assert.match(html, /element\.classList\.toggle\('btn-outline', !hasValidAutomaticActiveZone\);/);
assert.match(html, /element\.style\.background = hasValidAutomaticActiveZone \? '' : 'var\(--surface2\)'/);
assert.match(html, /greyUnavailableApply\(aggressiveApplyEl\);/);
assert.match(html, /greyUnavailableApply\(conservativeApplyEl\);/);
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
assert.equal(bridge.canStartForContext({
  activeZone: null,
  extensions: { marketContextV1: { context: 'unclear', automaticZoneEligible: false, noZoneSubtype: 'v_recovery_breakout_awaiting_hl' } }
}), false);
console.log('Active Zone governing-state tests passed.');