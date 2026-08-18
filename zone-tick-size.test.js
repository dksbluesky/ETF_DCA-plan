'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const helperStart = html.indexOf('function getTaiwanTickSize');
const helperEnd = html.indexOf('function selectSuggestedWatchZones');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Taiwan tick helpers are present');

const helpers = new Function(`${html.slice(helperStart, helperEnd)}\nreturn { getTaiwanTickSize, snapPriceToTaiwanTick, buildZoneAroundSupport };`)();
const { getTaiwanTickSize, snapPriceToTaiwanTick, buildZoneAroundSupport } = helpers;

assert.equal(getTaiwanTickSize(24.5, 'ETF'), 0.01, '00878-class ETF below NT$50 uses NT$0.01');
assert.equal(getTaiwanTickSize(230, 'ETF'), 0.05, '006208-class ETF at or above NT$50 uses NT$0.05');
assert.equal(getTaiwanTickSize(9.99, 'Stock'), 0.01);
assert.equal(getTaiwanTickSize(10, 'Stock'), 0.05);
assert.equal(getTaiwanTickSize(50, 'Stock'), 0.1);
assert.equal(getTaiwanTickSize(100, 'Stock'), 0.5);
assert.equal(getTaiwanTickSize(500, 'Stock'), 1);
assert.equal(getTaiwanTickSize(1000, 'Stock'), 5, '2330-class stock at or above NT$1,000 uses NT$5');

assert.equal(snapPriceToTaiwanTick(24.537, 'ETF'), 24.54);
assert.equal(snapPriceToTaiwanTick(225.13, 'ETF'), 225.15);
assert.equal(snapPriceToTaiwanTick(230.99, 'ETF'), 231);
assert.equal(snapPriceToTaiwanTick(1448, 'Stock'), 1450);

const etfZone = buildZoneAroundSupport({ price: 228.06, source: 'test', score: 1, timeframe: 'daily' }, 8.3714285714, 'ETF');
assert.equal(etfZone.zoneLow, 225.15);
assert.equal(etfZone.zoneHigh, 231);
assert.equal(etfZone.supportPrice, 228.06, 'raw support calculation remains unchanged');

assert.match(
  html,
  /buildWatchZoneEngine\(_watchMarketCandles, timeframe, _watchCandles\[_watchCandles\.length - 1\]\?\.close, pos\.type\)/,
  'Suggested Zone tick schedule uses each saved ticker type'
);

assert.match(html, /const halfWidth = Math\.max\(atr \* 0\.35, level\.price \* 0\.004\);/, 'ATR zone-width formula is unchanged');
assert.match(html, /function recomputeZoneValidation\(\)[\s\S]*?const zoneLow = gf\('wc-zonelow'\), zoneHigh = gf\('wc-zonehigh'\);/, 'Zone Validation continues to read the Active Zone');
assert.match(html, /if \(!zoneHigh\)[\s\S]*?else if \(price > zoneHigh\)/, 'C1 continues to use the Active Zone high');
assert.match(html, /pos\.watchCriteria = \{[\s\S]*?zoneLow,[\s\S]*?zoneHigh,/, 'Active Zone persistence path is unchanged');
assert.match(html, /const configuredActiveZone = Number\.isFinite\(zoneLow\) && Number\.isFinite\(zoneHigh\)/, 'Existing zone values remain available as configured context');
assert.match(html, /activeZone: selectedActiveZone,/, 'New bridge output uses the isolated selected context zone');
assert.match(html, /if \(!zoneHigh\)[\s\S]*?else if \(price > zoneHigh\)/, 'C1 continues to use the persisted Active Zone high');

console.log('Suggested Zone tick-size tests passed.');
assert.match(html, /suggestedZone\(aggressive, conservative, getTaiwanTickSize/, 'Manual Suggested Zone uses the existing Taiwan tick schedule');
assert.match(html, /ManualZoneReassessment/, 'Manual reassessment uses its isolated state helper');