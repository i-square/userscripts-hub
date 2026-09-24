# ChatGPT Codex 登录态同步

自动提取 ChatGPT 网页会话 Token，在浏览器内组装为 Codex `auth.json`，推送到本机（或局域网）微型同步服务并安全写入 `~/.codex/auth.json`。全流程本地完成，不经过任何第三方服务器。

**安装（油猴脚本）：** [直接安装（GitHub Raw）](https://raw.githubusercontent.com/i-square/userscripts-hub/main/chatgpt/codex-auth-sync/chatgpt-codex-auth-sync.user.js)

---

## 组成

| 文件 | 作用 |
| ---- | ---- |
| `chatgpt-codex-auth-sync.user.js` | Tampermonkey 脚本：打开 chatgpt.com 后自动检查登录态，按间隔推送 token |
| `server/codex-auth-server.js` | 零依赖 Node.js 微服务：接收推送，校验后备份并原子写入 `auth.json` |
| `server/install-autostart.ps1` | 注册"登录时自动启动服务"计划任务（隐藏窗口，无需管理员） |
| `server/uninstall-autostart.ps1` | 移除上述计划任务 |

## 工作原理

1. 你正常打开 chatgpt.com（保持登录），脚本在页面加载后自动检查会话；
2. 距上次成功推送超过「推送间隔」（默认 24 小时）时，自动从 `/api/auth/session` 取最新 accessToken，组装成 auth.json，POST 到同步服务；
3. 服务端校验共享密钥、JWT 结构与有效期，备份旧文件后原子写入 `~/.codex/auth.json`；
4. 每次推送都是全新的 10 天有效期 token——只要间隔期内打开过 chatgpt.com，登录态就永续保鲜。

> 也可随时打开面板点「立即推送」手动触发；「复制 auth.json」在服务不可用时兜底。

## 部署步骤

1. **安装油猴脚本**：点击上方安装链接。
2. **启动服务端**（需要本机装有 Node.js）：
   ```
   node server/codex-auth-server.js
   ```
   首次运行会在 `server/` 下生成 `config.json`，内含**随机同步密钥**并打印到控制台。
3. **把同步密钥填入脚本**：打开 chatgpt.com，点击右下角半透明齿轮 → 设置中填写「同步密钥」（与 `config.json` 的 `syncKey` 一致）→ 保存设置。
4. **（可选）开机自启**：右键用 PowerShell 运行 `server/install-autostart.ps1`，之后每次登录系统自动启动服务。`uninstall-autostart.ps1` 可移除。

## 脚本设置说明

| 设置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| 服务器地址 | `http://127.0.0.1:18765` | 跨机器使用时填 `http://<局域网IP>:18765`，且服务端 `config.json` 的 `host` 需改为 `0.0.0.0` |
| 同步密钥 | 空 | 必须与服务端 `syncKey` 一致（服务端未配密钥时可为空，不推荐） |
| 自动检查 | 开启 | 页面加载后及常驻期间自动检查登录态；关闭后仅保留手动「立即检查」 |
| 自动推送 | 开启 | 检查达「推送间隔」后自动推送；关闭后只检查不推送 |
| 首检延时(秒) | 3 | 页面加载后首次自动检查的延时 |
| 复查间隔(分) | 30 | 页面常驻期间自动复查的间隔 |
| 推送间隔(时) | 24 | 距上次成功推送超过该小时数才再次推送；间隔越小 auth.json 越新鲜 |

> 跨机器首次推送时 Tampermonkey 会弹窗询问是否允许连接该域名，选择「总是允许」即可。

## 安全设计

- **纯本地链路**：token 只从浏览器发往 `127.0.0.1`（或你自己指定的局域网地址），不出内网；
- **共享密钥**：服务端校验 `X-Sync-Key` 头，且刻意不返回 CORS 头——普通网页跨域请求会被浏览器预检拦截，防止任意网站往你本地写文件；
- **写入校验**：JWT 三段结构、`exp` 有效期（不足 1 小时拒绝）、`auth_mode` 逐一校验；
- **备份与原子写入**：旧文件备份为 `auth.json.bak_时间戳`（保留最近 10 份），临时文件 + 重命名替换，不会写出半个文件；
- **不碰其他配置**：只写 `auth.json`，绝不修改 `config.toml`；
- **日志脱敏**：服务端日志只记录账号 ID 与剩余天数，不记录 token 本体。

## 注意事项

- 该 auth.json 的 `refresh_token` 是占位符，Codex 无法自行刷新——这正是需要本工具持续推送的原因；
- access token 有效期固定 10 天，请保证「推送间隔 < 10 天」，且间隔期内至少打开一次 chatgpt.com；
- 脚本面板的「测试连接」可随时确认服务在线状态。