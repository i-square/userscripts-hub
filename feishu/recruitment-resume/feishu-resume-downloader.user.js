// ==UserScript==
// @name         飞书招聘｜完整简历图片与 PDF 下载
// @namespace    https://github.com/i-square/userscripts-hub
// @version      1.0.4
// @author       https://github.com/i-square
// @description  在简历「全屏」左侧添加“下载”按钮和设置图标；支持完整长图、逐页图片、原 PDF 及同时下载。仅处理当前选中附件。
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/i-square/userscripts-hub/main/feishu/recruitment-resume/feishu-resume-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/i-square/userscripts-hub/main/feishu/recruitment-resume/feishu-resume-downloader.user.js
// @match        https://*.feishu.cn/hire/*
// @match        http://*.feishu.cn/hire/*
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * 使用：保存并刷新飞书招聘网页，点击「下载」；旁边的齿轮图标可选择图片/PDF/两者。
 * 主路径不依赖外部库：读取当前附件元数据 -> 同源获取整页图片 -> 原生 Canvas 拼接。
 * PDF 原文件原样保存；图片附件可生成图片型 PDF（不声称具有文字层）。
 * 仅当服务器没有整页图片时，尝试复用飞书页面已有的 PDF.js，且关闭 eval。
 * 仅在需要读取职位/候选人姓名时短暂读取飞书 CSRF token，不记录 token；不拦截页面请求，不上传简历，不保存候选人数据或临时链接。
 * 仅用于你有权导出、保存的候选人简历，并遵守企业的数据管理要求。
 */
(() => {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const D = W.document;
  const PREFIX = 'fs-resume-export';
  const SETTINGS_KEY = `${PREFIX}:settings:v1`;
  const DEFAULTS = Object.freeze({
    image: true, pdf: true, imageType: 'png', layout: 'long',
    longPolicy: 'split', quality: 3, jpegQuality: 0.95
  });
  // 保守的单画布预算，而不是声称所有浏览器都具有相同的尺寸上限。
  const LIMIT = Object.freeze({ side: 28000, pixels: 48000000, pages: 300, bytes: 256 * 1024 * 1024 });
  // 这些页面结构及 PDF 适配点来自此次 HAR 中的前端代码；飞书改版时可能需要更新。
  const SITE = Object.freeze({
    toolbar: '#talentDetail [class*="toolbarRight__"], #talentDetail [class*="toolbarRight"]',
    preview: '#talentDetail [class*="filePreview__"], #talentDetail [class*="preview-container"], .fullscreenPreviewer-content',
    previewAPI: '/atsx/api/talent/attachment/preview/urls/',
    webpackQueue: 'webpackChunktalentDetail_', pdfModule: 177085, pdfExport: 'lf'
  });
  const groups = new Map();
  let busy = false;
  let settingsModal = null;
  let resultModal = null;
  let activeJob = null;

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const txt = value => typeof value === 'string' ? value : '';
  const id = value => typeof value === 'string' && /^\d{5,30}$/.test(value) ? value : '';
  const message = error => String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[临时地址已隐藏]').slice(0, 500);
  const abortError = () => new DOMException('操作已取消。', 'AbortError');

  function preferences() {
    let value = {};
    try { value = GM_getValue(SETTINGS_KEY, {}) || {}; } catch (_) { /* 使用默认值。 */ }
    const p = { ...DEFAULTS, ...value };
    p.image = !!p.image; p.pdf = !!p.pdf;
    if (!p.image && !p.pdf) p.image = p.pdf = true;
    if (!['png', 'jpeg'].includes(p.imageType)) p.imageType = 'png';
    if (!['long', 'pages'].includes(p.layout)) p.layout = 'long';
    if (!['split', 'single'].includes(p.longPolicy)) p.longPolicy = 'split';
    p.quality = [1, 2, 3].includes(Number(p.quality)) ? Number(p.quality) : 3;
    p.jpegQuality = 0.95;
    return p;
  }

  function element(tag, text, parent) {
    const e = D.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function settingsIcon() {
    const svg = D.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = D.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.37-.31-.6-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98L14.5 2.42C14.47 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.5.42L9.12 5.07c-.61.25-1.18.59-1.69.98l-2.49-1c-.23-.08-.48 0-.6.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.37.31.6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.61-.25 1.18-.58 1.69-.98l2.49 1c.23.08.48 0 .6-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z');
    svg.appendChild(path);
    return svg;
  }

  function installControlStyles() {
    const styleId = `${PREFIX}-style`;
    if (D.getElementById(styleId)) return;
    const style = element('style', undefined, D.head || D.documentElement);
    style.id = styleId;
    style.textContent = `
      [data-${PREFIX}="toolbar"] {
        display: inline-flex !important;
        align-items: center !important;
        gap: 4px !important;
        flex-shrink: 0 !important;
        white-space: nowrap !important;
        opacity: .45 !important;
        transition: opacity 200ms ease, transform 200ms ease !important;
      }
      [data-${PREFIX}="toolbar"]:hover,
      [data-${PREFIX}="toolbar"]:focus-within {
        opacity: 1 !important;
      }
      [data-${PREFIX}="toolbar"] button {
        box-sizing: border-box !important;
        height: 24px !important;
        cursor: pointer !important;
        border-radius: 6px !important;
        font-size: 12px !important;
        line-height: 1.5 !important;
        white-space: nowrap !important;
      }
      [data-${PREFIX}="toolbar"] button:first-child {
        padding: 3px 10px !important;
        border: 1px solid rgba(22, 119, 255, .35) !important;
        background: #1677ff !important;
        color: #fff !important;
      }
      [data-${PREFIX}="toolbar"] button:first-child:hover {
        background: #4096ff !important;
      }
      [data-${PREFIX}="toolbar"] button:nth-child(2) {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 24px !important;
        padding: 2px !important;
        border: 0 !important;
        background: transparent !important;
        color: #1677ff !important;
      }
      [data-${PREFIX}="toolbar"] button:nth-child(2):hover {
        background: rgba(22, 119, 255, .1) !important;
      }
      [data-${PREFIX}="toolbar"] button:nth-child(2) svg {
        display: block !important;
        width: 16px !important;
        height: 16px !important;
      }
      [data-${PREFIX}="toolbar"] button:disabled {
        cursor: wait !important;
        opacity: .7 !important;
      }
    `;
  }

  function visible(e) {
    if (!e?.isConnected || !e.getClientRects().length) return false;
    const style = W.getComputedStyle(e);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function currentFiber(node) {
    try {
      const key = Object.keys(node).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      let fiber = key ? node[key] : null;
      if (!fiber) return null;
      // React 更新会交替使用两棵 Fiber 树，优先选择已提交的那一棵。
      let root = fiber;
      for (let i = 0; root.return && i < 150; i++) root = root.return;
      if (root.stateNode?.current && root.stateNode.current !== root && fiber.alternate) fiber = fiber.alternate;
      return fiber;
    } catch (_) { return null; }
  }

  function ancestorProps(node, visit, max = 70) {
    const seen = new Set();
    for (let e = node, d = 0; e && d < 5; e = e.parentElement, d++) {
      let fiber = currentFiber(e);
      for (let n = 0; fiber && n < max && !seen.has(fiber); n++, fiber = fiber.return) {
        seen.add(fiber);
        const p = fiber.memoizedProps;
        if (p && typeof p === 'object') {
          const answer = visit(p);
          if (answer) return answer;
        }
      }
    }
    return null;
  }

  function fullScreenButton(toolbar) {
    for (const b of toolbar.querySelectorAll('button, [role="button"]')) {
      if (b.closest(`[data-${PREFIX}]`) || !visible(b)) continue;
      const labels = [b.getAttribute('title'), b.getAttribute('aria-label'), b.textContent].filter(Boolean);
      const label = ancestorProps(b, p => {
        const t = txt(p.title) || txt(p['aria-label']);
        return /^(全屏|全屏预览|Full\s*screen)$/i.test(t.trim()) ? t : null;
      }, 12);
      if (label || labels.some(s => /^(全屏|全屏预览|Full\s*screen)$/i.test(s.trim()))) return b;
    }
    return null;
  }

  function routeTalent() {
    const u = new URL(W.location.href);
    const match = (u.pathname + u.hash).match(/\/(?:hire\/)?talent\/(\d{5,30})(?:[/?#]|$)/);
    return match?.[1] || id(u.searchParams.get('talent_id')) || id(u.searchParams.get('talentId'));
  }

  function cloneInfo(value) {
    const v = value || {};
    const p = v.pdf_preview_info;
    const preview = {};
    if (p && typeof p === 'object') {
      for (const k of ['image_x1_url_list', 'image_x2_url_list', 'image_x3_url_list',
        'webp_x1_url_list', 'webp_x2_url_list', 'webp_x3_url_list']) {
        if (Array.isArray(p[k])) preview[k] = Array.from(p[k], x => txt(x));
      }
      if (Array.isArray(p.page_meta_list)) preview.pageCount = p.page_meta_list.length;
    }
    return {
      fileId: id(v.id), attachmentId: id(v.attachment_resume_id),
      url: txt(v.url), name: txt(v.origin_name) || txt(v.name),
      extension: txt(v.extension) || txt(v.fileExtension) || txt(v.mineType),
      mime: txt(v.mime), preview
    };
  }

  function activeResumeProps(node) {
    // 不单纯信任 host Fiber 的 return 指针：React bailout 可能复用仍指向旧父级的子树。
    // 从 root.current 出发读取已提交树，再用真实 DOM 包含关系确认属于哪个简历面板。
    let root = currentFiber(node);
    for (let i = 0; root?.return && i < 180; i++) root = root.return;
    const committed = root?.stateNode?.current;
    if (committed?.child) {
      const containsNode = component => {
        const pending = component.child ? [component.child] : [];
        for (let i = 0; pending.length && i < 3000; i++) {
          const f = pending.pop();
          if (f.sibling) pending.push(f.sibling);
          const host = f.stateNode;
          if (host?.nodeType === 1) {
            if (host === node || host.contains(node)) return true;
            // 当前 DOM 子树不包含目标，不必再展开这棵子树。
          } else if (f.child) pending.push(f.child);
        }
        return false;
      };
      const pending = [[committed, '']];
      for (let i = 0; pending.length && i < 40000; i++) {
        const [f, inherited] = pending.pop();
        const p = f.memoizedProps || {};
        const talent = id(p.talentId) || id(p.talent_id) || inherited;
        if (p.resumeInfo && Object.prototype.hasOwnProperty.call(p, 'selectedAttachmentId') && containsNode(f)) {
          return { props: p, talent };
        }
        if (f.sibling) pending.push([f.sibling, inherited]);
        if (f.child) pending.push([f.child, talent]);
      }
      return null; // 已提交树中无法确认归属时，宁可停止，不回退到旧树猜测。
    }
    let talent = '';
    return ancestorProps(node, p => {
      talent ||= id(p.talentId) || id(p.talent_id);
      return p.resumeInfo && Object.prototype.hasOwnProperty.call(p, 'selectedAttachmentId')
        ? { props: p, talent } : null;
    });
  }

  function readContext(node) {
    if (!node?.isConnected) return null;
    const found = activeResumeProps(node);
    if (!found) return null;
    const selected = id(found.props.selectedAttachmentId);
    if (!selected) return null;
    const info = cloneInfo(found.props.resumeInfo);
    const routeID = routeTalent();
    if (routeID && found.talent && routeID !== found.talent) return null;
    // 切换附件但数据尚未更新时，不沿用上一份简历的 URL/文件名。
    return {
      selected, info: info.attachmentId === selected ? info : null, node,
      talent: routeID || found.talent || ancestorProps(node, p => id(p.talentId) || id(p.talent_id)),
      route: W.location.href
    };
  }

  function locateContext(anchor) {
    let context = readContext(anchor);
    if (context) return context;
    // 菜单入口或工具栏被改版时，寻找可见预览组件；不使用“最后出现的 PDF URL”。
    const found = [];
    for (const e of D.querySelectorAll(SITE.preview)) {
      if (!visible(e)) continue;
      context = readContext(e);
      if (context && !found.some(x => x.selected === context.selected && x.talent === context.talent)) found.push(context);
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error('页面中有多个候选人预览，无法确定当前附件。请在对应简历工具栏点击下载。');
    throw new Error('未能读取当前选中的简历附件。请等待预览完成后刷新重试；若仍失败，可能是飞书页面结构已改版。');
  }

  function check(job) {
    if (job.controller.signal.aborted) throw abortError();
    if (!job.context) return;
    if (W.location.href !== job.context.route) throw new Error('下载期间页面已切换，已停止，避免混入其他候选人的简历。');
    const now = readContext(job.context.node);
    if (!now || now.selected !== job.context.selected || now.talent !== job.context.talent) {
      throw new Error('当前附件已切换或预览已关闭，已停止本次导出。');
    }
  }

  function trustedURL(value, api = false) {
    const u = new URL(value, W.location.href);
    if (u.origin !== W.location.origin || u.protocol !== 'https:' || u.username || u.password) {
      throw new Error('文件地址不是当前飞书域名。当前版本只读取同源文件，不进行跨域凭据转发。');
    }
    if (api ? u.pathname !== SITE.previewAPI : !u.pathname.startsWith('/hire/file/blob/')) {
      throw new Error('附件地址格式与当前适配版本不一致，未发起该请求。');
    }
    return u.href;
  }

  async function request(value, job, api = false) {
    check(job);
    const url = trustedURL(value, api);
    const control = new AbortController();
    const cancel = () => control.abort();
    job.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 90000);
    try {
      const response = await W.fetch(url, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: api ? 'no-store' : 'default', signal: control.signal
      });
      if (!response.ok) {
        const extra = [401, 403].includes(response.status)
          ? '登录可能已过期或当前账号无权读取，请刷新并确认权限。'
          : '请确认附件仍可正常预览后重试。';
        const e = new Error(`读取${api ? '附件信息' : '文件'}失败（HTTP ${response.status}）。${extra}`);
        e.status = response.status; throw e;
      }
      const length = Number(response.headers.get('content-length') || 0);
      if (length > LIMIT.bytes) throw new Error('单个文件超过 256 MB 的保护上限，已停止读取。');
      if (api) {
        const body = await response.json();
        if (body.success === false || (body.code !== undefined && Number(body.code) !== 0)) {
          throw new Error('飞书拒绝或未完成此次附件读取，请刷新页面并确认当前账号权限。');
        }
        check(job);
        return body.data;
      }
      const blob = await response.blob();
      if (!blob.size || blob.size > LIMIT.bytes) throw new Error('文件为空或超过 256 MB 的保护上限。');
      // 不手工重放 Range / If-None-Match，且绝不将一段 206 响应当完整文件保存。
      if (response.status === 206) {
        const m = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
        if (!m || Number(m[1]) + 1 !== Number(m[2]) || blob.size !== Number(m[2])) {
          throw new Error('服务器只返回了部分文件（206），未把分片冒充完整简历。请刷新后重试。');
        }
      }
      check(job);
      return blob;
    } catch (e) {
      if (e.name === 'AbortError' && !job.controller.signal.aborted) throw new Error('读取超时，请检查网络后重试。');
      throw e;
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener('abort', cancel);
    }
  }

  async function resolveInfo(job) {
    const c = job.context;
    if (!c.talent) {
      if (!c.info?.url) throw new Error('无法确认当前候选人 ID，请从候选人详情页打开简历。');
      return c.info;
    }
    job.status('获取当前附件的有效文件地址…');
    const url = new URL(SITE.previewAPI, W.location.origin);
    // selected 是 attachment_resume_id，不能用 resumeInfo.id（后者是文件 ID）替代。
    url.searchParams.set('id', c.selected);
    url.searchParams.set('talent_id', c.talent);
    const data = await request(url.href, job, true);
    const raw = data?.default_attachment || data;
    if (!raw || typeof raw !== 'object' || !txt(raw.url)) throw new Error('飞书没有返回当前附件的预览地址。');
    if (id(raw.attachment_resume_id) && raw.attachment_resume_id !== c.selected) throw new Error('附件响应与当前选中的简历不一致，已停止。');
    const fresh = cloneInfo(raw);
    const old = c.info || {};
    // 原来的元数据已经确定属于同一附件；新请求优先，文件名缺失时才补旧值。
    return {
      ...fresh, attachmentId: c.selected,
      name: fresh.name || old.name || `简历_${c.selected}`,
      extension: fresh.extension || old.extension || '', mime: fresh.mime || old.mime || '',
      preview: Object.keys(fresh.preview).length ? fresh.preview : (old.preview || {})
    };
  }

  function filename(name, fallback = '候选人简历') {
    const clean = String(name ?? '').normalize('NFC')
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_')
      .replace(/\.(pdf|png|jpe?g|webp|gif|bmp|tiff?|docx?|rtf|html?)$/i, '')
      .replace(/[.\s]+$/g, '').trim();
    const safe = Array.from(clean).slice(0, 120).join('') || fallback;
    return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) ? `_${safe}` : safe;
  }

  function routeApplication() {
    const u = new URL(W.location.href);
    return id(u.searchParams.get('application_id')) || id(u.searchParams.get('applicationId'));
  }

  function fallbackFilenameBase(info) {
    const title = String(D.title || '').replace(/飞书|招聘|简历/g, '').trim();
    const candidateElement = D.querySelector(
      '#talentDetail [class*="container__"] [class*="header__"] [class*="name__"]',
    );
    const candidateText = candidateElement?.getAttribute('title')
      || candidateElement?.textContent
      || title.split(/\s*[-–—|｜]\s*/)[0]
      || '';
    const positionElement = D.querySelector(
      '#talentDetail [class*="jobName__"], #talentDetail [class*="jobName" i]',
    );
    const headingTexts = [...D.querySelectorAll(
      '#talentDetail h1, #talentDetail h2, #talentDetail [role="heading"], h1, h2',
    )]
      .map(e => e.textContent?.replace(/\s+/g, ' ').trim() || '')
      .filter(text => text && text.length <= 120);
    const rawPosition = positionElement?.getAttribute('title')
      || positionElement?.textContent?.replace(/\s+/g, ' ').trim()
      || headingTexts.find(text => /【[^】]+】/.test(text))
      || headingTexts[0]
      || '';
    const positionText = rawPosition
      .replace(/\s*(?:部门面试|面试|校招|意向|内推|推荐|投递|\d+\s*天前).*/u, '')
      .trim();
    if (!candidateText && !positionText) return filename(info?.name);
    return `${filename(positionText, '职位')}-${filename(candidateText, '候选人')}`;
  }

  let csrfTokenPromise;

  function readCsrfToken() {
    const raw = D.cookie.match(/(?:^|;\s*)atsx-csrf-token=([^;]*)/)?.[1] || '';
    if (!raw) return '';
    try { return decodeURIComponent(raw); } catch (_) { return raw; }
  }

  async function getCsrfToken(forceRefresh = false) {
    const current = readCsrfToken();
    if (current && !forceRefresh) return current;
    if (forceRefresh || !csrfTokenPromise) {
      csrfTokenPromise = (async () => {
        try {
          await W.fetch(`${W.location.origin}/atsx/api/common/csrf/token/`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
        } catch (error) {
          console.warn('[飞书简历下载] 获取 CSRF token 失败', error);
        }
        return readCsrfToken();
      })();
    }
    return csrfTokenPromise;
  }

  async function metadataJSON(path, params, job) {
    check(job);
    const query = new URLSearchParams(params);
    const request = async token => {
      const headers = {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (token) headers['x-csrf-token'] = token;
      return W.fetch(`${W.location.origin}${path}?${query.toString()}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', headers,
      });
    };
    let response = await request(await getCsrfToken());
    if ([403, 405].includes(response.status)) {
      response = await request(await getCsrfToken(true));
    }
    if (!response.ok) throw new Error(`职位/姓名接口请求失败：${response.status}`);
    const data = await response.json();
    check(job);
    return data;
  }

  async function filenameBase(info, job) {
    const fallback = fallbackFilenameBase(info);
    const talentId = job.context?.talent || routeTalent();
    const applicationId = routeApplication();
    if (!talentId || !applicationId) return fallback;

    try {
      job.status('获取职位和候选人姓名…');
      const [applicationResult, talentResult] = await Promise.all([
        metadataJSON('/atsx/api/application/related_without_resume/', {
          talent_id: talentId, application_id: applicationId,
        }, job),
        metadataJSON('/atsx/api/talent_v2/', {
          id: talentId, application_id: applicationId,
          without_application_list: 'true', without_agency_protect: 'true',
        }, job),
      ]);
      const data = applicationResult?.data || {};
      const applications = [
        ...(Array.isArray(data.my_application_list) ? data.my_application_list : []),
        ...(Array.isArray(data.other_application_list) ? data.other_application_list : []),
      ];
      const application = applications.find(item => String(item?.id) === String(applicationId));
      const positionTitle = application?.job?.title;
      const candidateName = talentResult?.data?.talent?.basic_info?.name
        || talentResult?.data?.talent?.name;
      if (!positionTitle || !candidateName) return fallback;
      return `${filename(positionTitle, '职位')}-${filename(candidateName, '候选人')}`;
    } catch (error) {
      console.warn('[飞书简历下载] 获取职位/姓名失败，使用页面文本', error);
      return fallback;
    }
  }

  function isPDFInfo(info) {
    return /(?:^|\/)pdf$/i.test(info.extension) || /application\/pdf/i.test(info.mime) || /\.pdf$/i.test(info.name);
  }
  async function pdfBlob(blob) {
    return new TextDecoder('latin1').decode(await blob.slice(0, 1024).arrayBuffer()).includes('%PDF-');
  }

  async function decoded(blob) {
    // Blob -> 本地 object URL，避免将远端图片直接画入跨域污染的 canvas。
    const u = URL.createObjectURL(blob);
    const image = D.createElement('img');
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('图片解码超时。')), 45000);
        image.onload = () => { clearTimeout(t); resolve(); };
        image.onerror = () => { clearTimeout(t); reject(new Error('返回内容不是可解码的整页图片。')); };
        image.src = u;
      });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效。');
      return { image, width: image.naturalWidth, height: image.naturalHeight,
        close() { image.removeAttribute('src'); URL.revokeObjectURL(u); } };
    } catch (e) { image.removeAttribute('src'); URL.revokeObjectURL(u); throw e; }
  }

  async function pageSource(blob) {
    const d = await decoded(blob);
    try { return { blob, width: d.width, height: d.height }; }
    finally { d.close(); }
  }

  function canvas(width, height) {
    const c = D.createElement('canvas');
    c.width = Math.max(1, Math.round(width)); c.height = Math.max(1, Math.round(height));
    if (c.width > LIMIT.side || c.height > LIMIT.side || c.width * c.height > LIMIT.pixels) {
      throw new Error('图片超过单画布保护上限，请改为逐页下载或自动分卷。');
    }
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('浏览器无法创建画布，请降低清晰度或改为逐页下载。');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    return { c, ctx };
  }
  function canvasBlob(c, type = 'image/png', quality = 0.95) {
    return new Promise((resolve, reject) => c.toBlob(b => b
      ? resolve(b) : reject(new Error('图片编码失败，可能是内存不足；请改为逐页下载或降低清晰度。')), type, quality));
  }
  function fitScale(width, height) {
    return Math.min(1, (LIMIT.side - 1) / width, (LIMIT.side - 1) / height,
      Math.sqrt((LIMIT.pixels - 100000) / (width * height)));
  }

  async function previewPages(info, job, p) {
    const keys = [];
    for (let q = p.quality; q >= 1; q--) keys.push(`image_x${q}_url_list`, `webp_x${q}_url_list`);
    const all = info.preview || {};
    const count = Math.max(all.pageCount || 0, ...Object.values(all).filter(Array.isArray).map(a => a.length), 0);
    if (!count || !keys.some(k => Array.isArray(all[k]) && all[k].length)) return null;
    if (count > LIMIT.pages) throw new Error('附件超过 300 页的保护上限，建议只下载原 PDF。');
    // 所有页都必须有地址；不因漏页而输出看起来“完整”的长图。
    if (Array.from({ length: count }, (_, i) => !keys.some(k => all[k]?.[i])).some(Boolean)) return null;
    const pages = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      check(job); job.status(`读取完整图片：第 ${i + 1} / ${count} 页…`);
      const urls = [...new Set(keys.map(k => all[k]?.[i]).filter(Boolean))];
      let page = null;
      let lastError = null;
      for (const u of urls) {
        try { page = await pageSource(await request(u, job)); break; }
        catch (e) {
          if (e.name === 'AbortError' || [401, 403].includes(e.status)) throw e;
          lastError = e;
        }
      }
      if (!page) throw lastError || new Error(`第 ${i + 1} 页读取失败，未生成缺页图片。`);
      total += page.blob.size;
      if (total > LIMIT.bytes) throw new Error('图片总大小超过 256 MB 的保护上限，已停止处理。');
      pages.push(page);
    }
    return pages;
  }

  async function sitePDFLoader() {
    if (typeof W.pdfjsLib?.getDocument === 'function') return W.pdfjsLib.getDocument.bind(W.pdfjsLib);
    if (typeof W.PDFJS?.getDocument === 'function') return W.PDFJS.getDocument.bind(W.PDFJS);
    const queue = W[SITE.webpackQueue];
    if (!Array.isArray(queue)) throw new Error('没有整页图片，且无法访问飞书的 PDF 渲染器。请先点一次全屏后重试，或只下载原 PDF。');
    let runtime;
    queue.push([[`${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`], {}, r => { runtime = r; }]);
    const bridge = runtime?.(SITE.pdfModule);
    if (typeof bridge?.[SITE.pdfExport] !== 'function') throw new Error('飞书 PDF 渲染接口已变更。原 PDF 仍可下载，但此附件的图片转换暂不可用。');
    const getDocument = await bridge[SITE.pdfExport]();
    if (typeof getDocument !== 'function') throw new Error('无法初始化飞书 PDF 渲染器，请只下载原 PDF。');
    return getDocument;
  }

  async function renderPDF(blob, job, p) {
    job.status('未提供整页图片，尝试用飞书自身的 PDF 渲染器生成…');
    const getDocument = await sitePDFLoader();
    check(job);
    const task = getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
    let renderTask;
    const cancel = () => { renderTask?.cancel(); Promise.resolve(task.destroy()).catch(() => {}); };
    job.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 180000);
    try {
      const pdf = await task.promise;
      if (pdf.numPages > LIMIT.pages) throw new Error('附件超过 300 页，请只下载原 PDF。');
      const pages = [];
      let total = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        check(job); job.status(`渲染完整 PDF：第 ${i} / ${pdf.numPages} 页…`);
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: p.quality });
        const viewport = page.getViewport({ scale: p.quality * fitScale(base.width, base.height) });
        const { c, ctx } = canvas(viewport.width, viewport.height);
        try {
          renderTask = page.render({ canvasContext: ctx, viewport, background: '#ffffff' });
          await renderTask.promise;
          const b = await canvasBlob(c);
          total += b.size;
          if (total > LIMIT.bytes) throw new Error('渲染图片超过内存保护上限，请降低清晰度或只保存 PDF。');
          pages.push({ blob: b, width: c.width, height: c.height });
        } finally { c.width = c.height = 1; page.cleanup(); renderTask = null; }
        await delay(0);
      }
      return pages;
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener('abort', cancel);
      await Promise.resolve(task.destroy()).catch(() => {});
    }
  }

  function imagePlan(pages, p) {
    if (!pages.length) throw new Error('附件没有可导出的页面。');
    if (p.layout === 'pages') return pages.map((page, i) => ({ indexes: [i], scale: fitScale(page.width, page.height) }));
    const width = Math.max(...pages.map(x => x.width));
    const height = pages.reduce((sum, x) => sum + x.height, 0);
    if (p.longPolicy === 'single') {
      let scale = fitScale(width, height);
      // 使用实际取整后的尺寸复核，避免很多页相加后的取整误差越过画布上限。
      for (let attempt = 0; attempt < 12; attempt++) {
        const w = Math.max(...pages.map(x => Math.max(1, Math.round(x.width * scale))));
        const h = pages.reduce((sum, x) => sum + Math.max(1, Math.round(x.height * scale)), 0);
        if (w < LIMIT.side && h < LIMIT.side && w * h < LIMIT.pixels) break;
        scale *= fitScale(w, h) * 0.995;
      }
      return [{ indexes: pages.map((_, i) => i), scale }];
    }
    const scale = fitScale(width, Math.max(...pages.map(x => x.height)));
    const w = Math.max(1, Math.round(width * scale));
    const maxH = Math.min(LIMIT.side - 1, Math.floor((LIMIT.pixels - 100000) / w));
    const plan = [];
    let indexes = [], h = 0;
    pages.forEach((page, i) => {
      const ph = Math.max(1, Math.round(page.height * scale));
      if (indexes.length && h + ph > maxH) { plan.push({ indexes, scale }); indexes = []; h = 0; }
      indexes.push(i); h += ph;
    });
    if (indexes.length) plan.push({ indexes, scale });
    return plan;
  }

  async function exportImages(pages, job, p, baseName) {
    const plan = imagePlan(pages, p);
    if (p.layout === 'long' && plan.length > 1) job.note(`为避免超长画布截断，已按页序分成 ${plan.length} 张长图，内容不会丢页。`);
    if (plan.some(x => x.scale < 0.99)) job.note('受画布尺寸保护限制，部分输出已等比例缩小；逐页模式可保留更高分辨率。');
    for (let i = 0; i < plan.length; i++) {
      check(job); job.status(`生成图片：第 ${i + 1} / ${plan.length} 个文件…`);
      const part = plan[i];
      const sizes = part.indexes.map(index => ({ index,
        w: Math.max(1, Math.round(pages[index].width * part.scale)),
        h: Math.max(1, Math.round(pages[index].height * part.scale)) }));
      const w = Math.max(...sizes.map(s => s.w));
      const h = sizes.reduce((sum, s) => sum + s.h, 0);
      const { c, ctx } = canvas(w, h);
      try {
        let y = 0;
        for (const s of sizes) {
          check(job);
          const d = await decoded(pages[s.index].blob);
          try { ctx.drawImage(d.image, Math.floor((w - s.w) / 2), y, s.w, s.h); }
          finally { d.close(); }
          y += s.h;
          await delay(0);
        }
        const b = await canvasBlob(c, p.imageType === 'jpeg' ? 'image/jpeg' : 'image/png', p.jpegQuality);
        const suffix = p.layout === 'pages' ? `_第${String(i + 1).padStart(2, '0')}页`
          : plan.length === 1 ? '_完整长图' : `_长图${String(i + 1).padStart(2, '0')}`;
        await job.addFile(b, `${baseName}${suffix}.${b.type === 'image/jpeg' ? 'jpg' : 'png'}`);
      } finally { c.width = c.height = 1; }
    }
  }

  async function imagePDF(pages, job) {
    // 最小、标准的多页 PDF：每页一个由浏览器生成的 RGB JPEG XObject，不引入第三方写库。
    const encoder = new TextEncoder();
    const chunks = [], offsets = [0];
    let position = 0;
    const write = x => { const b = typeof x === 'string' ? encoder.encode(x) : x; chunks.push(b); position += b.byteLength; };
    const object = (n, body) => { offsets[n] = position; write(`${n} 0 obj\n`); write(body); write('\nendobj\n'); };
    const stream = (n, dict, bytes) => {
      offsets[n] = position;
      write(`${n} 0 obj\n<< ${dict} /Length ${bytes.byteLength} >>\nstream\n`);
      write(bytes); write('\nendstream\nendobj\n');
    };
    write('%PDF-1.4\n'); write(new Uint8Array([37, 226, 227, 207, 211, 10]));
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`);
    for (let i = 0; i < pages.length; i++) {
      check(job); job.status(`生成图片型 PDF：第 ${i + 1} / ${pages.length} 页…`);
      const d = await decoded(pages[i].blob);
      const scale = fitScale(d.width, d.height);
      const { c, ctx } = canvas(d.width * scale, d.height * scale);
      let bytes, width, height;
      try {
        ctx.drawImage(d.image, 0, 0, c.width, c.height);
        const jpeg = await canvasBlob(c, 'image/jpeg', 0.97);
        if (jpeg.type !== 'image/jpeg') throw new Error('浏览器不支持 JPEG 编码，不能创建图片型 PDF。');
        bytes = new Uint8Array(await jpeg.arrayBuffer()); width = c.width; height = c.height;
      } finally { d.close(); c.width = c.height = 1; }
      let pw = 595.28, ph = pw * height / width;
      if (ph > 14000) { pw *= 14000 / ph; ph = 14000; }
      const a = (3 + i * 3), sw = pw.toFixed(3), sh = ph.toFixed(3);
      object(a, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${sw} ${sh}] /Resources << /XObject << /Im0 ${a + 1} 0 R >> >> /Contents ${a + 2} 0 R >>`);
      stream(a + 1, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, bytes);
      stream(a + 2, '', encoder.encode(`q\n${sw} 0 0 ${sh} 0 0 cm\n/Im0 Do\nQ\n`));
      if (position > LIMIT.bytes) throw new Error('生成的图片型 PDF 超过大小保护上限。');
    }
    const xref = position, count = 3 + pages.length * 3;
    write(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let i = 1; i < count; i++) write(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  function modal(title) {
    const host = element('div', undefined, D.documentElement);
    host.setAttribute(`data-${PREFIX}`, 'modal');
    const root = host.attachShadow({ mode: 'open' });
    element('style', `
      :host{all:initial;position:fixed;inset:0;z-index:2147483647;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#1f2329}
      *{box-sizing:border-box}.back{position:absolute;inset:0;background:#0005;display:flex;align-items:center;justify-content:center;padding:20px}
      .box{background:white;width:460px;max-width:100%;max-height:90vh;overflow:auto;border-radius:12px;padding:24px;box-shadow:0 12px 48px #0003;font-size:14px;line-height:1.65}
      h2{font-size:19px;margin:0 0 18px}label{display:block;margin:12px 0}input{margin:0 8px 0 0}select{width:100%;padding:7px;border:1px solid #bbb;border-radius:5px;background:white;color:#222}
      button{font:inherit;cursor:pointer;border:1px solid #bbb;border-radius:5px;background:white;color:#222;padding:6px 14px}button.primary{background:#3370ff;border-color:#3370ff;color:white}
      .foot{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.muted{font-size:12px;color:#646a73}.status{white-space:pre-wrap;margin:12px 0}.error{color:#b42318}
      a{display:block;color:#245bdb;word-break:break-all;margin:8px 0}.note{padding:9px;background:#f3f5f7;margin-top:10px;font-size:12px}
    `, root);
    const back = element('div', undefined, root); back.className = 'back';
    const box = element('section', undefined, back); box.className = 'box'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    element('h2', title, box);
    const body = element('div', undefined, box);
    const foot = element('div', undefined, box); foot.className = 'foot';
    return { host, body, foot, close() { host.remove(); } };
  }

  function openSettings() {
    if (settingsModal) return;
    const p = preferences();
    const m = settingsModal = modal('简历下载设置');
    const checkbox = (label, checked) => {
      const l = element('label', undefined, m.body); const input = element('input', undefined, l);
      input.type = 'checkbox'; input.checked = checked; l.appendChild(D.createTextNode(label)); return input;
    };
    const select = (label, options, value) => {
      const l = element('label', label, m.body); const s = element('select', undefined, l);
      options.forEach(([v, t]) => { const o = element('option', t, s); o.value = String(v); });
      s.value = String(value); return s;
    };
    const image = checkbox('下载完整简历图片', p.image);
    const pdf = checkbox('下载 PDF（有原 PDF 时保留原文件）', p.pdf);
    const imageType = select('图片格式', [['png', 'PNG：文字截图优先'], ['jpeg', 'JPG：文件通常较小']], p.imageType);
    const layout = select('多页图片', [['long', '按顺序拼接成长图'], ['pages', '每页保存一张图片']], p.layout);
    const longPolicy = select('长图超过画布保护上限时', [['split', '按页序分成多张长图，优先保清晰度'], ['single', '等比例缩小，尽量保持单张完整长图']], p.longPolicy);
    const quality = select('图片来源清晰度', [[3, '优先使用最高档（x3，缺失时降档）'], [2, '优先使用 x2'], [1, '使用 x1（较省内存）']], p.quality);
    element('p', 'x1/x2/x3 是飞书返回的档位，不保证每个附件都有不同分辨率。图片附件生成的 PDF 不含可搜索文字层。仅设置会被持久保存。', m.body).className = 'muted';
    const error = element('div', '', m.body); error.className = 'error';
    const close = () => { m.close(); settingsModal = null; };
    element('button', '取消', m.foot).onclick = close;
    const save = element('button', '保存设置', m.foot); save.className = 'primary';
    save.onclick = () => {
      if (!image.checked && !pdf.checked) { error.textContent = '请至少选择图片或 PDF。'; return; }
      try {
        GM_setValue(SETTINGS_KEY, { image: image.checked, pdf: pdf.checked, imageType: imageType.value,
          layout: layout.value, longPolicy: longPolicy.value, quality: Number(quality.value), jpegQuality: 0.95 });
        close();
      } catch (_) { error.textContent = '设置保存失败，请检查油猴是否允许脚本存储。'; }
    };
  }

  function makeJob() {
    if (resultModal) resultModal.dispose();
    const m = modal('下载当前简历');
    const status = element('div', '正在确认当前附件…', m.body); status.className = 'status';
    const links = element('div', undefined, m.body);
    const notes = element('div', undefined, m.body);
    element('p', '文件生成后会自动发起下载。若浏览器拦截连续下载，可直接点击下方文件名逐个保存。关闭面板将释放本次生成的临时文件。', m.body).className = 'muted';
    const close = element('button', '取消', m.foot);
    const urls = [];
    const job = {
      controller: new AbortController(), context: null, count: 0, disposed: false,
      status(s) { status.textContent = s; },
      note(s) { element('div', s, notes).className = 'note'; },
      async addFile(blob, name) {
        check(job);
        const url = URL.createObjectURL(blob); urls.push(url);
        const a = element('a', `${name}（${(blob.size / 1024 / 1024).toFixed(2)} MB）`, links);
        a.href = url; a.download = name; a.rel = 'noopener';
        a.click(); job.count++;
        // 后台下载是否落盘无法由普通页面 JS 确认，所以提示“发起下载”，不声称“已保存”。
        await delay(250);
      },
      finish(error) {
        close.textContent = '关闭';
        if (error) {
          status.classList.add('error');
          status.textContent = `${job.count ? `已生成 ${job.count} 个文件，但未全部完成。\n` : ''}${message(error)}`;
        } else status.textContent = `已生成 ${job.count} 个文件并发起下载。可通过下方链接再次保存。`;
      },
      dispose() {
        if (job.disposed) return;
        job.disposed = true; job.controller.abort(); m.close();
        // 已点击的下载请求仍有机会读取 Blob；未使用的链接随后释放。
        setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 60000);
        if (resultModal === job) resultModal = null;
      }
    };
    close.onclick = job.dispose;
    resultModal = job;
    return job;
  }

  async function run(anchor) {
    if (busy) return;
    busy = true; syncButtons();
    const job = activeJob = makeJob();
    let error;
    try {
      const p = preferences();
      job.context = locateContext(anchor);
      const info = await resolveInfo(job);
      check(job);
      const baseName = await filenameBase(info, job);
      let original = null, originalIsPDF = false;
      const getOriginal = async () => {
        if (!original) {
          job.status('读取完整附件原文件…'); original = await request(info.url, job);
          originalIsPDF = await pdfBlob(original);
        }
        return original;
      };
      if (isPDFInfo(info) && p.pdf) {
        await getOriginal();
        if (!originalIsPDF) throw new Error('附件标记为 PDF，但文件内容不是完整 PDF。没有将错误页或其他格式冒充 PDF 保存。');
        await job.addFile(new Blob([original], { type: 'application/pdf' }), `${baseName}.pdf`);
      }
      if (!p.image && originalIsPDF) { job.finish(); return; }

      let pages;
      let imageError;
      try { pages = await previewPages(info, job, p); }
      catch (e) {
        if (e.name === 'AbortError' || [401, 403].includes(e.status)) throw e;
        imageError = e; pages = null;
      }
      if (!pages) {
        await getOriginal();
        if (originalIsPDF) {
          if (p.pdf && !job.count) await job.addFile(new Blob([original], { type: 'application/pdf' }), `${baseName}.pdf`);
          if (!p.image) { job.finish(); return; }
          if (imageError) job.note('服务器整页图片读取未完成，改用原 PDF 重新渲染所有页。');
          pages = await renderPDF(original, job, p);
        } else {
          try { pages = [await pageSource(original)]; }
          catch (_) { throw imageError || new Error('此附件既没有可用的整页图片，也不是可直接转换的 PDF/图片。当前版本不解析 Word/HTML 原文件。'); }
        }
      }
      check(job);
      if (p.image) await exportImages(pages, job, p, baseName);
      if (p.pdf && !originalIsPDF) {
        job.note('此附件未取得原 PDF，将生成图片型 PDF；不包含可搜索文字层。');
        await job.addFile(await imagePDF(pages, job), `${baseName}_图片版.pdf`);
      }
    } catch (e) { error = e; }
    finally {
      if (!job.disposed) job.finish(error);
      busy = false; activeJob = null; syncButtons();
    }
  }

  function syncButtons() {
    for (const group of groups.values()) {
      const b = group.querySelector('button');
      if (b) { b.disabled = busy; b.textContent = busy ? '处理中…' : '下载'; }
    }
  }

  function scan() {
    if (!D.body) return;
    for (const [key, group] of groups) {
      if (!key.isConnected || !group.isConnected) { group.remove(); groups.delete(key); }
    }
    for (const toolbar of D.querySelectorAll(SITE.toolbar)) {
      if (!visible(toolbar)) continue;
      const full = fullScreenButton(toolbar);
      if (!full || groups.has(full)) continue;
      let reference = full;
      while (reference.parentElement && reference.parentElement !== toolbar) reference = reference.parentElement;
      if (reference.parentElement !== toolbar) continue;
      const group = element('span');
      group.setAttribute(`data-${PREFIX}`, 'toolbar');
      group.style.cssText = 'display:inline-flex;align-items:center;gap:3px;flex-shrink:0;white-space:nowrap;';
      const button = element('button', '下载', group);
      const setting = element('button', undefined, group);
      setting.appendChild(settingsIcon());
      for (const b of [button, setting]) {
        b.type = 'button';
        b.style.cssText = 'box-sizing:border-box;cursor:pointer;border:0;border-radius:4px;background:transparent;color:#3370ff;padding:2px 5px;height:24px;line-height:20px;font-size:12px;white-space:nowrap;';
        // 防止下载按钮点击透传为全屏/其他父级操作，不干预飞书原按钮。
        b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
      }
      button.title = '下载当前选中的完整简历；格式可在旁边设置';
      setting.title = '设置下载格式和图片模式';
      setting.setAttribute('aria-label', '简历下载设置');
      button.addEventListener('click', () => run(full));
      setting.addEventListener('click', openSettings);
      toolbar.insertBefore(group, reference);
      groups.set(full, group);
    }
    syncButtons();
  }

  let scanTimer;
  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 250);
  };
  if (!D.documentElement.hasAttribute(`data-${PREFIX}-installed`)) {
    D.documentElement.setAttribute(`data-${PREFIX}-installed`, '1');
    installControlStyles();
    new MutationObserver(records => {
      if (records.some(r => !(r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest?.(`[data-${PREFIX}]`))) scheduleScan();
    }).observe(D.documentElement, { childList: true, subtree: true });
    setInterval(scan, 2000); // 覆盖 SPA 只改变可见性而不插入新节点的情况。
    W.addEventListener('pagehide', () => activeJob?.controller.abort());
    GM_registerMenuCommand('简历下载：设置', openSettings);
    GM_registerMenuCommand('简历下载：下载当前附件', () => run(null));
    scan();
  }
})();
