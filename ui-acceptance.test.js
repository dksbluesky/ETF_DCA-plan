'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function contentType(filePath) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json'
  })[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function startStaticServer(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const requested = path.resolve(root, relative);
    if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(requested, (error, contents) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.message);
        return;
      }
      response.writeHead(200, { 'Content-Type': contentType(requested), 'Cache-Control': 'no-store' });
      response.end(contents);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Chrome DevTools WebSocket connection failed.'));
  });
  return {
    ready,
    close() { socket.close(); },
    async send(method, params = {}) {
      await ready;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function main() {
  const browserPath = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  assert.ok(browserPath, 'Chrome or Edge is required for browser acceptance testing.');

  const outputDirectory = path.resolve(process.env.ACCEPTANCE_OUTPUT || path.join(os.tmpdir(), 'ETF_DCA-plan-ui-acceptance'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const browserProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-dca-acceptance-'));
  const server = await startStaticServer(__dirname);
  const serverPort = server.address().port;
  const debugPort = await unusedPort();
  const browser = childProcess.spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${browserProfile}`,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    const target = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' }
    ).then(response => response.json());
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `{
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => String(input).startsWith('https://api.github.com/')
          ? Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }))
          : nativeFetch(input, init);
      }`
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });

    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result?.value;
    };
    const screenshot = async name => {
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const filePath = path.join(outputDirectory, name);
      fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
      return filePath;
    };

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate("document.readyState === 'complete' && typeof openModal === 'function'")) break;
      await delay(100);
    }
    assert.equal(await evaluate("document.readyState === 'complete' && typeof openModal === 'function'"), true, 'production page did not finish loading');

    const setup = await evaluate(`(async () => {
      stopWatchAutoRefresh();
      refreshWatchData = async () => true;
      startWatchAutoRefresh = () => {};
      window.toast = toast = () => {};
      const manualReassessment = {
        threshold: 3,
        minOperationalTicks: 2,
        counter: 0,
        sequenceTimeframe: 'daily',
        trackingBaselinePeriod: '2026-09-01',
        lastCountedPeriod: null,
        latestSnapshot: null,
        snapshots: [],
        manualDraft: { low: 100, high: 102, edited: false, editedAt: null, suggestedForDate: '2026-09-06', editedForDate: null },
        activeManualZone: { low: 100, high: 102 },
        manualZoneSource: 'MANUAL',
        manualAppliedAt: '2026-09-06T01:00:00.000Z',
        readyNotifiedPeriod: null
      };
      const position = {
        id: 'acceptance-position', ticker: 'TEST', name: 'Acceptance Fixture', type: 'ETF',
        currentPrice: 101, trailStop: null, trailHigh: null, entries: [], dividends: [],
        watchCriteria: {
          marketLevelTimeframe: 'daily', zoneMode: 'manual', activeZoneSource: 'manual_reassessment',
          zoneLow: 100, zoneHigh: 102, manualZoneLow: 100, manualZoneHigh: 102,
          volThreshold: 200, stopLossMode: 'manual', stopLossManual: 95,
          starterExecuted: false, manualReassessment
        }
      };
      S.data = { version: 1, dca: [position], direct: [], lastUpdated: null };
      openModal('watch', 'dca|acceptance-position');
      await new Promise(resolve => setTimeout(resolve, 80));
      stopWatchAutoRefresh();
      const candles = Array.from({ length: 30 }, (_, index) => ({
        date: '2026-08-' + String(index + 1).padStart(2, '0'),
        open: 101, high: 103, low: 99, close: 101, volume: 100000
      }));
      _watchCandles = candles;
      _watchMarketCandles = candles;
      _watchPos = position;
      _watchQuote = { state: 'CLOSED', price: 101, officialClose: 101, open: 101, high: 103, low: 99, prev: 101 };
      _watchZoneEngine = { timeframe: 'daily', atr: 2, suggestedZones: { aggressive: { zoneLow: 100, zoneHigh: 101 }, conservative: { zoneLow: 101, zoneHigh: 102 } } };
      _watchListType = 'dca';
      _watchPosId = position.id;
      _watchStatusTab = 'status';
      calcWatchEMA5 = () => 101;
      detectWatchDefaults = () => ({ breakoutDate: candles[0].date, breakoutHigh: 103, breakoutVolLots: 100 });
      checkEarlySignal = () => null;
      const automaticContext = {
        context: 'bullish', automaticZoneEligible: true, zoneType: 'pullback_reversal',
        activeZone: { low: 100, high: 102 }, invalidationLevel: 95,
        reason: 'Deterministic Automatic fixture', evidence: { structure: ['fixture'], ema: [], supportResistance: [], fvg: [] }
      };
      window.EtfDcaMarketContextZone = {
        ...window.EtfDcaMarketContextZone,
        classify: () => JSON.parse(JSON.stringify(automaticContext))
      };
      document.getElementById('wc-zonelow').value = '100';
      document.getElementById('wc-zonehigh').value = '102';
      document.getElementById('wc-stopmode').value = 'manual';
      document.getElementById('wc-stopmanual').value = '95';
      document.getElementById('wc-volth').value = '200';
      recomputeWatchStatus();
      switchWatchMainTab('zone');
      const card = document.getElementById('wc-current-active-zone-card');
      return {
        manualShown: card.textContent.includes('Manual Reassessment Active Zone'),
        returnButtonShown: !!card.querySelector('button[onclick="returnToAutomaticContext()"]'),
        diagnosticAbsent: !document.documentElement.textContent.includes('Temporary LEFT Starter diagnostic'),
        cardHtml: card.innerHTML,
        source: getActiveZoneSource(),
        classified: window.EtfDcaMarketContextZone.classify()
      };
    })()`);
    assert.equal(setup.manualShown, true);
    assert.equal(setup.returnButtonShown, true, JSON.stringify(setup, null, 2));
    assert.equal(setup.diagnosticAbsent, true);
    const manualScreenshot = await screenshot('01-manual-with-automatic-return.png');
    console.log('PASS Manual Reassessment renders a reachable Return to Automatic action.');
    console.log('PASS Temporary LEFT diagnostic is absent from the production DOM.');

    const automatic = await evaluate(`(() => {
      document.querySelector('#wc-current-active-zone-card button[onclick="returnToAutomaticContext()"]').click();
      const position = S.data.dca.find(item => item.id === 'acceptance-position');
      const preserved = position.watchCriteria.manualReassessment;
      return {
        source: position.watchCriteria.activeZoneSource,
        mode: position.watchCriteria.zoneMode,
        cardText: document.getElementById('wc-current-active-zone-card').textContent,
        manualAppliedAt: preserved.manualAppliedAt,
        manualLow: preserved.activeManualZone.low,
        manualHigh: preserved.activeManualZone.high
      };
    })()`);
    assert.equal(automatic.source, 'automatic_context');
    assert.equal(automatic.mode, 'automatic_context');
    assert.match(automatic.cardText, /Automatic Zone A/);
    assert.deepEqual([automatic.manualLow, automatic.manualHigh, automatic.manualAppliedAt], [100, 102, '2026-09-06T01:00:00.000Z']);
    const automaticScreenshot = await screenshot('02-returned-to-automatic.png');
    console.log('PASS Clicking Return changes authority to Automatic and preserves Manual provenance.');

    const leftCancel = await evaluate(`(() => {
      switchWatchMainTab('status');
      recomputeWatchStatus();
      const button = [...document.querySelectorAll('#wc-status button')].find(item => item.textContent.includes('Record LEFT Starter executed'));
      if (!button) return { buttonShown: false };
      window.confirm = () => false;
      button.click();
      return { buttonShown: true, executed: S.data.dca[0].watchCriteria.starterExecuted === true };
    })()`);
    assert.deepEqual(leftCancel, { buttonShown: true, executed: false });
    const leftScreenshot = await screenshot('03-left-starter-eligible.png');
    console.log('PASS Eligible LEFT renders the real action; Cancel leaves execution unchanged.');

    const leftConfirm = await evaluate(`(() => {
      window.confirm = () => true;
      const button = [...document.querySelectorAll('#wc-status button')].find(item => item.textContent.includes('Record LEFT Starter executed'));
      button.click();
      return {
        executed: S.data.dca[0].watchCriteria.starterExecuted === true,
        text: document.getElementById('wc-status').textContent,
        buttonStillShown: [...document.querySelectorAll('#wc-status button')].some(item => item.textContent.includes('Record LEFT Starter executed'))
      };
    })()`);
    assert.equal(leftConfirm.executed, true);
    assert.match(leftConfirm.text, /Already executed/);
    assert.equal(leftConfirm.buttonStillShown, false);
    const executedScreenshot = await screenshot('04-left-starter-executed.png');
    console.log('PASS Confirm records LEFT exactly once and removes the action.');

    const right = await evaluate(`(() => {
      checkEarlySignal = () => ({ type: 'H2', daysAgo: 0, date: '2026-08-30', ratio: 0.5, lowVolume: true, precedingH1: null });
      recomputeWatchStatus();
      const text = document.getElementById('wc-status').textContent;
      return {
        hasRightPriority: text.includes('Right-side setup confirmed｜已完成右側確認，右側狀態優先'),
        bottomRight: text.includes('Right-side confirmation supersedes the Left-Side Starter state'),
        leftAlreadyExecutedShown: text.includes('Already executed｜本輪已執行，不可重複建立')
      };
    })()`);
    assert.deepEqual(right, { hasRightPriority: true, bottomRight: true, leftAlreadyExecutedShown: false });
    const rightScreenshot = await screenshot('05-right-priority-after-left.png');
    console.log('PASS RIGHT presentation supersedes an already-executed LEFT Starter.');

    const bridge = await evaluate(`(() => {
      const createdAt = '2026-09-06T01:00:00.000Z';
      const active = window.ExecutionBridgeMonitor.initializeNewBridge({
        version: '1.0', bridgeId: 'acceptance-bridge', ticker: 'TEST', createdAt,
        sourceApplication: 'ETF_DCA-plan', zoneMode: 'automatic_context',
        activeZone: { low: 100, high: 102 }, extensions: { marketContextV1: { context: 'bullish', automaticZoneEligible: true } }
      }, Date.parse(createdAt));
      localStorage.setItem('etfDca.executionBridge.v1', JSON.stringify(active));
      const expired = window.ExecutionBridgeMonitor.reconcileStoredBridge({
        ticker: 'TEST', zoneMode: null, activeZone: null,
        extensions: { marketContextV1: { context: 'range', automaticZoneEligible: false, manualOverride: false } }
      }, Date.parse('2026-09-06T01:05:00.000Z'));
      return { before: active.lifecycle.status, after: expired.lifecycle.status, reason: expired.lifecycle.reason };
    })()`);
    assert.equal(bridge.before, 'ACTIVE');
    assert.equal(bridge.after, 'EXPIRED');
    assert.equal(bridge.reason, 'No valid bullish Active Zone remains.');
    console.log('PASS Existing ACTIVE bridge becomes EXPIRED when no valid Active Long Zone remains.');

    console.log(`SCREENSHOT ${manualScreenshot}`);
    console.log(`SCREENSHOT ${automaticScreenshot}`);
    console.log(`SCREENSHOT ${leftScreenshot}`);
    console.log(`SCREENSHOT ${executedScreenshot}`);
    console.log(`SCREENSHOT ${rightScreenshot}`);
    console.log('Browser acceptance tests passed.');
  } finally {
    cdp?.close();
    browser.kill();
    await new Promise(resolve => server.close(resolve));
    await delay(100);
    fs.rmSync(browserProfile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
