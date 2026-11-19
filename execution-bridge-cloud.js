(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EtfDcaCloudBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const URL_KEY = 'etfDca.cloudBridge.url.v1';
  const DEFAULT_URL = 'https://tar-obi-bridge-sync.dk0986.workers.dev';
  const KEY_KEY = 'etfDca.cloudBridge.pairingKey.v1';
  const ENABLED_KEY = 'etfDca.cloudBridge.enabled.v1';
  const BRIDGE_KEY = 'etfDca.executionBridge.v1';
  let lastSentMs = 0;
  let polling = false;
  let lastStatus = 'Cloud Sync off';
  let settingsStatus = null;

  function isIOS() {
    const navigatorInfo = root.navigator || {};
    return /iPhone|iPad|iPod/i.test(navigatorInfo.userAgent || '')
      || (/Macintosh/i.test(navigatorInfo.userAgent || '') && Number(navigatorInfo.maxTouchPoints) > 1);
  }
  function cleanUrl(value) {
    const url = String(value || '').trim().replace(/\/+$/, '');
    try { return new URL(url).protocol === 'https:' ? url : ''; } catch (_error) { return ''; }
  }
  function pairingKey() { return root.localStorage?.getItem(KEY_KEY) || ''; }
  function enabled() {
    return root.localStorage?.getItem(ENABLED_KEY) === 'true'
      && Boolean(cleanUrl(root.localStorage?.getItem(URL_KEY) || DEFAULT_URL))
      && /^[A-Za-z0-9_-]{43}$/.test(pairingKey());
  }
  function status(message) {
    lastStatus = message;
    if (settingsStatus) settingsStatus.textContent = message;
  }
  function nextSentAt() {
    lastSentMs = Math.max(Date.now(), lastSentMs + 1);
    return new Date(lastSentMs).toISOString();
  }
  async function request(path, method = 'GET', body) {
    const controller = new AbortController();
    const timeout = root.setTimeout(() => controller.abort(), 7000);
    let response;
    try {
      response = await root.fetch(`${cleanUrl(root.localStorage.getItem(URL_KEY) || DEFAULT_URL)}${path}`, {
        method, cache: 'no-store', signal: controller.signal, headers: {
          Authorization: `Bearer ${pairingKey()}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        }, ...(body ? { body: JSON.stringify(body) } : {})
      });
    } finally { root.clearTimeout(timeout); }
    if (!response.ok) throw new Error(`Cloud HTTP ${response.status}`);
    return response.json();
  }
  async function publishSource(bridge) {
    if (!enabled() || !bridge?.bridgeId) return false;
    try {
      await request('/v1/source', 'PUT', { bridge, sentAt: nextSentAt() });
      status(`Cloud published · ${bridge.ticker} · ${bridge.bridgeId.slice(0, 8)}`);
      return true;
    } catch (error) {
      status(`Cloud publish failed: ${error.message}; local monitor remains active`);
      return false;
    }
  }
  async function pullResult() {
    if (!enabled()) return false;
    const raw = root.localStorage?.getItem(BRIDGE_KEY);
    if (!raw) return false;
    let local;
    try { local = JSON.parse(raw); } catch (_error) { return false; }
    try {
      const remote = (await request('/v1/bridge')).bridge;
      if (!remote || remote.bridgeId !== local.bridgeId) {
        status('Cloud Bridge differs; local monitor was not replaced');
        return false;
      }
      const localAt = Date.parse(local.monitorResult?.evaluatedAt || '') || 0;
      const remoteAt = Date.parse(remote.monitorResult?.evaluatedAt || '') || 0;
      const terminal = ['COMPLETED', 'EXPIRED', 'INVALIDATED'];
      const remoteLifecycle = remote.lifecycle;
      const localLifecycle = local.lifecycle;
      const takeLifecycle = remoteLifecycle && (terminal.includes(remoteLifecycle.status)
        && !terminal.includes(localLifecycle?.status)
        || (terminal.includes(remoteLifecycle.status) === terminal.includes(localLifecycle?.status)
          && (Date.parse(remoteLifecycle.updatedAt || '') || 0) > (Date.parse(localLifecycle?.updatedAt || '') || 0)));
      if ((remoteAt > localAt || takeLifecycle) && root.localStorage.getItem(BRIDGE_KEY) === raw) {
        root.localStorage.setItem(BRIDGE_KEY, JSON.stringify({ ...local,
          ...(remoteAt > localAt ? { monitorResult: remote.monitorResult } : {}),
          ...(takeLifecycle ? { lifecycle: remoteLifecycle } : {}) }));
        root.ExecutionBridgeMonitor?.refreshPanel?.();
      }
      status(`Cloud checked · ${remote.ticker} · ${new Date().toLocaleString()}`);
      return true;
    } catch (error) {
      status(`Cloud unavailable: ${error.message}; local monitor may be older`);
      return false;
    }
  }
  function start() {
    if (!enabled()) return;
    if (polling) { void pullResult(); return; }
    polling = true;
    root.setInterval?.(() => { if (!root.document?.hidden) void pullResult(); }, 30000);
    root.document?.addEventListener?.('visibilitychange', () => {
      if (!root.document.hidden) void pullResult();
    });
    root.addEventListener?.('focus', () => void pullResult());
    void pullResult();
  }
  function mountSettings(container) {
    if (!container || !root.document || !isIOS()) return;
    const card = root.document.createElement('div');
    card.className = 'card';
    card.style.marginTop = '16px';
    card.innerHTML = '<div class="card-title">iPhone Cloud Bridge Sync</div>'
      + '<p style="font-size:12px;color:var(--muted);margin-bottom:10px">Optional. PC and tablet keep their local Bridge flow.</p>'
      + '<label class="form-label">Cloud Worker URL</label><input data-cloud-url class="form-input" type="url" placeholder="https://...workers.dev" autocomplete="off">'
      + '<label class="form-label" style="display:block;margin-top:10px">Pairing key</label><input data-cloud-key class="form-input" type="password" autocomplete="off">'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0"><button data-cloud-generate class="btn btn-outline btn-sm" type="button">Generate key</button>'
      + '<button data-cloud-copy class="btn btn-outline btn-sm" type="button">Copy key</button></div>'
      + '<label style="font-size:12px"><input data-cloud-enable type="checkbox"> Enable Cloud Sync on this device</label>'
      + '<p data-cloud-status style="font-size:11px;color:var(--muted);margin-top:8px" role="status"></p>';
    container.appendChild(card);
    const urlInput = card.querySelector('[data-cloud-url]');
    const keyInput = card.querySelector('[data-cloud-key]');
    const enableInput = card.querySelector('[data-cloud-enable]');
    settingsStatus = card.querySelector('[data-cloud-status]');
    urlInput.value = root.localStorage?.getItem(URL_KEY) || DEFAULT_URL;
    keyInput.value = pairingKey();
    enableInput.checked = root.localStorage?.getItem(ENABLED_KEY) === 'true';
    status(lastStatus);
    const save = () => {
      root.localStorage.setItem(URL_KEY, urlInput.value.trim());
      root.localStorage.setItem(KEY_KEY, keyInput.value.trim());
      root.localStorage.setItem(ENABLED_KEY, String(enableInput.checked));
      if (enableInput.checked && !enabled()) status('Enter a valid HTTPS URL and pairing key.');
      else if (enabled()) { status('Cloud Sync enabled on this device.'); start(); }
      else status('Cloud Sync off');
    };
    urlInput.addEventListener('change', save);
    keyInput.addEventListener('change', save);
    enableInput.addEventListener('change', save);
    card.querySelector('[data-cloud-generate]').addEventListener('click', () => {
      const bytes = root.crypto.getRandomValues(new Uint8Array(32));
      keyInput.value = root.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      save();
      status('Pairing key generated. Copy it into standalone TAR-OBI.');
    });
    card.querySelector('[data-cloud-copy]').addEventListener('click', async () => {
      try { await root.navigator.clipboard.writeText(keyInput.value); status('Pairing key copied.'); }
      catch (_error) { status('Clipboard unavailable; select and copy the key field.'); }
    });
    start();
  }
  return Object.freeze({ URL_KEY, KEY_KEY, ENABLED_KEY, enabled, publishSource, pullResult, mountSettings, start });
});
