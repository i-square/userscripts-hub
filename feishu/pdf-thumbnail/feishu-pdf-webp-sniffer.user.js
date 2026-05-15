// ==UserScript==
// @name         飞书PDF缩略图嗅探+一键下载
// @namespace    https://github.com/i-square/userscripts-hub
// @version      0.1.0
// @author       https://github.com/i-square
// @description  抓取禁止下载的PDF缩略图；文件名用 data-number顺序命名；支持动态加载和抓取；过滤指定尺寸小图
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/i-square/userscripts-hub/main/feishu/pdf-thumbnail/feishu-pdf-webp-sniffer.user.js
// @downloadURL  https://raw.githubusercontent.com/i-square/userscripts-hub/main/feishu/pdf-thumbnail/feishu-pdf-webp-sniffer.user.js
// @match        https://*.feishu.cn/wiki/*
// @match        https://*.larksuite.com/wiki/*
// @run-at       document-start
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  /******************** 可调配置 ********************/
  const DEFAULT_CONFIG = {
    // 只抓 webp
    onlyWebp: true,

    // 过滤小图阈值（字节）
    minBytes: 1024,

    // 批量下载间隔
    downloadDelayMs: 180,

    // 是否另存为弹窗
    saveAs: false,

    // 扫描防抖
    scanDebounceMs: 200,

    // 调试日志
    verbose: false,
  };

  function loadConfig() {
    try {
      const saved = GM_getValue('config', {});
      if (saved && typeof saved === 'object') {
        return { ...DEFAULT_CONFIG, ...saved };
      }
    } catch {}
    return { ...DEFAULT_CONFIG };
  }

  function persistConfig() {
    try {
      GM_setValue('config', CONFIG);
      return true;
    } catch {
      return false;
    }
  }

  let CONFIG = loadConfig();

  const log = (...args) => CONFIG.verbose && console.log('[TM-PDF-WEBP]', ...args);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function sanitizeFilename(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 180);
  }

  // data:image/webp;base64,xxxx
  function parseDataUri(src) {
    const m = src.match(/^data:([^;]+);base64,(.*)$/i);
    if (!m) return null;
    return { mime: (m[1] || '').toLowerCase(), b64: m[2] || '' };
  }

  function estimateBytesFromBase64(b64) {
    const len = b64.length;
    let padding = 0;
    if (b64.endsWith('==')) padding = 2;
    else if (b64.endsWith('=')) padding = 1;
    return Math.max(0, Math.floor(len * 3 / 4) - padding);
  }

  function shortDataHint(src) {
    const p = parseDataUri(src);
    if (!p) return '[data-uri]';
    const b64 = p.b64;
    return `data:${p.mime};base64,(${b64.length} chars) ${b64.slice(0, 18)}...${b64.slice(-18)}`;
  }

  // GM_download 下载 data:URL（优先尝试）
  function gmDownload(url, filename) {
    return new Promise((resolve, reject) => {
      GM_download({
        url,
        name: filename,
        saveAs: CONFIG.saveAs,
        // data: 不需要 cookie；这里无所谓 anonymous
        onload: () => resolve(true),
        onerror: (e) => reject(e),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // fetch(dataUri) -> blob -> a[download] 兜底
  async function dataUriToBlob(dataUri) {
    const res = await fetch(dataUri);
    return await res.blob();
  }

  function anchorDownload(blobUrl, filename) {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /******************** 核心存储：按 pageNo（data-number）存一份最优图 ********************/
  // key = page|19
  // item: { key, pageNo, src(dataUri), mime, bytes, domOrder, firstSeen, lastSeenAt }
  const store = new Map();
  let firstSeenCounter = 0;

  function upsertBest(item) {
    const old = store.get(item.key);
    if (!old) {
      store.set(item.key, item);
      return item;
    }

    // 更新位置/时间
    old.domOrder = item.domOrder ?? old.domOrder;
    old.lastSeenAt = Date.now();

    // 选择更“好”的：bytes 更大优先（避免同页重复渲染时大小不同）
    const oldBytes = old.bytes || 0;
    const newBytes = item.bytes || 0;

    if (newBytes > oldBytes) {
      old.src = item.src;
      old.mime = item.mime;
      old.bytes = item.bytes;
    }

    store.set(item.key, old);
    return old;
  }

  /******************** DOM 扫描：优先 wrapper[data-number] ********************/
  function getScanRoot() {
    return document.querySelector('.box-preview-wrapper')
      || document.querySelector('#mainContainer')
      || document.body;
  }

  function extractPageNo(wrapper) {
    const dn = wrapper?.getAttribute?.('data-number');
    if (!dn) return null;
    const n = Number(dn);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return null;
  }

  function shouldTakeDataWebp(src) {
    const p = parseDataUri(src);
    if (!p) return false;
    if (CONFIG.onlyWebp && p.mime !== 'image/webp') return false;
    const bytes = estimateBytesFromBase64(p.b64);
    if (bytes < CONFIG.minBytes) return false;
    return true;
  }

  function getImgSrc(img) {
    return img?.currentSrc || img?.src || img?.getAttribute?.('src') || '';
  }

  function scanDom(reason = '') {
    if (!isActive) return;
    const root = getScanRoot();
    if (!root) return;

    // 关键：按缩略图 wrapper 扫描
    const wrappers = root.querySelectorAll('[data-sel="box-preview-pdf-thumbnail-wrapper"][data-number]');
    let domValidCount = 0;

    if (wrappers && wrappers.length) {
      let domOrder = 0;

      wrappers.forEach((wrapper) => {
        const pageNo = extractPageNo(wrapper);
        if (!pageNo) return;

        const img = wrapper.querySelector('img');
        if (!img) return;

        const src = getImgSrc(img);
        if (!src) return;

        // 只收 data:webp;base64
        if (!src.startsWith('data:')) return;
        if (!shouldTakeDataWebp(src)) return;

        const p = parseDataUri(src);
        const bytes = estimateBytesFromBase64(p.b64);

        domOrder += 1;
        domValidCount += 1;

        const key = `page|${pageNo}`;

        upsertBest({
          key,
          pageNo,
          src, // 保存完整 dataUri，防止虚拟滚动卸载后丢失
          mime: p.mime,
          bytes,
          domOrder,
          firstSeen: store.has(key) ? store.get(key).firstSeen : (++firstSeenCounter),
          lastSeenAt: Date.now(),
        });
      });

      log(`scanDom(${reason}) wrappers=${wrappers.length} valid=${domValidCount} store=${store.size}`);
    } else {
      // 兜底：如果页面结构变化，仍扫所有 img（但无法保证有 pageNo）
      const imgs = root.querySelectorAll('img');
      let domOrder = 0;
      imgs.forEach((img) => {
        const src = getImgSrc(img);
        if (!src || !src.startsWith('data:')) return;
        if (!shouldTakeDataWebp(src)) return;

        const wrapper = img.closest('[data-number]');
        const pageNo = extractPageNo(wrapper);
        if (!pageNo) return;

        const p = parseDataUri(src);
        const bytes = estimateBytesFromBase64(p.b64);

        domOrder += 1;
        domValidCount += 1;

        const key = `page|${pageNo}`;
        upsertBest({
          key, pageNo, src, mime: p.mime, bytes, domOrder,
          firstSeen: store.has(key) ? store.get(key).firstSeen : (++firstSeenCounter),
          lastSeenAt: Date.now(),
        });
      });
    }

    updateUI(domValidCount);
  }

  // 防抖扫描
  let scanTimer = null;
  function scheduleScan(reason = '') {
    if (!isActive) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanDom(reason);
    }, CONFIG.scanDebounceMs);
  }

  function startMutationObserver() {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          if (m.addedNodes && m.addedNodes.length) {
            scheduleScan('childList');
            break;
          }
        } else if (m.type === 'attributes') {
          if (m.attributeName === 'src' || m.attributeName === 'srcset') {
            scheduleScan('attr');
            break;
          }
        }
      }
    });

    const start = () => {
      mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'srcset'],
      });
      scanDom('init');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  /******************** 下载列表：按 pageNo 排序，文件名用 pageNo.webp ********************/
  function buildDownloadList() {
    // 下载前强制扫一次，保证最新
    scanDom('beforeDownload');

    const items = [...store.values()]
      .filter(it => it && it.src && it.mime === 'image/webp' && (it.bytes || 0) >= CONFIG.minBytes);

    items.sort((a, b) => (a.pageNo || 0) - (b.pageNo || 0));

    // 避免文件名冲突（极少发生）
    const used = new Map();

    return items.map(it => {
      const base = `${it.pageNo}.webp`;
      const safe = sanitizeFilename(base);
      const cnt = used.get(safe) || 0;
      used.set(safe, cnt + 1);
      const filename = cnt === 0 ? safe : safe.replace(/\.webp$/i, `_${cnt + 1}.webp`);
      return { ...it, filename };
    });
  }

  let downloading = false;
  let abortDownload = false;

  async function downloadAll() {
    if (downloading) return;

    const list = buildDownloadList();
    if (!list.length) {
      toast('未捕获到有效页图（请先下拉加载更多）');
      return;
    }

    downloading = true;
    abortDownload = false;
    updateUI();

    toast(`开始下载：${list.length} 张`);
    setBtnText(`下载中 0/${list.length}`);

    let ok = 0, fail = 0;

    for (let i = 0; i < list.length; i++) {
      if (abortDownload) break;

      const it = list[i];
      const filename = it.filename;

      try {
        // 1) 优先 GM_download 直接下 data:URL（最省事）
        try {
          await gmDownload(it.src, filename);
        } catch (e1) {
          // 2) 不行就 fetch -> blob -> a[download]
          const blob = await dataUriToBlob(it.src);
          const blobUrl = URL.createObjectURL(blob);
          try {
            anchorDownload(blobUrl, filename);
            await sleep(80);
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        }

        ok++;
      } catch (e) {
        fail++;
        console.warn('[TM-PDF-WEBP] 下载失败：', filename, e);
      }

      setBtnText(`下载中 ${i + 1}/${list.length}`);
      await sleep(CONFIG.downloadDelayMs);
    }

    downloading = false;
    setBtnText('一键下载');
    updateUI();

    toast(abortDownload
      ? `已停止：成功 ${ok}，失败 ${fail}`
      : `完成：成功 ${ok}，失败 ${fail}`
    );
  }

  function stopDownload() {
    abortDownload = true;
  }

  /******************** 列表/复制/导出/清空 ********************/
  function buildListText() {
    const list = buildDownloadList();
    const lines = [];
    lines.push(`# ${location.href}`);
    lines.push(`# 已捕获页图：${store.size} 页；可下载（≥${CONFIG.minBytes}B）：${list.length} 张`);
    lines.push(`# 格式：pageNo\\tfilename\\tbytes\\tsrcHint`);
    lines.push('');
    for (const it of list) {
      lines.push(`${it.pageNo}\t${it.filename}\t${it.bytes}\t${shortDataHint(it.src)}`);
    }
    return lines.join('\n');
  }

  function showList() {
    modalShow(buildListText());
  }

  function copyList() {
    const text = buildListText();
    GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' });
    toast('已复制清单到剪贴板');
  }

  function exportTxt() {
    const text = buildListText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pdf_webp_list_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function clearAll() {
    store.clear();
    firstSeenCounter = 0;
    scanDom('clear');
    toast('已清空');
  }

  /******************** UI ********************/
  let box, countCaptured, countDom, countDomLabel, btnDownload, btnStop;
  let modal, modalBody;
  let settingsModal, settingsBody;
  let trigger, triggerBtn;
  let isActive = false;
  let panelVisible = false;
  let observerStarted = false;
  let triggerHost = null;

  GM_addStyle(`
    #tm_pdfwebp_trigger{
      position:relative; display:inline-flex; align-items:center; margin-left:6px; z-index:999999;
    }
    #tm_pdfwebp_icon{
      width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center;
      background:#2b7cff; color:#fff; border:0; border-radius:7px; cursor:pointer;
      box-shadow:0 6px 18px rgba(0,0,0,.25); font-size:14px;
    }
    #tm_pdfwebp_box{
      position:absolute; right:0; top:100%; margin-top:6px;
      width:285px; background:rgba(18,18,18,0.92); color:#fff;
      border-radius:12px; padding:10px 10px 8px;
      box-shadow:0 12px 34px rgba(0,0,0,.35); font-size:12px; user-select:none;
      display:none;
    }
    #tm_pdfwebp_box .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;}
    #tm_pdfwebp_box .title{font-size:13px;font-weight:800;}
    #tm_pdfwebp_box .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
    #tm_pdfwebp_box button{
      flex:1 1 auto; background:#2b7cff; border:0; color:#fff;
      padding:6px 8px; border-radius:8px; cursor:pointer; font-size:12px;
    }
    #tm_pdfwebp_box button.secondary{background:#444;}
    #tm_pdfwebp_box button.danger{background:#d64545;}
    #tm_pdfwebp_box button:disabled{opacity:.55;cursor:not-allowed;}
    #tm_pdfwebp_box .hint{margin-top:8px;opacity:.8;line-height:1.35;}
    #tm_pdfwebp_box .tools{display:flex; gap:6px; align-items:center;}

    #tm_pdfwebp_modal{
      position:fixed; inset:0; z-index:1000000; background:rgba(0,0,0,.55);
      display:none; align-items:center; justify-content:center; padding:14px;
    }
    #tm_pdfwebp_modal .panel{
      width:min(980px,96vw); height:min(680px,86vh);
      background:#111; color:#fff; border-radius:12px;
      box-shadow:0 12px 40px rgba(0,0,0,.45);
      overflow:hidden; display:flex; flex-direction:column;
    }
    #tm_pdfwebp_modal .head{
      padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08);
      display:flex; align-items:center; justify-content:space-between; gap:10px;
    }
    #tm_pdfwebp_modal .head .left{font-weight:800;}
    #tm_pdfwebp_modal .head .right{display:flex; gap:8px;}
    #tm_pdfwebp_modal .head button{
      background:#2b7cff; border:0; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer; font-size:12px;
    }
    #tm_pdfwebp_modal .head button.secondary{background:#444;}
    #tm_pdfwebp_modal .body{
      padding:10px 12px; overflow:auto; white-space:pre;
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
      font-size:12px; line-height:1.45;
    }

    #tm_pdfwebp_settings{
      position:fixed; inset:0; z-index:1000001; background:rgba(0,0,0,.55);
      display:none; align-items:center; justify-content:center; padding:14px;
    }
    #tm_pdfwebp_settings .panel{
      width:min(560px,92vw);
      background:#111; color:#fff; border-radius:12px;
      box-shadow:0 12px 40px rgba(0,0,0,.45);
      overflow:hidden; display:flex; flex-direction:column;
    }
    #tm_pdfwebp_settings .head{
      padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08);
      display:flex; align-items:center; justify-content:space-between; gap:10px;
    }
    #tm_pdfwebp_settings .body{
      padding:12px; display:grid; gap:10px;
    }
    #tm_pdfwebp_settings label{
      display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:12px;
    }
    #tm_pdfwebp_settings input[type="number"]{
      width:140px; background:#1b1b1b; color:#fff; border:1px solid #333; border-radius:6px; padding:4px 6px;
    }
    #tm_pdfwebp_settings input[type="checkbox"]{transform:scale(1.1);}
    #tm_pdfwebp_settings .actions{
      display:flex; gap:8px; justify-content:flex-end; padding:10px 12px; border-top:1px solid rgba(255,255,255,.08);
    }
    #tm_pdfwebp_settings button{
      background:#2b7cff; border:0; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer; font-size:12px;
    }
    #tm_pdfwebp_settings button.secondary{background:#444;}
  `);

  function buildUI() {
    trigger = document.createElement('span');
    trigger.id = 'tm_pdfwebp_trigger';
    trigger.innerHTML = `
      <button id="tm_pdfwebp_icon" title="嗅探页图">🔍</button>
      <div id="tm_pdfwebp_box"></div>
    `;
    triggerBtn = trigger.querySelector('#tm_pdfwebp_icon');

    box = document.createElement('div');
    box.id = 'tm_pdfwebp_box';
    box.innerHTML = `
      <div class="row">
        <div class="title">🖼️ PDF页图嗅探</div>
        <div class="tools">
          <button id="tm_settings" class="secondary" title="设置">⚙️</button>
          <span>已捕获 <b id="tm_captured">0</b> 页</span>
        </div>
      </div>
      <div class="row">
        <div id="tm_domlabel">DOM当前(≥${CONFIG.minBytes}B) <b id="tm_domcount">0</b></div>
        <div style="opacity:.75;">命名：data-number.webp</div>
      </div>
      <div class="btns">
        <button id="tm_download">一键下载</button>
        <button id="tm_stop" class="danger" disabled>停止</button>
        <button id="tm_scan" class="secondary">重新扫描</button>
        <button id="tm_list" class="secondary">查看列表</button>
        <button id="tm_copy" class="secondary">复制清单</button>
        <button id="tm_export" class="secondary">导出TXT</button>
        <button id="tm_clear" class="secondary">清空</button>
      </div>
      <div class="hint">
        下拉加载更多缩略图，捕获页数会增长；<br/>
        拉到底后点“一键下载”，文件名如 19.webp。
      </div>
    `;
    trigger.querySelector('#tm_pdfwebp_box').replaceWith(box);

    countCaptured = box.querySelector('#tm_captured');
    countDom = box.querySelector('#tm_domcount');
    countDomLabel = box.querySelector('#tm_domlabel');
    btnDownload = box.querySelector('#tm_download');
    btnStop = box.querySelector('#tm_stop');

    btnDownload.addEventListener('click', downloadAll);
    btnStop.addEventListener('click', stopDownload);
    box.querySelector('#tm_scan').addEventListener('click', () => scanDom('manual'));
    box.querySelector('#tm_list').addEventListener('click', showList);
    box.querySelector('#tm_copy').addEventListener('click', copyList);
    box.querySelector('#tm_export').addEventListener('click', exportTxt);
    box.querySelector('#tm_clear').addEventListener('click', clearAll);
    box.querySelector('#tm_settings').addEventListener('click', openSettings);

    // modal
    modal = document.createElement('div');
    modal.id = 'tm_pdfwebp_modal';
    modal.innerHTML = `
      <div class="panel">
        <div class="head">
          <div class="left">资源清单</div>
          <div class="right">
            <button id="tm_modal_copy">复制</button>
            <button id="tm_modal_close" class="secondary">关闭</button>
          </div>
        </div>
        <div class="body" id="tm_modal_body"></div>
      </div>
    `;
    document.documentElement.appendChild(modal);

    modalBody = modal.querySelector('#tm_modal_body');
    modal.querySelector('#tm_modal_close').addEventListener('click', () => (modal.style.display = 'none'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    modal.querySelector('#tm_modal_copy').addEventListener('click', () => {
      GM_setClipboard(modalBody.textContent || '', { type: 'text', mimetype: 'text/plain' });
      toast('已复制');
    });

    // settings modal
    settingsModal = document.createElement('div');
    settingsModal.id = 'tm_pdfwebp_settings';
    settingsModal.innerHTML = `
      <div class="panel">
        <div class="head">
          <div>设置</div>
          <button id="tm_settings_close" class="secondary">关闭</button>
        </div>
        <div class="body" id="tm_settings_body"></div>
        <div class="actions">
          <button id="tm_settings_cancel" class="secondary">取消</button>
          <button id="tm_settings_save">保存</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(settingsModal);
    settingsBody = settingsModal.querySelector('#tm_settings_body');
    settingsModal.querySelector('#tm_settings_close').addEventListener('click', closeSettings);
    settingsModal.querySelector('#tm_settings_cancel').addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
    settingsModal.querySelector('#tm_settings_save').addEventListener('click', saveSettings);

    triggerBtn.addEventListener('click', togglePanel);
  }

  function setBtnText(text) {
    if (btnDownload) btnDownload.textContent = text;
  }

  function updateUI(domNowCount = null) {
    if (!countCaptured) return;
    countCaptured.textContent = String(store.size);
    if (typeof domNowCount === 'number') countDom.textContent = String(domNowCount);

    if (downloading) {
      btnDownload.disabled = true;
      btnStop.disabled = false;
    } else {
      btnDownload.disabled = false;
      btnStop.disabled = true;
    }
  }

  function modalShow(text) {
    modalBody.textContent = text || '';
    modal.style.display = 'flex';
  }

  function toast(msg) {
    try {
      const title = box.querySelector('.title');
      const old = title.textContent;
      title.textContent = msg;
      setTimeout(() => { title.textContent = old; }, 1100);
    } catch {}
  }

  function openSettings() {
    settingsBody.innerHTML = `
      <label>仅抓 WebP <input type="checkbox" id="tm_set_onlyWebp" ${CONFIG.onlyWebp ? 'checked' : ''}></label>
      <label>过滤阈值(字节) <input type="number" id="tm_set_minBytes" min="0" step="1" value="${CONFIG.minBytes}"></label>
      <label>下载间隔(ms) <input type="number" id="tm_set_delay" min="0" step="10" value="${CONFIG.downloadDelayMs}"></label>
      <label>扫描防抖(ms) <input type="number" id="tm_set_debounce" min="0" step="10" value="${CONFIG.scanDebounceMs}"></label>
      <label>另存为弹窗 <input type="checkbox" id="tm_set_saveAs" ${CONFIG.saveAs ? 'checked' : ''}></label>
      <label>调试日志 <input type="checkbox" id="tm_set_verbose" ${CONFIG.verbose ? 'checked' : ''}></label>
    `;
    settingsModal.style.display = 'flex';
  }

  function closeSettings() {
    settingsModal.style.display = 'none';
  }

  function saveSettings() {
    const next = {
      ...CONFIG,
      onlyWebp: Boolean(settingsBody.querySelector('#tm_set_onlyWebp')?.checked),
      minBytes: Number(settingsBody.querySelector('#tm_set_minBytes')?.value || CONFIG.minBytes),
      downloadDelayMs: Number(settingsBody.querySelector('#tm_set_delay')?.value || CONFIG.downloadDelayMs),
      scanDebounceMs: Number(settingsBody.querySelector('#tm_set_debounce')?.value || CONFIG.scanDebounceMs),
      saveAs: Boolean(settingsBody.querySelector('#tm_set_saveAs')?.checked),
      verbose: Boolean(settingsBody.querySelector('#tm_set_verbose')?.checked),
    };
    CONFIG = next;
    const ok = persistConfig();
    if (countDomLabel) {
      countDomLabel.innerHTML = `DOM当前(≥${CONFIG.minBytes}B) <b id="tm_domcount">${countDom?.textContent || '0'}</b>`;
      countDom = countDomLabel.querySelector('#tm_domcount');
    }
    closeSettings();
    toast(ok ? '设置已保存' : '设置已应用');
  }

  function togglePanel() {
    panelVisible = !panelVisible;
    box.style.display = panelVisible ? 'block' : 'none';
    if (panelVisible) activate();
  }

  function activate() {
    if (observerStarted) return;
    isActive = true;
    observerStarted = true;
    startMutationObserver();
  }

  function isDownloadBtnDisabled(btn) {
    return !!(btn && (btn.disabled || btn.getAttribute('disabled') !== null));
  }

  function findDisabledDownloadBtn() {
    const icon = document.querySelector('svg[data-icon="DownloadOutlined"]');
    const btn = icon?.closest('button');
    if (btn && isDownloadBtnDisabled(btn)) return btn;
    const alt = document.querySelector('button[disabled].ud__button--disabled');
    return isDownloadBtnDisabled(alt) ? alt : null;
  }

  function ensureTrigger() {
    const btn = findDisabledDownloadBtn();
    if (!btn) {
      if (trigger?.isConnected) {
        box.style.display = 'none';
        trigger.remove();
        triggerHost = null;
      }
      return;
    }
    const host = btn.closest('span') || btn;
    if (trigger?.isConnected && triggerHost === host) return;
    triggerHost = host;
    host.insertAdjacentElement('afterend', trigger);
  }

  function startTriggerObserver() {
    const mo = new MutationObserver(() => ensureTrigger());
    const start = () => {
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      ensureTrigger();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  /******************** 启动 + 调试口子 ********************/
  function exposeDebug() {
    const api = {
      scanNow: () => scanDom('console'),
      dump: () => [...store.values()].sort((a,b)=>a.pageNo-b.pageNo),
      count: () => ({ pages: store.size }),
      config: CONFIG,
    };
    try {
      (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__TM_PDF_WEBP__ = api;
    } catch {}
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(() => {
    buildUI();
    updateUI(0);
    startTriggerObserver();
    exposeDebug();
  });

})();
