# Sphinx RTD Theme 宽屏切换器

为使用 `sphinx_rtd_theme` 的 ReadTheDocs 文档站点提供宽屏模式切换，彻底解除正文区域 800px 宽度限制，支持滑块和预设值调节最大宽度。

**安装：** [点击安装（Greasy Fork）](https://greasyfork.org/zh-CN/scripts/578273-sphinx-rtd-theme-%E5%AE%BD%E5%B1%8F%E5%88%87%E6%8D%A2%E5%99%A8) | [直接安装（GitHub Raw）](https://raw.githubusercontent.com/i-square/userscripts-hub/main/readthedocs/readthedocs-wide-toggle.user.js)

---

## 功能

- **宽屏切换**：一键解除 `.wy-nav-content` 的 `max-width: 800px` 限制
- **自定义宽度**：通过滑块（600px ~ 2500px）或预设按钮（1000 / 1400 / 1800 / 100%）调节
- **设置持久化**：宽度和开关状态自动保存，跨页面、跨标签页生效
- **表格修复**：宽屏模式下自动解除 `.wy-table-responsive` 的横向滚动限制
- **精准定位**：控制按钮锚定在面包屑栏右上角，与页面原生元素对齐，不遮挡内容
- **主题检测**：只在检测到 `sphinx_rtd_theme` 特征选择器时才初始化，不干扰其他站点

## 使用方法

1. 打开任意 `*.readthedocs.io` 文档页面
2. 右上角出现绿色小按钮（显示 `<->`）
3. **点击按钮**切换宽屏模式开/关；按钮变蓝（显示 `>-<`）表示宽屏已启用
4. **悬停按钮**展开设置面板，通过滑块或预设按钮调整正文最大宽度

## 界面说明

| 控件                     | 说明                                                      |
| ------------------------ | --------------------------------------------------------- |
| 绿色/蓝色主按钮          | 切换宽屏开关；绿色 = 关闭，蓝色 = 开启                    |
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
- `GM_getValue` / `GM_setValue` — 持久化宽度配置

## 常见问题

**Q: 按钮没有出现？**  
A: 部分站点使用新版 RTD 主题，特征选择器不匹配，脚本会自动跳过。可在控制台确认是否存在 `.wy-nav-content`。

**Q: 宽度设置为 100% 后文字太宽难以阅读？**  
A: 推荐使用 1200px ~ 1600px 范围，在大屏幕上阅读体验最佳。

**Q: 表格内容仍然溢出？**  
A: 宽屏模式已自动为 `.wy-table-responsive` 解除 `overflow: auto`，若仍有问题可能是站点自定义 CSS 优先级更高。
