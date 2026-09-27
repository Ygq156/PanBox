# PanBox · 多网盘统一下载管家

一个 Windows 桌面程序：把各网盘的**分享链接**粘进来 → 解析 → 用 **aria2** 多线程、断点续传地下载到本地，带实时进度和速度显示。

> **一句话定位**：用**你自己的账号**，拿到**你账号本身应有的最高速度**。
> 它**不是**"破解限速器"——网盘的限速是服务端按账号等级发放令牌决定的，任何客户端都改不了。

---

## 快速开始

1. 双击 `PanBox-0.1.0-portable.exe`（单文件便携版，免安装）
   - 或运行 `PanBox Setup 0.1.0.exe` 安装到系统
   - 首次运行 Windows SmartScreen 可能提示"未知发布者" → 「更多信息」→「仍要运行」
2. 把网盘分享链接粘进顶部输入框（**支持一行一个，批量解析**）
3. 有提取码就填在右边的「提取码」框里
4. 点「解析」→ 勾选要下载的文件 → 点「开始下载」

下载目录默认是 `<系统下载目录>\PanBox`，可以在「设置」里改。

---

## 支持的网盘

| 网盘 | 解析 | 下载 | 是否需要登录 | 实测速度 |
|---|---|---|---|---|
| **蓝奏云**（lanzoue/lanzoui/lanzoub/lanzouy…） | ✅ | ✅ 实测通过 | 不需要 | **10.01 MB/s**（132 MB 文件 15 秒，8 连接） |
| **蓝奏优享**（ilanzou.com / 飞机盘） | ✅ | ✅ 实测通过 | 不需要 | 端到端字节校验通过 |
| **夸克网盘**（pan.quark.cn） | ✅ | ✅ 实测通过 | **需要** | 免费账号约 0.8–1.3 MB/s（账号级令牌限速） |
| **UC 网盘**（drive.uc.cn） | ✅ | ✅ 实测通过 | **需要** | **0.82 MB/s**（25 MB 文件 42 秒，字节数完全一致） |
| **123 云盘**（123pan.com） | ✅ | ✅ | 不需要 | 真不限速，但受**分享者**每月 10 GB 提取配额限制 |
| **百度网盘**（pan.baidu.com） | ✅ 实测通过（含目录递归） | ✅ 实测通过 | **下载需要**（BDUSS），解析不需要 | 免费账号 **0.10 MB/s 平均、0.35 MB/s 峰值**（实测 60 秒 4.9 MB，已强制单线程） |
| **迅雷云盘**（pan.xunlei.com） | ✅ 实测通过（含目录递归） | ✅ 实测通过 | **需要**（账号 token），解析不需要 | **1.08 MB/s 平均、1.23 MB/s 峰值**（395 MB 文件，8 连接） |
| **直链**（任意 HTTP/HTTPS 文件地址） | ✅ | ✅ 实测通过 | 不需要 | 取决于源站（实测 3.22 MB/s） |
| 天翼 / 移动云盘 | ⬜ 未实现 | ⬜ | — | — |

### 为什么夸克/UC/百度"需要登录"

- **夸克**：CDN（`dl-*-zb.drive.quark.cn`）校验一个叫 `__puus` 的 cookie，而它是**网页 JS 动态生成的、登录时抓不到**。本程序在每次解析前会先在后台静默打开一次网盘首页，把这个令牌"暖"回来（实测约 2 秒），然后走「转存到你的网盘 → 取直链 → 下载 → **自动删除转存副本**」。
- **UC**：CDN 会把你的 Referer/Cookie/IP 拿去做回调鉴权（`auth-cdn.uc.cn/outer/oss/checkplay`），游客态一律回 `403 RequestDeniedByCallback: require login [auth not found]`。
- **百度**：官方接口的 dlink **必须**带 `User-Agent: pan.baidu.com`，且**按账号维度限速**——本程序对该任务强制 `split=1`、`max-connection-per-server=1`，因为并发调大只会招致几小时到几天的**惩罚性降速**。实测免费账号单线程只有 **0.10 MB/s**（60 秒下 4.9 MB），这是百度给免费账号的额度；想要快只能开会员，或在**官方 PC 客户端**里打开「设置 → 传输 → 下载提速」（见下面的 FAQ）。
  - 另外两个 2026 年的坑：① 取直链**不再**用 `/api/download?type=dlink&sign=…`（`/api/gettemplatevariable` 已经不返回 `sign` 字段，只会得到 `errno=113/2`），要改用 **`/api/filemetas?dlink=1&fsids=[…]`**，它直接返回 `https://d.pcs.baidu.com/file/…?fid=…&sign=…`；② 收割 cookie 必须**按 URL 作用域**（`cookies.get({url:'https://pan.baidu.com/'})`），把 `passport.baidu.com`/`pcs.baidu.com` 那些域的 cookie 一起发给 `pan.baidu.com` 会被判 **`errno=-6 身份验证错误`**（实测 2068 字符全量 → -6，1410 字符作用域内 → 成功）。
  - 转存目标目录 `/PanBox` 不存在时 `/share/transfer` 会回 `errno=2 转存路径不存在`，所以程序会先调 `/api/create` 建目录；`errno=12`（同名文件已存在）和 `errno=4`（文件已转存）都按成功处理，并且**只有本次新出现的 fs_id 才会被登记回收**，绝不会删掉你本来就有的文件。
- **迅雷**：分享可以完全匿名浏览（文件名、体积、目录都能读到），但**转存和取直链的接口一律回 401**，必须用你自己的账号。凭证在浏览器 localStorage 里（不是 cookie），所以登录窗口走的是读 localStorage 的通道。取直链的 `client_id` 也必须跟网页版一致（`Xqp0kJBXWhwaTpB6`），安卓 App 的 `captcha_sign` 配上网页 `client_id` 会被服务端判 `invalid captcha_sign`。下载时直链**只认安卓 Dalvik UA**，用浏览器 UA 会在十几秒后回 `503`。

### 怎么登录

打开软件 → 右上角「设置」→「网盘账号」→ 在对应的网盘那一行点「登录{网盘名}」→ 在弹出的窗口里正常登录 → 检测到登录态后窗口自动关闭、凭证自动写入。
（也可以手动把 Cookie 字符串粘进输入框。）

> ⚠️ 夸克的 `__puus` 是**会话级** cookie，程序退出后可能失效。如果下载时提示"登录凭证已失效"，重新点一次「登录夸克网盘」或直接重新解析即可——程序会自动重新生成。

### 不会污染你的网盘

夸克 / UC / 百度 / 迅雷 只能靠「转存到你自己网盘 → 取直链」拿到可下载的地址，这会往你网盘里放一份副本。本程序保证**用完就删**：

- 转存**之前**先给目标目录拍快照，只有「转存之后新出现的文件」才会被登记为待删——**用户自己原有的同名文件绝不会被误删**。
- 转存后若因同名冲突被系统改名成 `xxx(1).zip`，也能正确认领并回收（早期版本会漏掉这种，已在 `electron/parsers/clouddrive.js` 的 `sameName()` 里修好）。
- 三个回收时机都覆盖到了：① 任务 `complete` 后 800ms 内；② **你在下载途中点「✕ 删除」撤销任务时立刻回收**（早期版本漏了这条，中途取消会把副本永久留在网盘里）；③ 退出程序时 `before-quit` 对已完成任务补收一次。
- **未完成又被撤销的任务会回收，未完成且还在队列里的不会回收**——后者还需要那份副本续传，绝不能删。
- 百度/迅雷这类「一次转存整批」的网盘只发**一次**转存请求和**一次**取直链请求（早期版本是每个文件各来一遍，8 个文件的目录分享要打 16 轮 API）；回收时也是一次请求删掉整批。
- 兜底工具：`electron test/cleanup-quark-junk.js [文件名关键词]`（不带参数只列出、带参数才删，且不碰文件夹）。

### 其他开关

「设置 → 下载完成后打开文件夹」打开后，每个任务首次完成时会自动打开它的下载目录。

---

## 用你自己的「解析接口」跑满带宽（可选）

先说清楚 PanBox 内置解析的**天花板**：它走的是「用**你自己的账号**登录 → 转存 → 取签名直链」，
所以拿到的速度就是你这个账号的档位。实测夸克 0.6–1.4 MB/s、UC 0.82 MB/s、百度 0.10 MB/s，
把连接数从 1 加到 15 也几乎不变（服务端按账号限量，不是客户端限速）。这是**账号权限**问题，加线程解决不了。

Motrix / Gopeed 这类下载器「不用登录还能跑满」，秘密不在下载器里：它们把分享链接**转发给一个解析站**，
解析站用自己的（通常是 SVIP）账号取出一条直链还回来，下载器只管下。谁付带宽、用谁的账号，
取决于你配的那个服务。

PanBox 从 v0.4.0 起支持同样的模式：

**设置 → 已保存的网盘解析接口 → ＋ 添加接口**，填上接口地址即可。

- **地址与请求体支持占位符**：`{url}`（完整分享链接）、`{pwd}`（提取码）、`{shareId}`、`{netdisk}`。
  例如 `https://example.com/api?url={url}&pwd={pwd}`，或 POST + 请求体 `url={url}&pwd={pwd}`。
- **响应自动识别**：JSON 里的 `url` / `dlink` / `download_url` / `downurl` / `link` / `direct_url` … 都会被认出来；
  也支持数组（目录分享一次返回多个文件）和 `data.url`、`data.list[0].url` 这种嵌套。认不出来时可以手填字段路径。
- **适用网盘**：不勾 = 全部；**直链默认不走接口**（本来就能直接下，送去解析只会弄坏），要走得显式勾上「直链」。
- **优先级**：配了解析接口就先走接口，接口挂了会**自动退回内置解析**，界面上会提示失败原因。
- **下载直链的请求头**（Referer / UA / Cookie 之类）也可以按接口单独配。
- 走接口拿到的直链**不受百度的单线程限制**——限速档位是对方账号的，再限成单线程就白配了。

> ⚠️ PanBox **不内置、也不推荐任何具体解析站**，接口地址完全由你提供，程序只做转发。
> 请自行确认所用服务的合规性 —— 使用他人会员账号取链可能违反对应网盘的服务协议。
> 作者不为任何第三方解析服务背书，也不对其可用性与合法性负责。

---

## 常见问题

**Q：为什么下载速度没有突破网盘限制？**
A：因为做不到。网盘限速是**服务端按账号等级发放令牌**决定的，不是客户端代码限速。第三方工具能拿到直链，但直链背后仍是该账号的权限。多线程只在"单连接限速"型网盘上有用（把一根水管切成多段并行）；对"账号级总量限速"型（百度/夸克/UC）无效，对百度**反而有害**。

**Q：那 PanBox 有什么用？**
A：① 一个入口管所有网盘，不用装 6 个客户端；② 批量解析、批量下载、统一队列；③ 多线程 + 断点续传 + 实时速度；④ 对不限速盘（蓝奏云、123 云盘、天翼等）是真满速；⑤ 自动清理转存副本，不污染你的网盘。

**Q：百度网盘有官方免费提速吗？**
A：有。打开百度网盘 **Windows 客户端 → 设置 → 传输 → 下载提速**，用闲置上传带宽换下载（100M 宽带实测 8–10 MB/s）。这是官方的、合法的。**没有 API 可以程序化开启**，需要你手动开一次。

**Q：会读取/上传我的账号信息吗？**
A：不会。所有凭证只存在本机 `%APPDATA%\PanBox\settings.json`，所有请求都由本机直接发往网盘官方接口，没有任何中间服务器。

**Q：转存会不会把我的网盘塞满？**
A：不会。下载完成后程序会**自动删除**它转存进去的副本（这个闭环有自动化测试 `test/verify-recycle.js` 验证）。程序只会复用根目录里已有的 `PanBox` 文件夹，不会新建。

---

## 技术栈

- **壳**：Electron 44（`contextIsolation: true`、`nodeIntegration: false`）
- **界面**：React 19 + TypeScript + Vite 8
- **下载引擎**：内置 **aria2 1.37.0**（通过 JSON-RPC 控制，随机 token 鉴权、只监听 127.0.0.1）
- **解析层**：`electron/parsers/` 下每个网盘一个模块，纯 Node 实现

解析规格来源（均为开源项目，MIT / 参考实现）：
- 蓝奏云：`qaiu/netdisk-fast-download` 的 `LzTool.java`
- 蓝奏优享：`qaiu/netdisk-fast-download` 的 `IzTool.java` + `AESUtils.java`
- 夸克 / UC：`qaiu/netdisk-fast-download` 的 `QkTool.java` / `UcTool.java`，以及 `muyan556/gopeed-extension-quark`（MIT）
- 123 云盘：`qaiu/netdisk-fast-download` 的签名算法
- 百度网盘：`pan.baidu.com/union` 开放平台文档 + 社区实现

---

## 目录结构

```
panbox/
├─ electron/                 主进程（CommonJS）
│  ├─ main.js                BrowserWindow + 全部 IPC + 转存副本回收
│  ├─ preload.js             contextBridge → window.panbox
│  ├─ core/
│  │  ├─ aria2.js            aria2 子进程管理 + JSON-RPC
│  │  ├─ taskManager.js      任务轮询（800ms）与状态归一化
│  │  ├─ settings.js         %APPDATA%\PanBox\settings.json
│  │  └─ login.js            内置登录窗口 + 短效令牌"预热"（__puus）
│  └─ parsers/
│     ├─ index.js            会话管理、批量解析、转存回收出口
│     ├─ lanzou.js / ilanzou.js
│     ├─ clouddrive.js       夸克 + UC
│     ├─ pan123.js / baidu.js / xunlei.js / direct.js
│     ├─ custom.js           用户自备的「解析接口」适配层
│     ├─ util.js             HTTP/UA/Jar/识别
│     └─ esa.js              ESA 反爬 acw_sc__v2
├─ src/                      渲染层（React + TS）
├─ resources/aria2/aria2c.exe （自行下载，不入库）
└─ build/icon.ico
```

---

## 开发与构建

需要 **Node.js ≥ 22.12**（Vite 8 的 rolldown 与 electron-builder 依赖链的要求）。

```bash
npm install          # 装依赖（国内可用 --registry=https://registry.npmmirror.com）

npm run build:renderer                      # 渲染层构建
npx tsc --noEmit -p tsconfig.json           # 类型检查
npm run pack                                # 打包（NSIS 安装版 + 单文件便携版）

# 国内镜像（Electron 二进制很大，建议设上）
export ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
export ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

> 🔴 **如果你的 shell 里存在 `ELECTRON_RUN_AS_NODE`，跑任何 Electron 命令前必须删掉它** —— 这个环境变量会让 `electron.exe` 退化成纯 Node 然后立刻退出（表现成"程序启动即退"）。
> 另外 Electron 在 Windows 上是 GUI 子系统程序，脚本里调它必须用 `Start-Process -FilePath <绝对路径> -Wait -PassThru -RedirectStandardOutput/-RedirectStandardError`，`&` 和 `*>` 都拿不到输出。

### aria2

`resources/aria2/aria2c.exe`（aria2 1.37.0，Windows x64）**不在仓库里**，需要自行下载放到该路径：

```powershell
curl.exe -L -o aria2.zip https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip
Expand-Archive aria2.zip -DestinationPath aria2-tmp -Force
New-Item -ItemType Directory -Force resources\aria2 | Out-Null
Copy-Item aria2-tmp\aria2-1.37.0-win-64bit-build1\aria2c.exe resources\aria2\aria2c.exe
```

### 测试（`test/` 目录未随仓库发布）

```powershell
node test\smoke-parsers.js                                  # 离线冒烟：25 项
node test\verify-custom-endpoint.js                         # 自定义解析接口：19 项（起本地 http 冒充解析站，不碰第三方）
node test\batch-live.js --only ilanzou --dl                 # 真实链接批量解析
node test\probe-parse-node.js <链接> --dl                   # 单条解析（纯 node）

# 端到端真实下载（需要 Electron）
Remove-Item Env:ELECTRON_RUN_AS_NODE
Start-Process node_modules\electron\dist\electron.exe `
  -ArgumentList 'test\e2e-netdisk.js','https://dmla.lanzouy.com/b05qmjg9i' `
  -WorkingDirectory $PWD -NoNewWindow -Wait

# 界面级端到端（真的开窗口、点按钮、截图）
#   ⚠️ 参数一律走环境变量：Start-Process -ArgumentList 传数组时是空格拼接，
#      Chromium 的命令行解析器会把 https://… 这种位置参数吃掉，
#      结果是 Electron 根本不加载脚本（exit -1、stdout/stderr 全空）。
$env:PANBOX_UI_SHARE='https://www.ilanzou.com/s/1kTy3Cxf'
$env:PANBOX_UI_OUT="$PWD\dl\ui-e2e"
Start-Process node_modules\electron\dist\electron.exe `
  -ArgumentList 'test\ui-e2e.js' `
  -WorkingDirectory $PWD -NoNewWindow -Wait
```

| 脚本 | 用途 |
|---|---|
| `smoke-parsers.js` | 离线冒烟（模块加载、识别、AES 往返、crc32 向量…） |
| `verify-custom-endpoint.js` | 自定义解析接口：19 项（本地 http 冒充解析站，覆盖字段识别/嵌套/数组/错误码/优先级/退回内置） |
| `e2e-netdisk.js` | **真实网盘**端到端：解析 → 直链 → aria2 多线程 → 字节校验 |
| `ui-e2e.js` | **界面级**端到端：开真窗口 → 填链接 → 点「解析」→ 点「开始下载」→ 校验文件 → 截图 |
| `verify-recycle.js` | 验证"转存副本自动回收"闭环 |
| `verify-baidu-recycle.js` | 百度：批量转存 + 取直链 + 回收闭环（目录分享一次转存 8 个文件） |
| `verify-uc-recycle.js` | UC / 夸克：转存 + 取直链 + 回收闭环 |
| `verify-xunlei-recycle.js` | 迅雷：转存 + 取直链 + 回收闭环 |
| `ui-cancel-recycle.js` | **界面级**：下载途中撤销任务 → 确认转存副本也被回收 |
| `verify-login-refresh.js` | 验证 `__puus` 重新生成 + UC 凭证探查 |
| `login-and-save.js` | 打开登录窗口并把 cookie 写进 settings |
| `batch-live.js` | 批量真实链接解析 |
| `probe-*.js` | 各类协议探针（保留作为回归证据） |


---

## 已知限制

- **夸克/UC/百度/迅雷必须登录**，游客直链会被 CDN 拒绝（412 / 403 / 401）；走你自己的「解析接口」时不受这条约束。
- **账号级限速是硬天花板**：内置解析拿到的直链速度取决于你自己账号的档位（实测夸克 0.6–1.4 MB/s、百度 0.10 MB/s），
  加连接数无效。想突破只能用第三方解析接口（见上文），那是别人的账号在付带宽，请自行判断合规性。
- **123 云盘**的直链受**分享者**的每月提取流量配额限制（免费 10GB/月），配额用完就是"分享方提取流量包不足"，无解。
- **天翼云盘 / 移动云盘**尚未实现。
- 应用未做代码签名，首次运行会触发 SmartScreen。
- 不支持（也不打算支持）任何"破解会员""秒传""变速外挂"类功能——技术上对 2026 年的服务端限速模型已失效，且 `PanDownload` 作者 2020 年因《刑法》第 285 条第 3 款被捕。
