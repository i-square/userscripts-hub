# ReadTheDocs 宽屏 & 侧边栏增强

为 ReadTheDocs 文档站点提供宽屏模式切换与侧边栏一键隐藏，隐藏侧边栏时同步屏蔽 Ask AI 与版本浮窗。

**安装：** [点击安装（Greasy Fork）](https://greasyfork.org/zh-CN/scripts/578273) | [直接安装（GitHub Raw）](https://raw.githubusercontent.com/i-square/userscripts-hub/main/readthedocs/wide-sidebar/readthedocs-wide-sidebar.user.js)

---

## 功能

- **宽屏切换**：一键解除 `.wy-nav-content` 的 `max-width: 800px` 限制
- **自定义宽度**：通过滑块（600px ~ 2500px）或预设按钮（1000 / 1400 / 1800 / 100%）调节
- **侧边栏隐藏**：一键收起左侧导航栏，获得更大阅读区域
- **净化模式**：侧边栏隐藏时自动屏蔽 Ask AI 悬浮按钮与右下角版本选择浮窗
- **键盘快捷键**：按 `[` 快速切换侧边栏显隐
- **设置持久化**：所有状态自动保存，跨页面、跨标签页生效
- **表格修复**：宽屏模式下自动解除 `.wy-table-responsive` 的横向滚动限制
- **主题检测**：只在检测到 `sphinx_rtd_theme` 特征选择器时才初始化，不干扰其他站点

## 使用方法

1. 打开任意 `*.readthedocs.io` 文档页面
2. 右上角出现半透明齿轮按钮 ⚙️，悬停时高亮
3. **点击齿轮**展开设置面板
4. 面板内可切换侧边栏显隐、宽屏开关，以及调节最大宽度
5. 也可直接按 `[` 快速切换侧边栏

## 界面说明

| 控件                     | 说明                                                      |
| ------------------------ | --------------------------------------------------------- |
| ⚙️ 齿轮按钮               | 点击展开/收起设置面板，面板打开时齿轮旋转 90°             |
| 侧边栏                   | 切换左侧导航栏显隐；隐藏时同步屏蔽 Ask AI 与版本浮窗      |
| 宽屏模式                 | 切换宽屏开关                                              |
| 宽度滑块                 | 拖动调节 `max-width`，范围 600px ~ 2500px，释放后自动保存 |
| 1000px / 1400px / 1800px | 快速应用常用宽度预设                                      |
| 100%                     | 设置为 `9999px`，即浏览器视口满宽                         |

## 适用范围

匹配规则：

- `https://*.readthedocs.io/*`
- `https://readthedocs.io/*`

实际生效条件：页面同时存在 `.wy-nav-content`、`.wy-nav-content-wrap`、`.wy-breadcrumbs` 这三个选择器（即经典 `sphinx_rtd_theme` 特征）。

## 依赖权限

- `GM_addStyle` — 注入覆盖样式
- `GM_getValue` / `GM_setValue` — 持久化配置

## 常见问题

**Q: 按钮没有出现？**  
A: 部分站点使用新版 RTD 主题，特征选择器不匹配，脚本会自动跳过。可在控制台确认是否存在 `.wy-nav-content`。

**Q: 宽度设置为 100% 后文字太宽难以阅读？**  
A: 推荐使用 1200px ~ 1600px 范围，在大屏幕上阅读体验最佳。

**Q: 表格内容仍然溢出？**  
A: 宽屏模式已自动为 `.wy-table-responsive` 解除 `overflow: auto`，若仍有问题可能是站点自定义 CSS 优先级更高。
