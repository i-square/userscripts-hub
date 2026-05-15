// ==UserScript==
// @name         Sphinx RTD Theme 宽屏切换器
// @namespace    https://github.com/i-square/userscripts-hub
// @version      0.1.0
// @author       https://github.com/i-square
// @description  自动识别经典 sphinx_rtd_theme 文档，提供右上角宽屏切换与正文 max-width 像素调节。
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/i-square/userscripts-hub/main/readthedocs/readthedocs-wide-toggle.user.js
// @downloadURL  https://raw.githubusercontent.com/i-square/userscripts-hub/main/readthedocs/readthedocs-wide-toggle.user.js
// @match        https://*.readthedocs.io/*
// @match        https://readthedocs.io/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /******************** 常量 ********************/
  const STORAGE_KEY = 'rtd_wide_config';
  const DETECT_DELAY_MS = 400;
  const MAX_INIT_RETRIES = 10;
  const DEFAULT_CONFIG = {
    enabled: true,
    maxWidth: 1200,
  };
  const WIDTH_LIMITS = {
    min: 600,
    maxStored: 9999,
  };
  const UI = {
    buttonWidth: 42,
    topGap: 8,
    sideGap: 16,
  };
  const SELECTORS = {
    content: '.wy-nav-content',
    wrap: '.wy-nav-content-wrap',
    breadcrumbs: '.wy-nav-content .wy-breadcrumbs',
    nav: '.wy-nav-content div[role="navigation"][aria-label="页面导航"], .wy-nav-content div[role="navigation"]',
    source: '.wy-nav-content .wy-breadcrumbs-aside a, .wy-nav-content .wy-breadcrumbs-aside',
  };

  let config = loadConfig();
  const state = {
    initialized: false,
    rafId: null,
    container: null,
    mainBtn: null,
    icon: null,
    slider: null,
    valText: null,
    presets: [],
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampStoredWidth(value) {
    const next = Number(value);
    if (!Number.isFinite(next)) {
      return DEFAULT_CONFIG.maxWidth;
    }
    return clamp(Math.round(next), WIDTH_LIMITS.min, WIDTH_LIMITS.maxStored);
  }

  function loadConfig() {
    let saved = {};
    try {
      saved = GM_getValue(STORAGE_KEY, {});
    } catch {}

    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_CONFIG.enabled,
      maxWidth: clampStoredWidth(saved.maxWidth ?? DEFAULT_CONFIG.maxWidth),
    };
  }

  function saveConfig() {
    try {
      GM_setValue(STORAGE_KEY, {
        enabled: config.enabled,
        maxWidth: clampStoredWidth(config.maxWidth),
      });
    } catch {}
  }

  function query(selector) {
    return document.querySelector(selector);
  }

  function isRtdTheme() {
    return Boolean(
      query(SELECTORS.content)
      && query(SELECTORS.wrap)
      && query(SELECTORS.breadcrumbs)
    );
  }

  function getEffectiveMaxWidth() {
    const viewportMax = Math.max(WIDTH_LIMITS.min, Math.floor(window.innerWidth * 0.98));
    return Math.min(clampStoredWidth(config.maxWidth), viewportMax);
  }

  function getAnchorMetrics() {
    const navBlock = query(SELECTORS.nav);
    const content = query(SELECTORS.content);
    const wrap = query(SELECTORS.wrap);
    const sourceLink = query(SELECTORS.source);

    const navRect = navBlock?.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    const sourceRect = sourceLink?.getBoundingClientRect();
    const contentStyle = content ? window.getComputedStyle(content) : null;
    const contentPaddingRight = parseFloat(contentStyle?.paddingRight || '0') || 0;
    const sourceWidth = sourceRect?.width || sourceLink?.offsetWidth || 96;
    const buttonWidth = state.mainBtn?.offsetWidth || UI.buttonWidth;

    // X 轴基准固定按“正文拉满时”的右侧参考线计算，不跟随当前 max-width 变化。
    const fullWidthSourceCenterX = wrapRect
      ? wrapRect.right - contentPaddingRight - (sourceWidth / 2)
      : sourceRect
        ? sourceRect.left + (sourceRect.width / 2)
        : window.innerWidth - 96;

    const left = clamp(
      Math.round(fullWidthSourceCenterX - (buttonWidth / 2)),
      UI.sideGap,
      window.innerWidth - buttonWidth - UI.sideGap
    );

    return {
      top: Math.max(14, Math.round((navRect?.bottom ?? 56) + UI.topGap)),
      left,
    };
  }

  function applyWideStyles() {
    const root = document.documentElement;
    root.setAttribute('data-tm-rtd-wide', config.enabled ? '1' : '0');

    if (config.enabled) {
      root.style.setProperty('--tm-rtd-max-width', `${getEffectiveMaxWidth()}px`);
    } else {
      root.style.removeProperty('--tm-rtd-max-width');
    }
  }

  function setPanelOpen(open) {
    if (!state.container) return;
    state.container.dataset.open = open ? '1' : '0';
    state.mainBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function syncControls() {
    if (!state.mainBtn || !state.icon || !state.slider || !state.valText) return;

    const storedWidth = clampStoredWidth(config.maxWidth);
    const isFullWidthMode = storedWidth >= WIDTH_LIMITS.maxStored;

    state.mainBtn.classList.toggle('active', config.enabled);
    state.mainBtn.setAttribute('aria-pressed', config.enabled ? 'true' : 'false');
    state.mainBtn.title = config.enabled ? '点击关闭宽屏模式' : '点击启用宽屏模式';
    state.icon.textContent = config.enabled ? '>-<' : '<->';

    state.slider.value = String(isFullWidthMode ? state.slider.max : storedWidth);
    state.slider.disabled = !config.enabled;
    state.valText.textContent = isFullWidthMode ? '100%' : `${storedWidth}px`;

    state.presets.forEach((button) => {
      button.disabled = !config.enabled;
    });
  }

  function syncContainerPosition() {
    if (!state.container) return;
    const { top, left } = getAnchorMetrics();
    state.container.style.top = `${top}px`;
    state.container.style.left = `${left}px`;
    state.container.style.right = 'auto';
  }

  function refreshLayout() {
    applyWideStyles();
    syncControls();

    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
    }

    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      syncContainerPosition();
    });
  }

  function injectGlobalStyles() {
    GM_addStyle(`
      html[data-tm-rtd-wide="1"] .wy-nav-content {
        max-width: var(--tm-rtd-max-width, 95%) !important;
        width: auto !important;
      }

      html[data-tm-rtd-wide="1"] .wy-table-responsive {
        overflow: visible !important;
      }

      html[data-tm-rtd-wide="1"] .wy-table-responsive table td,
      html[data-tm-rtd-wide="1"] .wy-table-responsive table th {
        white-space: normal !important;
      }

      #tm-rtd-controls {
        position: fixed;
        top: 96px;
        left: auto;
        right: 32px;
        z-index: 2147483647;
        display: inline-flex;
        justify-content: flex-end;
        padding-bottom: 12px;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      }

      .tm-rtd-main-btn {
        width: 42px;
        height: 36px;
        border: none;
        border-radius: 10px;
        background: linear-gradient(180deg, #16794a 0%, #105d39 100%);
        color: #fff;
        cursor: pointer;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 120ms ease, box-shadow 120ms ease;
      }

      .tm-rtd-main-btn:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.26);
      }

      .tm-rtd-main-btn.active {
        background: linear-gradient(180deg, #1b74ff 0%, #1453bd 100%);
      }

      .tm-rtd-btn-icon {
        font-family: ui-monospace, monospace;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: -0.6px;
      }

      .tm-rtd-panel {
        position: absolute;
        top: calc(100% - 2px);
        right: 0;
        width: 252px;
        padding: 15px;
        display: none;
        color: #fff;
        text-align: left;
        border-radius: 14px;
        background: rgba(18, 20, 24, 0.95);
        backdrop-filter: blur(10px);
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.32);
      }

      #tm-rtd-controls[data-open="1"] .tm-rtd-panel {
        display: block;
      }

      .tm-rtd-panel h4 {
        margin: 0 0 10px;
        padding-bottom: 8px;
        font-size: 13px;
        font-weight: 700;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .tm-rtd-row {
        margin-bottom: 12px;
      }

      .tm-rtd-label {
        display: flex;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 12px;
        opacity: 0.85;
      }

      .tm-rtd-slider {
        width: 100%;
        cursor: pointer;
        accent-color: #1b74ff;
      }

      .tm-rtd-slider:disabled,
      .tm-rtd-preset-btn:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }

      .tm-rtd-presets {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .tm-rtd-preset-btn {
        flex: 1 1 auto;
        min-width: 60px;
        padding: 6px 8px;
        border: none;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        cursor: pointer;
        font-size: 11px;
        transition: background 0.2s;
      }

      .tm-rtd-preset-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.18);
      }

      .tm-rtd-footer {
        margin-top: 10px;
        font-size: 10px;
        text-align: center;
        color: rgba(255, 255, 255, 0.5);
      }

      @media (max-width: 768px) {
        .tm-rtd-panel {
          width: min(252px, calc(100vw - 40px));
        }
      }
    `);
  }

  function createUI() {
    const container = document.createElement('div');
    container.id = 'tm-rtd-controls';
    container.dataset.open = '0';
    container.innerHTML = `
      <button class="tm-rtd-main-btn" type="button" aria-label="切换宽屏模式" aria-expanded="false">
        <span class="tm-rtd-btn-icon"></span>
      </button>
      <div class="tm-rtd-panel">
        <h4>Sphinx RTD 宽屏设置</h4>
        <div class="tm-rtd-row">
          <div class="tm-rtd-label">
            <span>最大宽度</span>
            <span id="tm-rtd-val"></span>
          </div>
          <input type="range" class="tm-rtd-slider" min="${WIDTH_LIMITS.min}" max="2500" step="50">
        </div>
        <div class="tm-rtd-presets">
          <button class="tm-rtd-preset-btn" type="button" data-val="1000">1000px</button>
          <button class="tm-rtd-preset-btn" type="button" data-val="1400">1400px</button>
          <button class="tm-rtd-preset-btn" type="button" data-val="1800">1800px</button>
          <button class="tm-rtd-preset-btn" type="button" data-val="9999">100%</button>
        </div>
        <div class="tm-rtd-footer">设置将自动保存并跨站生效</div>
      </div>
    `;

    document.body.appendChild(container);

    state.container = container;
    state.mainBtn = container.querySelector('.tm-rtd-main-btn');
    state.icon = container.querySelector('.tm-rtd-btn-icon');
    state.slider = container.querySelector('.tm-rtd-slider');
    state.valText = container.querySelector('#tm-rtd-val');
    state.presets = [...container.querySelectorAll('.tm-rtd-preset-btn')];

    container.addEventListener('mouseenter', () => setPanelOpen(true));
    container.addEventListener('mouseleave', () => setPanelOpen(false));
    container.addEventListener('focusin', () => setPanelOpen(true));
    container.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!container.contains(document.activeElement)) {
          setPanelOpen(false);
        }
      });
    });

    state.mainBtn.addEventListener('click', () => {
      config.enabled = !config.enabled;
      saveConfig();
      refreshLayout();
    });

    state.slider.addEventListener('input', (event) => {
      config.maxWidth = clampStoredWidth(event.target.value);
      refreshLayout();
    });

    state.slider.addEventListener('change', () => {
      saveConfig();
    });

    state.presets.forEach((button) => {
      button.addEventListener('click', () => {
        const nextValue = clampStoredWidth(button.dataset.val);
        config.maxWidth = nextValue;
        saveConfig();
        refreshLayout();
      });
    });
  }

  function init() {
    if (state.initialized || !isRtdTheme()) {
      return state.initialized;
    }

    injectGlobalStyles();
    createUI();
    refreshLayout();

    window.addEventListener('resize', refreshLayout, { passive: true });
    state.initialized = true;
    return true;
  }

  function attemptInit(retry = 0) {
    if (init() || retry >= MAX_INIT_RETRIES) return;
    window.setTimeout(() => attemptInit(retry + 1), DETECT_DELAY_MS);
  }

  attemptInit();
})();
