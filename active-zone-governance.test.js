'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const monitor = fs.readFileSync(path.join(__dirname, 'execution-bridge-monitor.js'), 'utf8');
const bridge = require('./execution-bridge.js');
const reassessment = require('./manual-zone-reassessment.js');
const authoritySource = html.match(/function validZone\([\s\S]*?(?=function zoneModeLabel)/)?.[0];
assert.ok(authoritySource, 'Active Zone authority helper is present');
const resolveActiveZoneSelection = new Function(`${authoritySource}; return resolveActiveZoneSelection;`)();

const automaticB = { context: 'bullish', automaticZoneEligible: true, zoneType: 'v_reversal_continuation', activeZone: { low: 240, high: 242 } };
const explicitManual = { activeManualZone: { low: 228.4, high: 230.1 }, manualZoneSource: 'MANUAL', manualAppliedAt: '2026-08-28T01:00:00.000Z' };
const manualWinsAutomatic = resolveActiveZoneSelection({ marketContext: automaticB, manualReassessment: explicitManual });
assert.equal(manualWinsAutomatic.source, 'manual_reassessment', 'an explicit Manual Reassessment Active Zone wins over Automatic');
assert.deepEqual(manualWinsAutomatic.activeZone, { low: 228.4, high: 230.1 });
assert.equal(manualWinsAutomatic.primaryAction, 'reassess');

const automaticBWithLegacyManual = resolveActiveZoneSelection({
  marketContext: automaticB,
  configuredActiveZone: { low: 233.8, high: 236.3 },
  explicitSource: null,
  manualReassessment: { activeManualZone: { low: 233.8, high: 236.3 } }
});
assert.equal(automaticBWithLegacyManual.source, 'automatic', 'valid automatic B ignores legacy manual state');
assert.deepEqual(automaticBWithLegacyManual.activeZone, { low: 240, high: 242 }, 'valid automatic B remains the displayed zone');
assert.equal(automaticBWithLegacyManual.primaryAction, 'choose');

const noActiveZone = resolveActiveZoneSelection({ marketContext: { context: 'range', automaticZoneEligible: false }, manualReassessment: { activeManualZone: { low: 228.4, high: 230.1 } } });
assert.equal(noActiveZone.source, 'none', 'an unproven manual range does not create an active zone');
assert.equal(noActiveZone.primaryAction, 'none');
assert.match(html, /activeManualZone \? '<details><summary[^>]*>Reassess current manual zone/, 'applied manual reassessment panel is collapsed by default');
assert.match(html, /onclick="openManualReassessment\(\)">Reassess current manual zone/, 'the top card opens reassessment instead of rendering Choose Active Zone for an applied manual zone');
assert.match(html, /document\.getElementById\('wc-zonemode'\)\.value = 'automatic_context';/, 'Automatic apply persists the existing automatic/context-led mode');
const applyContextSource = html.match(/function applyContextActiveZone\(\)[\s\S]*?(?=function getAutomaticContextActiveZone)/)?.[0];
assert.ok(applyContextSource, 'Automatic apply handler is present');
assert.doesNotMatch(applyContextSource, /manualReassessment|manualZoneSource|manualAppliedAt/, 'Automatic apply does not create or mutate Manual Reassessment state');
const topCardSource = html.match(/function activeZoneLabel\([\s\S]*?(?=function openActiveZoneSelector)/)?.[0];
assert.ok(topCardSource, 'Current Active Zone card renderer is present');
const renderedCards = [];
const topCardUi = new Function('_watchQuote', '_watchCandles', 'document', `${topCardSource}; return { renderCurrentActiveZone };`)(
  { price: 241 },
  [{ close: 241 }],
  { getElementById() { const card = { innerHTML: '' }; renderedCards.push(card); return card; } }
);
topCardUi.renderCurrentActiveZone(automaticBWithLegacyManual);
assert.match(renderedCards.at(-1).innerHTML, /Choose Active Zone/, 'legacy-only manual fields render the Automatic top-card action');
assert.doesNotMatch(renderedCards.at(-1).innerHTML, /Manual Reassessment Active Zone/, 'legacy-only manual fields do not label the Automatic top card as Manual Reassessment');
topCardUi.renderCurrentActiveZone(manualWinsAutomatic);
assert.match(renderedCards.at(-1).innerHTML, /Manual Reassessment Active Zone/, 'explicit manual state renders the Manual Reassessment top card');
assert.match(renderedCards.at(-1).innerHTML, /Reassess current manual zone/, 'explicit manual state renders the reassessment top-card action');
const invalidDraftState = reassessment.prefillDraft({ ...explicitManual, manualDraft: { low: 239, high: 240 } }, { status: 'INVALID_SUGGESTED_ZONE' }, '2026-08-28');
assert.deepEqual(reassessment.explicitActiveManualZone(invalidDraftState), { low: 228.4, high: 230.1, manualAppliedAt: '2026-08-28T01:00:00.000Z' }, 'an invalid latest draft does not alter the applied manual range');
assert.equal(resolveActiveZoneSelection({ marketContext: automaticB, manualReassessment: invalidDraftState }).source, 'manual_reassessment', 'an invalid latest draft does not change Manual Reassessment authority');
console.log('Acceptance: Automatic with legacy-only manual fields renders Automatic + Choose Active Zone.');
console.log('Acceptance: explicit Manual Reassessment renders Reassess current manual zone.');
console.log('Acceptance: invalid Suggested Manual Zone preserves the applied manual range and authority.');

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
assert.match(html, /Automatic \/ Context-led Active Long Zone A — Pullback Reversal/);
assert.match(html, /Automatic \/ Context-led Active Long Zone B — V-Reversal Continuation/);
assert.match(html, /Automatic \/ Context-led Active Long Zone C — Shallow Trend Continuation/);
assert.match(html, /Manual Active Long Zone — current authoritative zone/);
assert.match(html, /The Manual Active Long Zone above remains the current authoritative Active Zone\./);
assert.match(html, /Authoritative Invalidation: \$\{selectedZoneInvalidation\}/);
assert.match(html, /const selectedZoneInvalidation = Number\.isFinite\(stopPrice\)/);
assert.doesNotMatch(html, /Starter Allocation|wc-starter-allocation|normalizeStarterAllocation/);
assert.match(html, /LEFT 基礎條件已滿足/);
assert.match(html, /Temporary LEFT Starter diagnostic/);
assert.match(monitor, /function sourceLongZoneInvalidationReason\(context\)/);
assert.match(monitor, /lifecycleUpdate\(current, 'EXPIRED', now, invalidationReason\)/);assert.match(monitor, /TAR-OBI execution assessment is not currently active\. Start New Monitor to assess a new current setup\./);
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
assert.equal(bridge.canStartForContext({
  zoneMode: 'manual_override',
  activeZone: { low: 228.4, high: 232 },
  extensions: { marketContextV1: { context: 'unclear', automaticZoneEligible: false, manualOverride: true } }
}), true);
assert.match(html, /wc-manual-reassessment/, 'Manual reassessment is isolated from the existing Active Zone controls');
assert.match(html, /applyManualReassessment/, 'Manual Active Zone changes require explicit Apply Manual');
assert.match(html, /CONFIGURED SUGGESTED WATCH ZONE/, 'Aggressive and Conservative configuration is not labeled as the Active Zone');
assert.match(html, /MANUAL ACTIVE LONG ZONE/, 'Manual mode remains clearly identified as the authoritative Active Long Zone');
assert.match(html, /Suggested zones become configured Watch Zones after Set Watch Zone; they do not override a valid Automatic \/ Context-led Active Long Zone\./);
assert.match(html, /Automatic \/ Context-led Active Long Zone remains authoritative unless a Manual Active Long Zone is applied\./);
assert.match(html, /const selectedIsManual = selection\.source === 'manual_reassessment';/);
assert.match(html, /Return to Automatic \/ Context-led Active Zone/, 'Manual override has an explicit return control');
assert.match(html, /function returnToAutomaticContext\(\)/, 'Return control has a dedicated handler');
assert.match(html, /modeEl\.value = 'automatic_context';/, 'Return handler restores automatic context authority');
assert.match(html, /manualZoneLow: zoneMode === 'manual' \? zoneLow : \(previous\.manualZoneLow \?\? null\)/, 'Returning to automatic context preserves the saved Manual zone');
assert.match(html, /AUTOMATIC \/ CONTEXT-LED ACTIVE LONG ZONE/, 'Automatic authority is identified separately from configured watch zones');
assert.match(html, /zoneMode === 'manual' \|\| zoneMode === 'automatic_context'/, 'Saved automatic-context mode reloads without selecting a suggested watch zone');
assert.match(html, /NT\$\$\{shownZone\.low\.toFixed\(2\)\}/, 'Automatic Active Zone display retains its NT$ currency prefix');
assert.match(html, /CURRENT AUTOMATIC \/ CONTEXT-LED ACTIVE LONG ZONE/, 'Configured Suggested and automatic zones are displayed separately');
assert.match(html, /const showAutomaticCard = false;/, 'only the resolver-backed top card is displayed');
assert.match(html, /NT\$\$\{automaticContext\.activeZone\.low\.toFixed\(2\)\} – NT\$\$\{automaticContext\.activeZone\.high\.toFixed\(2\)\}/, 'Automatic zone card displays the authoritative range with currency labels');
assert.match(html, /CURRENT ACTIVE ZONE/, 'one Current Active Zone card is rendered');
assert.match(html, /function openActiveZoneSelector\(\)/, 'selected-zone selector renders only the allowed alternatives');
assert.match(html, /aggressive_override/, 'Aggressive selection is a distinct explicit authoritative override');
assert.match(html, /conservative_override/, 'Conservative selection is a distinct explicit authoritative override');
assert.match(html, /Use \$\{label\} for TAR-OBI Linked Monitor\?/, 'selected zone requires a bridge confirmation');
assert.match(html, /panel\.style\.display = hasValidAutomaticActiveZone && !activeManualZone \? 'none' : '';/, 'Manual Reassessment stays available for an applied manual zone even when Automatic is also valid');
console.log('Active Zone governing-state tests passed.');
