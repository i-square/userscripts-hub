/**
 * Codex 登录态同步服务（零依赖 Node.js 微服务）
 *
 * 配套油猴脚本 chatgpt-codex-auth-sync.user.js 使用：
 *   - 接收脚本推送的 auth.json，严格校验后安全写入 CODEX_HOME/auth.json
 *   - 默认仅监听 127.0.0.1，配共享密钥，拒绝浏览器跨域预检，防本机网页/进程乱写
 *   - 写入前自动备份旧文件并裁剪历史备份，临时文件 + 重命名的原子写入
 *
 * 配置：同目录 config.json（首次运行自动生成，含随机同步密钥）
 *   {
 *     "host": "127.0.0.1",        // 局域网共享时改为 "0.0.0.0"
 *     "port": 18765,
 *     "syncKey": "<随机密钥>",     // 需与油猴脚本设置中的"同步密钥"一致
 *     "codexHome": "",            // 留空 = 环境变量 CODEX_HOME 或 ~/.codex
 *     "maxBackups": 10
 *   }
 * 环境变量 SYNC_HOST / SYNC_PORT / SYNC_KEY / CODEX_HOME 可覆盖对应项（便于测试）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VERSION = '1.0.0';
const SCRIPT_DIR = __dirname;
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');
const LOG_PATH = path.join(SCRIPT_DIR, 'codex-auth-server.log');
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 请求体上限 2MB

/******************** 日志（不落盘敏感内容） ********************/
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* 日志写失败不影响主流程 */ }
}

/******************** 配置 ********************/
function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 首次运行 */ }
  if (!cfg || typeof cfg !== 'object') {
    cfg = {
      host: '127.0.0.1',
      port: 18765,
      syncKey: crypto.randomBytes(16).toString('hex'),
      codexHome: '',
      maxBackups: 10,
    };
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n'); } catch { }
    log(`[初始化] 已生成配置文件 ${CONFIG_PATH}`);
    log(`[初始化] 随机同步密钥（请填入油猴脚本设置）: ${cfg.syncKey}`);
  }
  // 环境变量优先
  cfg.host = process.env.SYNC_HOST || cfg.host || '127.0.0.1';
  cfg.port = Number(process.env.SYNC_PORT || cfg.port || 18765);
  cfg.syncKey = process.env.SYNC_KEY || cfg.syncKey || '';
  cfg.codexHome = process.env.CODEX_HOME || cfg.codexHome || path.join(os.homedir(), '.codex');
  cfg.maxBackups = Number(cfg.maxBackups) > 0 ? Number(cfg.maxBackups) : 10;
  return cfg;
}

const cfg = loadConfig();

/******************** JWT 与内容校验 ********************/
function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// 返回 { errors: string[], accountId: string, expDays: number|null }
function validateAuth(auth) {
  const errors = [];
  let accountId = '';
  let expDays = null;

  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { errors: ['请求体不是有效的 JSON 对象'], accountId, expDays };
  }
  if (auth.auth_mode !== 'chatgpt') errors.push('auth_mode 必须是 "chatgpt"');

  const tokens = auth.tokens || {};
  if (typeof tokens.id_token !== 'string' || !tokens.id_token) errors.push('缺少 tokens.id_token');
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) errors.push('缺少 tokens.access_token');

  if (typeof tokens.access_token === 'string' && tokens.access_token) {
    const payload = decodeJwtPayload(tokens.access_token);
    if (!payload) {
      errors.push('access_token 不是有效的 JWT');
    } else {
      if (typeof payload.exp !== 'number') {
        errors.push('access_token 缺少 exp 字段');
      } else {
        const msLeft = payload.exp * 1000 - Date.now();
        if (msLeft <= 3600 * 1000) errors.push('access_token 已过期或 1 小时内即将过期');
        expDays = Math.round((msLeft / 86400000) * 10) / 10;
      }
      const claim = payload['https://api.openai.com/auth'];
      accountId = (claim && claim.chatgpt_account_id) || tokens.account_id || '';
    }
  }
  return { errors, accountId, expDays };
}

/******************** 备份与原子写入 ********************/
function localTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pruneBackups(codexHome) {
  try {
    const backups = fs.readdirSync(codexHome)
      .filter((f) => /^auth\.json\.bak_\d{8}_\d{6}$/.test(f))
      .sort();
    const excess = backups.length - cfg.maxBackups;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(codexHome, backups[i])); } catch { }
    }
  } catch { }
}

// 返回备份文件路径（无备份则为空字符串）
function writeAuthSafely(content) {
  fs.mkdirSync(cfg.codexHome, { recursive: true });
  const target = path.join(cfg.codexHome, 'auth.json');
  let backup = '';
  if (fs.existsSync(target)) {
    backup = path.join(cfg.codexHome, `auth.json.bak_${localTimestamp()}`);
    fs.copyFileSync(target, backup);
    pruneBackups(cfg.codexHome);
  }
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target); // 同目录重命名 = 原子替换
  return backup;
}

/******************** HTTP 服务 ********************/
function sendJson(res, status, obj) {
  // 注意：刻意不返回任何 CORS 头，浏览器网页跨域调用会被预检拦截，
  // 油猴 GM_xmlhttpRequest 不受 CORS 限制，可正常访问。
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function collectBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      cb(new Error('请求体过大'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(new Error('读取请求体失败')));
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://internal').pathname; } catch { }

  // 健康检查（脚本"测试连接"按钮）
  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: VERSION });
  }

  // 推送 auth.json
  if (req.method === 'POST' && pathname === '/push') {
    if (cfg.syncKey && req.headers['x-sync-key'] !== cfg.syncKey) {
      log(`[拒绝] 同步密钥错误，来自 ${req.socket.remoteAddress}`);
      return sendJson(res, 401, { success: false, error: '同步密钥错误或缺失' });
    }
    collectBody(req, (err, raw) => {
      if (err) return sendJson(res, 413, { success: false, error: err.message });
      let auth;
      try {
        auth = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { success: false, error: 'JSON 解析失败' });
      }
      const { errors, accountId, expDays } = validateAuth(auth);
      if (errors.length > 0) {
        log(`[拒绝] 内容校验失败: ${errors.join('; ')}`);
        return sendJson(res, 400, { success: false, error: errors.join('; ') });
      }
      try {
        const backup = writeAuthSafely(JSON.stringify(auth, null, 2) + '\n');
        log(`[成功] 已写入 ${path.join(cfg.codexHome, 'auth.json')}（账号 ${accountId || '未知'}，Token 剩余 ${expDays} 天${backup ? '，旧文件已备份' : ''}）`);
        sendJson(res, 200, { success: true, message: `已写入，Token 剩余 ${expDays} 天`, accountId, expDays });
      } catch (e) {
        log(`[失败] 写入异常: ${e.message}`);
        sendJson(res, 500, { success: false, error: '写入失败: ' + e.message });
      }
    });
    return;
  }

  // 浏览器跨域预检一律拒绝（防 CSRF），其余 404
  if (req.method === 'OPTIONS') {
    return sendJson(res, 403, { success: false, error: 'forbidden' });
  }
  sendJson(res, 404, { success: false, error: 'not found' });
});

server.listen(cfg.port, cfg.host, () => {
  log(`[启动] Codex 登录态同步服务 v${VERSION}`);
  log(`[启动] 监听地址: http://${cfg.host}:${cfg.port}`);
  log(`[启动] 写入目标: ${path.join(cfg.codexHome, 'auth.json')}`);
  log(`[启动] 同步密钥: ${cfg.syncKey ? '已配置（见 config.json）' : '未配置（不推荐！）'}`);
});

server.on('error', (e) => {
  log(`[错误] 服务启动失败: ${e.message}`);
  process.exit(1);
});