# dsh-tavern-image-dock

DSH Tavern 的**侧栏生图面板**：把当前这一局生成的插图钉在右侧栏，正文滚走了图还在；顺手能手动补画一轮，也能把原图存成 PNG。

> 它自己不出图，是给配图插件 `dsh-tavern-image` 加的一块「一直看得见」的展示与导出面板。

## 功能

- **侧栏常驻大图**：跟随最新一张，按侧栏宽度铺满；可切成「整张放进一屏」，选择记在本机。
- **历史缩略图**：这一局画过的图都在，点一下钉住某张，或回到「跟随最新」。
- **出图进度**：排队 / 出图中显示状态与百分比，出图后自动换成成品；一直 0% 的卡死作业可以单独收起。
- **手动补画**：面板里「画一张（第 N 轮）」给最新写完的那轮补图；正文每条回复下方的「画图」可以给那一轮补图（也支持回头补旧轮）。
- **存成 PNG**：单张「存成 PNG」，或「一键生成」把这一局的图全部落盘；同名不覆盖。

## 依赖

**需要先安装配图插件 [`dsh-tavern-image`](https://github.com/weixinlll/dsh-tavern-image)。** 本面板读写的是它对外开放的这几个地址与缓存：

| 用途 | 接口 |
|---|---|
| 作业列表（轮次 / 状态 / 进度） | `GET /plugins/dsh-tavern-image/history` |
| 图片本身 | `GET /plugins/dsh-tavern-image/jobs?id=…&image=1` |
| 手动补画 | `POST /plugins/dsh-tavern-image/attach-turn` |
| 导出原图 | 读 `plugins/dsh-tavern-image/cache/<作业号>.img`（内容是 PNG 原图） |

这些是该插件给自己的界面用的地址，不属于 Tavern 的插件接口，**它改结构后本插件会读不到图**（面板会显示「没读到配图插件的图库」）。换别的配图插件时改 `client.js` 里的 `IMAGE_PLUGIN` 常量和 `index.mjs` 里的 `SOURCE_DIR` 即可。

另外也会读取 Tavern 自带生图的旧插图（`tavernUi.listIllustrations()`，插件接口第 4 版起），有就一起列出，没有也不影响。

## 安装

打开 DSH Tavern → 设置 → DSH Tavern → 插件，粘贴本仓库地址，点「安装」，刷新页面。
连不上 GitHub 时，下载本仓库 ZIP，在同一处点「上传 ZIP」。

装好后**重启一次 DSH**（`index.mjs` 里的导出功能是宿主侧代码，只在启动时加载），然后 侧栏「＋」→「插件」→「生图」。

## 导出文件写到哪

- 目录：`$DSH_HOME/dsh-tavern-images/`；没设 `DSH_HOME` 时是 `~/.dsh/dsh-tavern-images/`，首次导出自动创建。
- 文件名：`第15轮_20261026-0341_2190fef1.png`（轮次 + 出图时间 + 作业号前 8 位）。
- 存的是**配图插件的原图**（1.5–2 MB 的 PNG），不是聊天里约 150 KB 的 WebP 副本。
- 同名已存在会跳过，不覆盖。

## 兼容性

- Tavern 插件接口：`registerPanel` / `watchTurnState` / `callHost` 需第 2 版及以上。
- 桌面版、命令行版、Android 通用（`dsh.client.platform` 固定为 `web`）。
- 不写 `dependencies`，没有密钥；不上传任何数据，只读本机配图插件的图，只往本机磁盘写 PNG。

## 已知限制

- 只显示当前打开的这局；换局自动换图。
- 配图插件的 `/history` 只保留最近 60 条作业，更早的图不在缩略图里。
- Tavern 自带生图的旧插图不在配图插件缓存里，导不出（只显示）。
- 「两次出图请求之间至少隔 5 秒」不在本插件内——那是需要直接改配图插件的行为，本插件不包含。

## 许可

MIT
