// ==UserScript==
// @name         ReadTheDocs 宽屏 & 侧边栏增强
// @namespace    https://github.com/i-square/userscripts-hub
// @version      0.2.0
// @author       https://github.com/i-square
// @description  为 ReadTheDocs 文档提供宽屏切换、正文宽度调节、侧边栏一键隐藏。隐藏侧边栏时自动屏蔽 Ask AI 与版本浮窗。快捷键 [ 切换侧边栏。
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/i-square/userscripts-hub/main/readthedocs/wide-sidebar/readthedocs-wide-sidebar.user.js
// @downloadURL  https://raw.githubusercontent.com/i-square/userscripts-hub/main/readthedocs/wide-sidebar/readthedocs-wide-sidebar.user.js
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
    sidebarOpen: true,
  };
  const WIDTH_LIMITS = {
    min: 600,
    maxStored: 9999,
  };
  const SELECTORS = {
    content: '.wy-nav-content',
    wrap: '.wy-nav-content-wrap',
    breadcrumbs: '.wy-nav-content .wy-breadcrumbs',
    navSide: '.wy-nav-side',
  };

  let config = loadConfig();
  const state = {
    initialized: false,
    container: null,
    mainBtn: null,
    icon: null,
    slider: null,
    valText: null,
    presets: [],
    sidebarBtn: null,
    sidebarValText: null,
    wideBtn: null,
    wideValText: null,
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
      sidebarOpen: typeof saved.sidebarOpen === 'boolean' ? saved.sidebarOpen : DEFAULT_CONFIG.sidebarOpen,
    };
  }

  function saveConfig() {
    try {
      GM_setValue(STORAGE_KEY, {
        enabled: config.enabled,
        maxWidth: clampStoredWidth(config.maxWidth),
        sidebarOpen: config.sidebarOpen,
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

  function applyWideStyles() {
    const root = document.documentElement;
    root.setAttribute('data-tm-rtd-wide', config.enabled ? '1' : '0');

    if (config.enabled) {
      root.style.setProperty('--tm-rtd-max-width', `${getEffectiveMaxWidth()}px`);
    } else {
      root.style.removeProperty('--tm-rtd-max-width');
    }
  }

  function applySidebarState() {
    const navSide = query(SELECTORS.navSide);
    const wrap = query(SELECTORS.wrap);
    if (!navSide || !wrap) return;

    if (config.sidebarOpen) {
      document.body.classList.remove('rtd-sidebar-closed');
      navSide.style.display = '';
      wrap.style.marginLeft = '';
    } else {
      document.body.classList.add('rtd-sidebar-closed');
      navSide.style.display = 'none';
      wrap.style.marginLeft = '0';
    }
  }

  function setPanelOpen(open) {
    if (!state.container) return;
    state.container.dataset.open = open ? '1' : '0';
    state.mainBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function syncControls() {
    if (!state.slider || !state.valText) return;

    const storedWidth = clampStoredWidth(config.maxWidth);
    const isFullWidthMode = storedWidth >= WIDTH_LIMITS.maxStored;

    state.slider.value = String(isFullWidthMode ? state.slider.max : storedWidth);
    state.slider.disabled = !config.enabled;
    state.valText.textContent = isFullWidthMode ? '100%' : `${storedWidth}px`;

    state.presets.forEach((button) => {
      button.disabled = !config.enabled;
    });

    if (state.sidebarBtn && state.sidebarValText) {
      state.sidebarValText.textContent = config.sidebarOpen ? '显示' : '隐藏';
      state.sidebarBtn.textContent = config.sidebarOpen ? '隐藏侧边栏' : '显示侧边栏';
    }

    if (state.wideBtn && state.wideValText) {
      state.wideValText.textContent = config.enabled ? '开启' : '关闭';
      state.wideBtn.textContent = config.enabled ? '关闭宽屏' : '开启宽屏';
    }
  }

  function refreshLayout() {
    applyWideStyles();
    applySidebarState();
    syncControls();
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

      body.rtd-sidebar-closed #runllm-widget,
      body.rtd-sidebar-closed .rllm-fixed {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      body.rtd-sidebar-closed readthedocs-flyout,
      body.rtd-sidebar-closed .floating.container.bottom-right {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      #tm-rtd-controls {
        position: fixed;
        top: 12px;
        right: 14px;
        left: auto;
        z-index: 2147483647;
        display: inline-flex;
        justify-content: flex-end;
        padding-bottom: 12px;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      }

      .tm-rtd-main-btn {
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 50%;
        background: rgba(30, 30, 30, 0.55);
        color: #fff;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.45;
        transition: opacity 200ms ease, transform 200ms ease, box-shadow 200ms ease, background 200ms ease;
        backdrop-filter: blur(6px);
      }

      .tm-rtd-main-btn:hover {
        opacity: 1;
        background: rgba(30, 30, 30, 0.85);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
      }

      #tm-rtd-controls[data-open="1"] .tm-rtd-main-btn {
        opacity: 1;
        background: rgba(30, 30, 30, 0.85);
      }

      .tm-rtd-btn-icon {
        font-size: 16px;
        line-height: 1;
        display: block;
        transition: transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      #tm-rtd-controls[data-open="1"] .tm-rtd-btn-icon {
        transform: rotate(90deg);
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

      .tm-rtd-divider {
        border: none;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        margin: 10px 0 12px;
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
      <button class="tm-rtd-main-btn" type="button" aria-label="RTD 增强设置" aria-expanded="false">
        <span class="tm-rtd-btn-icon">⚙️</span>
      </button>
      <div class="tm-rtd-panel">
        <h4>RTD 增强设置</h4>
        <div class="tm-rtd-row">
          <div class="tm-rtd-label">
            <span>侧边栏</span>
            <span id="tm-rtd-sidebar-val"></span>
          </div>
          <div class="tm-rtd-presets">
            <button class="tm-rtd-preset-btn" type="button" id="tm-rtd-sidebar-btn" style="flex:1 1 100%"></button>
          </div>
        </div>
        <div class="tm-rtd-row">
          <div class="tm-rtd-label">
            <span>宽屏模式</span>
            <span id="tm-rtd-wide-val"></span>
          </div>
          <div class="tm-rtd-presets">
            <button class="tm-rtd-preset-btn" type="button" id="tm-rtd-wide-btn" style="flex:1 1 100%"></button>
          </div>
        </div>
        <hr class="tm-rtd-divider">
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
        <div class="tm-rtd-footer">设置自动保存并跨站生效 · 快捷键 [ 切换侧边栏</div>
      </div>
    `;

    document.body.appendChild(container);

    state.container = container;
    state.mainBtn = container.querySelector('.tm-rtd-main-btn');
    state.icon = container.querySelector('.tm-rtd-btn-icon');
    state.slider = container.querySelector('.tm-rtd-slider');
    state.valText = container.querySelector('#tm-rtd-val');
    state.presets = [...container.querySelectorAll('.tm-rtd-preset-btn[data-val]')];
    state.sidebarBtn = container.querySelector('#tm-rtd-sidebar-btn');
    state.sidebarValText = container.querySelector('#tm-rtd-sidebar-val');
    state.wideBtn = container.querySelector('#tm-rtd-wide-btn');
    state.wideValText = container.querySelector('#tm-rtd-wide-val');

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
      const isOpen = state.container.dataset.open === '1';
      setPanelOpen(!isOpen);
    });

    state.sidebarBtn.addEventListener('click', () => {
      config.sidebarOpen = !config.sidebarOpen;
      saveConfig();
      refreshLayout();
    });

    state.wideBtn.addEventListener('click', () => {
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

    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      if (e.key === '[') {
        config.sidebarOpen = !config.sidebarOpen;
        saveConfig();
        refreshLayout();
      }
    });
  }

  function init() {
    if (state.initialized || !isRtdTheme()) {
      return state.initialized;
    }

    injectGlobalStyles();
    createUI();
    refreshLayout();

    state.initialized = true;
    return true;
  }

  function attemptInit(retry = 0) {
    if (init() || retry >= MAX_INIT_RETRIES) return;
    window.setTimeout(() => attemptInit(retry + 1), DETECT_DELAY_MS);
  }

  attemptInit();
})();
