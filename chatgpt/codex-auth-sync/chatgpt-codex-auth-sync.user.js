// ==UserScript==
// @name         ChatGPT Codex 登录态同步
// @namespace    https://github.com/i-square/userscripts-hub
// @version      1.1.0
// @author       https://github.com/i-square
// @description  自动提取 ChatGPT 网页会话 Token，组装为 Codex auth.json 并推送到本地/局域网同步服务；支持自动定时推送与手动推送，服务地址/密钥/间隔均可配置
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/i-square/userscripts-hub/main/chatgpt/codex-auth-sync/chatgpt-codex-auth-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/i-square/userscripts-hub/main/chatgpt/codex-auth-sync/chatgpt-codex-auth-sync.user.js
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  /******************** 默认配置（面板中可修改并持久化） ********************/
  const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:18765', // 同步服务地址；跨机器填 http://局域网IP:端口
    syncKey: '',                          // 共享密钥，需与服务端 config.json 中 syncKey 一致
    autoCheck: true,                      // 自动检查（页面加载后及常驻期间定时检查登录态）
    autoPush: true,                       // 自动推送（检查达间隔后自动推送，默认开启）
    initialDelaySec: 3,                   // 页面加载后首次检查的延时（秒）
    recheckMin: 30,                       // 页面常驻期间自动复查间隔（分钟）
    intervalHours: 24,                    // 推送间隔：距上次成功推送超过该小时数才再次推送
  };

  /******************** 配置与状态存取 ********************/
  function loadConfig() {
    return {
      serverUrl: String(GM_getValue('cfg_server_url', DEFAULTS.serverUrl)).replace(/\/+$/, ''),
      syncKey: String(GM_getValue('cfg_sync_key', DEFAULTS.syncKey)),
      autoCheck: Boolean(GM_getValue('cfg_auto_check', DEFAULTS.autoCheck)),
      autoPush: Boolean(GM_getValue('cfg_auto_push', DEFAULTS.autoPush)),
      initialDelaySec: Math.max(1, Number(GM_getValue('cfg_initial_delay_sec', DEFAULTS.initialDelaySec)) || DEFAULTS.initialDelaySec),
      recheckMin: Math.max(1, Number(GM_getValue('cfg_recheck_min', DEFAULTS.recheckMin)) || DEFAULTS.recheckMin),
      intervalHours: Math.max(1, Number(GM_getValue('cfg_interval_hours', DEFAULTS.intervalHours)) || DEFAULTS.intervalHours),
    };
  }

  function saveConfig(cfg) {
    GM_setValue('cfg_server_url', cfg.serverUrl);
    GM_setValue('cfg_sync_key', cfg.syncKey);
    GM_setValue('cfg_auto_check', cfg.autoCheck);
    GM_setValue('cfg_auto_push', cfg.autoPush);
    GM_setValue('cfg_initial_delay_sec', cfg.initialDelaySec);
    GM_setValue('cfg_recheck_min', cfg.recheckMin);
    GM_setValue('cfg_interval_hours', cfg.intervalHours);
  }

  function setState(key, value) { GM_setValue('st_' + key, value); }
  function getState(key, def) { return GM_getValue('st_' + key, def); }

  /******************** 会话提取与 auth.json 组装 ********************/
  async function fetchSession() {
    const res = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + '（未登录或接口变更）');
    const data = await res.json();
    if (!data || !data.accessToken) throw new Error('会话中没有 accessToken，请先登录');
    return data;
  }

  // 解码 JWT payload（兼容 UTF-8）
  function decodeJwtPayload(token) {
    try {
      const part = String(token).split('.')[1];
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(
        atob(b64).split('').map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join('')
      );
      return JSON.parse(json);
    } catch (e) {
      try { return JSON.parse(atob(String(token).split('.')[1])); } catch (e2) { return null; }
    }
  }

  function tokenRemainDays(token) {
    const payload = decodeJwtPayload(token);
    if (!payload || !payload.exp) return null;
    return Math.max(0, Math.round(((payload.exp * 1000 - Date.now()) / 86400000) * 10) / 10);
  }

  // 组装 Codex 期望的 auth.json 结构（id_token 复用 access_token）
  function buildAuthJson(session) {
    const token = session.accessToken;
    const payload = decodeJwtPayload(token) || {};
    const authClaim = payload['https://api.openai.com/auth'] || {};
    return {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: token,
        access_token: token,
        refresh_token: 'rt_mock_token',
        account_id: authClaim.chatgpt_account_id || '',
      },
      last_refresh: new Date().toISOString(),
    };
  }

  /******************** 网络请求（GM_xmlhttpRequest 跨域免 CORS） ********************/
  function gmRequest(method, url, syncKey, bodyObj) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': syncKey },
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        timeout: 15000,
        onload: function (r) {
          let j = null;
          try { j = JSON.parse(r.responseText); } catch (e) { /* 非 JSON 响应 */ }
          if (r.status >= 200 && r.status < 300) resolve(j || {});
          else reject(new Error((j && j.error) || ('HTTP ' + r.status)));
        },
        onerror: function () { reject(new Error('无法连接（服务未启动或地址错误）')); },
        ontimeout: function () { reject(new Error('请求超时')); },
      });
    });
  }

  /******************** 推送逻辑 ********************/
  let pushing = false;

  async function pushNow(manual) {
    if (pushing) return '已有推送任务进行中';
    pushing = true;
    try {
      const cfg = loadConfig();
      const session = await fetchSession();
      const auth = buildAuthJson(session);
      const resp = await gmRequest('POST', cfg.serverUrl + '/push', cfg.syncKey, auth);
      const msg = (manual ? '手动' : '自动') + '推送成功：' + (resp.message || '已写入');
      setState('last_push_at', Date.now());
      setState('last_push_msg', msg);
      return msg;
    } catch (e) {
      const msg = (manual ? '手动' : '自动') + '推送失败：' + (e.message || e);
      setState('last_push_msg', msg);
      return msg;
    } finally {
      pushing = false;
      renderStatus();
    }
  }

  // 单次检查：取会话并刷新状态（手动/自动共用）
  async function checkNow() {
    const session = await fetchSession();
    cachedSession = session;
    const remain = tokenRemainDays(session.accessToken);
    const msg = '已登录，Token 剩余 ' + (remain === null ? '未知' : remain + ' 天');
    setState('last_check_msg', msg);
    return msg;
  }

  // 自动检查：登录状态 + 按间隔决定是否推送
  async function autoTick() {
    const cfg = loadConfig();
    try {
      await checkNow();
      if (!cfg.autoPush) { renderStatus(); return; }
      const lastPushAt = Number(getState('last_push_at', 0));
      if (Date.now() - lastPushAt >= cfg.intervalHours * 3600 * 1000) {
        await pushNow(false);
      }
    } catch (e) {
      setState('last_check_msg', '检查失败：' + (e.message || e));
    }
    renderStatus();
  }

  /******************** 界面：半透明齿轮 + 面板 ********************/
  GM_addStyle(`
    #cgpt-codex-sync-gear {
      position: fixed; right: 20px; bottom: 20px; z-index: 1000000;
      width: 44px; height: 44px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: rgba(15, 23, 42, 0.35);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      cursor: pointer; opacity: 0.45;
      transition: opacity 0.2s ease, transform 0.2s ease, background 0.2s ease;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    }
    #cgpt-codex-sync-gear:hover { opacity: 1; transform: scale(1.08); background: rgba(15, 23, 42, 0.6); }
    #cgpt-codex-sync-gear svg { width: 22px; height: 22px; fill: #fff; }
    #cgpt-codex-sync-gear.busy svg { animation: cgpt-sync-spin 1.2s linear infinite; }
    @keyframes cgpt-sync-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    #cgpt-codex-sync-panel {
      position: fixed; right: 20px; bottom: 76px; z-index: 999999;
      width: 400px; padding: 16px 18px; border-radius: 14px;
      background: rgba(17, 24, 39, 0.82);
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
      color: #e5e7eb; font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      display: none; flex-direction: column; gap: 10px; font-size: 13px;
    }
    #cgpt-codex-sync-panel h3 { margin: 0; font-size: 15px; font-weight: 600; color: #f9fafb; }
    #cgpt-codex-sync-status {
      width: 100%; min-height: 118px; box-sizing: border-box; resize: vertical;
      padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
      background: rgba(0, 0, 0, 0.3); color: #d1d5db;
      font-family: Consolas, "Courier New", monospace; font-size: 12px; line-height: 1.6;
    }
    .cgpt-sync-row { display: flex; gap: 8px; }
    .cgpt-sync-btn {
      flex: 1; padding: 8px 10px; border: none; border-radius: 8px; cursor: pointer;
      color: #fff; font-size: 13px; font-weight: 500; transition: filter 0.15s ease;
    }
    .cgpt-sync-btn:hover { filter: brightness(1.15); }
    .cgpt-sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .cgpt-sync-btn.primary { background: #2563eb; }
    .cgpt-sync-btn.success { background: #059669; }
    .cgpt-sync-btn.secondary { background: #475569; }
    .cgpt-sync-btn.warning { background: #b45309; }
    .cgpt-sync-settings {
      border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .cgpt-sync-field { display: flex; align-items: center; gap: 8px; }
    .cgpt-sync-field label { flex: 0 0 92px; color: #9ca3af; font-size: 12px; }
    .cgpt-sync-field input[type="text"], .cgpt-sync-field input[type="number"], .cgpt-sync-field input[type="password"] {
      flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
      background: rgba(0,0,0,0.3); color: #e5e7eb; font-size: 12px; box-sizing: border-box;
    }
    .cgpt-sync-field input[type="checkbox"] { width: 16px; height: 16px; accent-color: #2563eb; }
    .cgpt-sync-toast {
      position: fixed; right: 20px; bottom: 76px; z-index: 1000001;
      max-width: 360px; padding: 10px 14px; border-radius: 10px;
      background: rgba(17, 24, 39, 0.92); color: #e5e7eb; font-size: 13px;
      border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      opacity: 0; transition: opacity 0.25s ease; pointer-events: none;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    }
  `);

  const gear = document.createElement('div');
  gear.id = 'cgpt-codex-sync-gear';
  gear.title = 'Codex 登录态同步';
  gear.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/></svg>';

  const panel = document.createElement('div');
  panel.id = 'cgpt-codex-sync-panel';

  const toast = document.createElement('div');
  toast.id = 'cgpt-codex-sync-toast';

  document.body.appendChild(gear);
  document.body.appendChild(panel);
  document.body.appendChild(toast);

  let cachedSession = null;
  let toastTimer = null;

  function showToast(text) {
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.style.opacity = '0'; }, 3200);
  }

  function fmtTime(ts) {
    if (!ts) return '从未';
    const d = new Date(Number(ts));
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function statusText() {
    const lines = [];
    if (cachedSession && cachedSession.user) {
      const remain = tokenRemainDays(cachedSession.accessToken);
      lines.push('登录状态：已登录');
      lines.push('账号：' + (cachedSession.user.email || cachedSession.user.name || '未知'));
      lines.push('Token 剩余：' + (remain === null ? '未知' : remain + ' 天'));
    } else {
      lines.push('登录状态：' + getState('last_check_msg', '未检查'));
    }
    lines.push('上次检查：' + getState('last_check_msg', '—'));
    lines.push('上次推送：' + getState('last_push_msg', '从未推送'));
    lines.push('推送时间：' + fmtTime(getState('last_push_at', 0)));
    return lines.join('\n');
  }

  function renderStatus() {
    const area = document.getElementById('cgpt-codex-sync-status');
    if (area) area.value = statusText();
  }

  function buildPanel() {
    panel.innerHTML = '';

    const title = document.createElement('h3');
    title.textContent = 'Codex 登录态同步';
    panel.appendChild(title);

    const status = document.createElement('textarea');
    status.id = 'cgpt-codex-sync-status';
    status.readOnly = true;
    panel.appendChild(status);

    // 操作按钮行
    const row1 = document.createElement('div');
    row1.className = 'cgpt-sync-row';

    const btnCheck = document.createElement('button');
    btnCheck.className = 'cgpt-sync-btn primary';
    btnCheck.textContent = '立即检查';

    const btnPush = document.createElement('button');
    btnPush.className = 'cgpt-sync-btn success';
    btnPush.textContent = '立即推送';

    const btnCopy = document.createElement('button');
    btnCopy.className = 'cgpt-sync-btn secondary';
    btnCopy.textContent = '复制 auth.json';

    const btnTest = document.createElement('button');
    btnTest.className = 'cgpt-sync-btn secondary';
    btnTest.textContent = '测试连接';

    row1.append(btnCheck, btnPush, btnCopy, btnTest);
    panel.appendChild(row1);

    // 设置区
    const cfg = loadConfig();
    const settings = document.createElement('div');
    settings.className = 'cgpt-sync-settings';

    function makeField(labelText, input) {
      const row = document.createElement('div');
      row.className = 'cgpt-sync-field';
      const label = document.createElement('label');
      label.textContent = labelText;
      row.append(label, input);
      return row;
    }
    function makeInput(type, value) {
      const input = document.createElement('input');
      input.type = type;
      if (type === 'checkbox') input.checked = Boolean(value);
      else input.value = value;
      return input;
    }

    const inUrl = makeInput('text', cfg.serverUrl);
    const inKey = makeInput('password', cfg.syncKey);
    const inAutoCheck = makeInput('checkbox', cfg.autoCheck);
    const inAutoPush = makeInput('checkbox', cfg.autoPush);
    const inInitDelay = makeInput('number', cfg.initialDelaySec);
    inInitDelay.min = '1'; inInitDelay.max = '600';
    const inRecheck = makeInput('number', cfg.recheckMin);
    inRecheck.min = '1'; inRecheck.max = '1440';
    const inInterval = makeInput('number', cfg.intervalHours);
    inInterval.min = '1'; inInterval.max = '240';

    settings.append(
      makeField('服务器地址', inUrl),
      makeField('同步密钥', inKey),
      makeField('自动检查', inAutoCheck),
      makeField('自动推送', inAutoPush),
      makeField('首检延时(秒)', inInitDelay),
      makeField('复查间隔(分)', inRecheck),
      makeField('推送间隔(时)', inInterval)
    );

    const row2 = document.createElement('div');
    row2.className = 'cgpt-sync-row';
    const btnSave = document.createElement('button');
    btnSave.className = 'cgpt-sync-btn primary';
    btnSave.textContent = '保存设置';
    const btnHide = document.createElement('button');
    btnHide.className = 'cgpt-sync-btn warning';
    btnHide.textContent = '隐藏面板';
    row2.append(btnSave, btnHide);
    settings.appendChild(row2);

    panel.appendChild(settings);

    // 事件绑定
    btnCheck.addEventListener('click', async function () {
      btnCheck.disabled = true;
      gear.classList.add('busy');
      try {
        const msg = await checkNow();
        showToast(msg);
      } catch (e) {
        setState('last_check_msg', '检查失败：' + (e.message || e));
        showToast('检查失败：' + (e.message || e));
      } finally {
        gear.classList.remove('busy');
        btnCheck.disabled = false;
        renderStatus();
      }
    });

    btnPush.addEventListener('click', async function () {
      btnPush.disabled = true;
      gear.classList.add('busy');
      const msg = await pushNow(true);
      gear.classList.remove('busy');
      btnPush.disabled = false;
      showToast(msg);
    });

    btnCopy.addEventListener('click', async function () {
      try {
        const session = cachedSession || (await fetchSession());
        cachedSession = session;
        GM_setClipboard(JSON.stringify(buildAuthJson(session), null, 2));
        showToast('auth.json 已复制到剪贴板');
      } catch (e) {
        showToast('复制失败：' + (e.message || e));
      }
    });

    btnTest.addEventListener('click', async function () {
      btnTest.disabled = true;
      try {
        await gmRequest('GET', loadConfig().serverUrl + '/health', loadConfig().syncKey);
        showToast('连接成功，服务在线');
      } catch (e) {
        showToast('连接失败：' + (e.message || e));
      } finally {
        btnTest.disabled = false;
      }
    });

    btnSave.addEventListener('click', function () {
      saveConfig({
        serverUrl: inUrl.value.trim().replace(/\/+$/, '') || DEFAULTS.serverUrl,
        syncKey: inKey.value.trim(),
        autoCheck: inAutoCheck.checked,
        autoPush: inAutoPush.checked,
        initialDelaySec: Math.max(1, Number(inInitDelay.value) || DEFAULTS.initialDelaySec),
        recheckMin: Math.max(1, Number(inRecheck.value) || DEFAULTS.recheckMin),
        intervalHours: Math.max(1, Number(inInterval.value) || DEFAULTS.intervalHours),
      });
      scheduleTimers(); // 按新配置重排自动检查定时器
      showToast('设置已保存');
    });

    btnHide.addEventListener('click', function () {
      panel.style.display = 'none';
    });

    renderStatus();
  }

  gear.addEventListener('click', function () {
    if (panel.style.display === 'flex') {
      panel.style.display = 'none';
    } else {
      if (!panel.dataset.built) { buildPanel(); panel.dataset.built = '1'; }
      renderStatus();
      panel.style.display = 'flex';
      // 打开面板时若缓存超过 5 分钟，后台静默刷新一次登录状态
      autoTickSilent();
    }
  });

  // 静默检查（不触发推送，仅更新状态显示）
  let lastSilentCheck = 0;
  async function autoTickSilent() {
    if (Date.now() - lastSilentCheck < 5 * 60 * 1000) return;
    lastSilentCheck = Date.now();
    try {
      cachedSession = await fetchSession();
      const remain = tokenRemainDays(cachedSession.accessToken);
      setState('last_check_msg', '已登录，Token 剩余 ' + (remain === null ? '未知' : remain + ' 天'));
    } catch (e) {
      setState('last_check_msg', '检查失败：' + (e.message || e));
    }
    renderStatus();
  }

  /******************** 启动：按配置调度自动检查（可在面板修改并重排） ********************/
  let initialTimer = null;
  let recheckTimer = null;

  function scheduleTimers() {
    clearTimeout(initialTimer);
    clearInterval(recheckTimer);
    const cfg = loadConfig();
    if (!cfg.autoCheck) return; // 关闭自动检查时仅保留手动操作
    initialTimer = setTimeout(autoTick, cfg.initialDelaySec * 1000);
    recheckTimer = setInterval(autoTick, cfg.recheckMin * 60 * 1000);
  }

  scheduleTimers();
})();