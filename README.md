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
| **夸克网盘**（pan.quark.cn） | ✅ | ✅ 实测通过 | **需要** | **4.44 MB/s 峰值 / 96 连接**（15.1 MB 文件 3.4 秒，分段引擎；aria2 的 16 连接只能到 0.8 MB/s） |
| **UC 网盘**（drive.uc.cn） | ✅ | ✅ 实测通过 | **需要** | **5.26 MB/s 峰值 / 96 连接**（25.2 MB 文件 4.8 秒，分段引擎；aria2 的 16 连接只能到 0.82 MB/s） |
| **123 云盘**（123pan.com） | ✅ | ✅ | 不需要 | 真不限速，但受**分享者**每月 10 GB 提取配额限制 |
| **百度网盘**（pan.baidu.com） | ✅ 实测通过（含目录递归） | ✅ 实测通过 | **下载需要**（BDUSS），解析不需要 | 免费账号 **0.10 MB/s 平均、0.35 MB/s 峰值**（实测 60 秒 4.9 MB，已强制单线程） |
| **迅雷云盘**（pan.xunlei.com） | ✅ 实测通过（含目录递归） | ✅ 实测通过 | **需要**（账号 token），解析不需要 | **1.08 MB/s 平均、1.23 MB/s 峰值**（395 MB 文件，8 连接） |
| **直链**（任意 HTTP/HTTPS 文件地址） | ✅ | ✅ 实测通过 | 不需要 | 取决于源站（实测 3.22 MB/s） |
| 天翼 / 移动云盘 | ⬜ 未实现 | ⬜ | — | — |

### 为什么夸克 / UC 能跑到 4–5 MB/s，而百度不行

实测结论（2026-09 反复测量）：**"账号级总量限速"这个说法只对百度成立。**

- **夸克 / UC 是「按每条 TCP 连接」发额度的**：实测夸克 ≈50 KB/s/条、UC ≈64 KB/s/条。所以
  **连接数就是速度**。而 aria2 的 `--max-connection-per-server` 最大只能填 **16**，于是被钉死在
  ~0.8 MB/s —— 这不是账号的额度，是 aria2 的限制。PanBox 因此自带了一个**分段下载引擎**
  （`electron/core/segmentDownloader.js`，`node:http` 直连、`agent:false` 保证 N 个请求 = N 条 TCP），
  默认给夸克/UC 开 **96 连接**，实测 0.8 → **4.4–5.3 MB/s**。连接数在「设置 → 分段下载连接数」里改。
- **百度是真正的账号级总量限速**：1 / 2 / 4 / 8 连接都是 **0.08 MB/s**，16 / 24 连接直接回 **403**。
  多开连接不会更快，只会招来几小时到几天的**惩罚性降速**。本程序对百度强制 `split=1`、
  `max-connection-per-server=1`，并且**不走分段引擎**。
- **迅雷**是第三种：**8 连接之后就到顶了**——1/2/4/8 连接是 0.15 / 0.29 / 0.56 / **1.09 MB/s**（近似线性，
  说明这一段确实按连接发额度），但 16 连接只到 1.17 MB/s（+7%），而且 16/32 都开始零星回 **503**。
  也就是说它的天花板是**账号级 ~1.1–1.2 MB/s 的总量**，再加连接没有意义还有风险，
  所以迅雷的连接数故意压在 8，并且**不走分段引擎**。
- **蓝奏云 / 直链**不按连接发额度，多开只是抗抖动，实测已经是 10 MB/s / 3.2 MB/s 档。

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
  - 快路（v0.5.0 起）：`share/save` 的响应里**直接带回落盘的 fid**（`save_as_top_fids`），不用再傻等目录索引；只有在拿不到 fid（比如转存的是目录）时才退回轮询目录。这同时修掉了「夸克索引慢 → 报『未返回下载直链』→ 那份副本因为没被登记而永久留在网盘里」这个坑。
  - 判断依据是响应的 `search_exit`：`false` = 服务端没找到同名文件，落盘的就是我们造的副本，才登记待删；`true` 表示命中了用户原有的文件，绝不登记。
- 转存后若因同名冲突被系统改名成 `xxx(1).zip`，也能正确认领并回收（早期版本会漏掉这种，已在 `electron/parsers/clouddrive.js` 的 `sameName()` 里修好）。
- 删除请求会**重试 4 次 ×1.2 秒**：转存刚落盘就删，夸克偶发回非 0（索引还没就绪），"用完就删"这条承诺不能因为一次抖动就断掉。
- 三个回收时机都覆盖到了：① 任务 `complete` 后 800ms 内；② **你在下载途中点「✕ 删除」撤销任务时立刻回收**（早期版本漏了这条，中途取消会把副本永久留在网盘里）；③ 退出程序时 `before-quit` 对已完成任务补收一次。
- **未完成又被撤销的任务会回收，未完成且还在队列里的不会回收**——后者还需要那份副本续传，绝不能删。
- 百度/迅雷这类「一次转存整批」的网盘只发**一次**转存请求和**一次**取直链请求（早期版本是每个文件各来一遍，8 个文件的目录分享要打 16 轮 API）；回收时也是一次请求删掉整批。
- 兜底工具：`electron test/cleanup-quark-junk.js [文件名关键词]`（不带参数只列出、带参数才删，且不碰文件夹）。

### 其他开关

「设置 → 下载完成后打开文件夹」打开后，每个任务首次完成时会自动打开它的下载目录。

---

## 浏览器插件：在网页上直接「用 PanBox 下载」

PanBox 自带一个浏览器插件（`resources/extension/`，随安装包发布），装好之后你可以在 Chrome / Edge 里
右键任意链接、视频、音频，或者直接接管浏览器的下载，**把任务丢给 PanBox 去下**——包括需要页面的
`Referer` / `Cookie` 才肯放行的站点（这正是 NDM 那类工具好用的地方）。

### 装插件（30 秒，只能手动装一次）

1. 打开 PanBox → **设置 → 浏览器插件 → 打开插件文件夹**。
2. 浏览器地址栏输入 `chrome://extensions`（Edge 是 `edge://extensions`），打开右上角**开发者模式**。
3. 点**加载已解压的扩展程序**，选中第 1 步打开的那个 `extension` 文件夹。
4. 点插件图标 → 「重新配对」→ 看到**已连接 PanBox · 127.0.0.1:7799** 就好了。

> Chrome 137 起**命令行侧载已被彻底禁用**（`--load-extension` 无效），只能走上面的界面操作。
> PanBox 的这条通道只监听 `127.0.0.1`，并且每次投递都要带一个配对令牌；令牌只会发给带
> `chrome-extension://` / `edge-extension://` 来源的请求（或插件后台进程那种不带 `Origin` 的本机请求）。
> 普通网页发起的跨站请求一定带自己的 `Origin`，会被直接回 `403 只给浏览器插件配对`。

### 怎么用

- **页面角落的「N 个文件」悬浮面板**（v0.6.1 起默认开启）：每个网页左上角都会浮出一个小药丸，
  上面写着这一页发现了多少个可下的东西。点开就是一张列表——视频 / 音频的真实地址、`.m3u8` 播放列表、
  `.ts` / `.m4s` 分片、以及页面里那些 `.zip` / `.7z` / `.apk` / `.pdf` 链接，每条右边一个「下载」按钮，
  点一下就直接进 PanBox。面板可以拖动，✕ 可以在这个站点上收起来（在插件弹窗里能重新打开）。
  > 像 B 站、YouTube 这种用 MSE 播放的站点，`<video>` 上挂的是 `blob:` 地址，离开页面就失效，
  > 谁都下不了——面板会改列它在网络请求里**抓到的分片**（`.ts` / `.m4s`），那些是能下的。
- **右键链接 → 「用 PanBox 下载」**：把这条链接交给 PanBox，页面地址与 Cookie 一并带过去。
- **右键视频 / 音频 → 「用 PanBox 下载」**：抓 `<video>`/`<audio>` 的真实地址。
- **右键页面 → 「把本页的文件链接都交给 PanBox」**：页面上按扩展名识别出来的文件链接（`.zip` / `.7z` /
  `.apk` / `.mp4` / `.pdf` …）一次全交过去。
- **点插件图标 → 「把本页媒体 / 文件链接交给 PanBox」**：同上，但用弹窗按钮触发。
- **接管浏览器下载**（**v0.6.1 起默认开启**）：浏览器里点任何下载——比如 GitHub 的 **Download ZIP**——
  都会**取消浏览器自己的下载**并把任务转进 PanBox。要是 PanBox 没在运行，插件会**把下载放回浏览器**，
  绝不让你的下载凭空消失。不想用了在插件弹窗里关掉即可。

投递过来的如果是**网盘分享链接**，PanBox 不会擅自决定给你下什么——它会唤起主窗口、把链接预填进输入框，
让你自己点「解析」挑文件。

### 直链下载

上面这条通道的另一半是：PanBox 的链接框**本来就吃任意 `http(s)` 直链**（不用插件也行，粘进去点「解析」
就能多线程下）。插件只是把这一步自动化了，并且顺手把页面 `Referer`、`Cookie`、浏览器 `User-Agent`
一起带过来——很多站点正是靠这几个头做防盗链。

---

## 用你自己的「解析接口」跑满带宽（可选）

先说清楚 PanBox 内置解析的**天花板**：它走的是「用**你自己的账号**登录 → 转存 → 取签名直链」，
所以拿到的速度就是你这个账号的档位。实测**百度 0.10 MB/s**（账号级总量限速，加连接反而 403）、
**迅雷 1.1 MB/s**（8 连接最好，再多回 503）、**夸克 4.4 / UC 5.3 MB/s**（96 连接，已经接近家用宽带）。
前两个是**账号权限**问题，加线程解决不了；后两个已经用满了你自己账号该有的速度。

如果一个网盘你也只能跑到 0.1 MB/s 这种档位，而你又愿意信任某个第三方解析服务，可以用下面的模式。

Motrix / Gopeed 这类下载器「不用登录还能跑满」，秘密不在下载器里：它们把分享链接**转发给一个解析站**，
解析站用自己的（通常是 SVIP）账号取出一条直链还回来，下载器只管下。谁付带宽、用谁的账号，
取决于你配的那个服务。

PanBox 从 v0.4.0 起支持同样的模式：

**设置 → 已保存的网盘解析接口 → ＋ 添加接口**，填上接口地址即可。

- **地址与请求体支持占位符**：`{url}`（完整分享链接）、`{pwd}`（提取码）、`{shareId}`、`{netdisk}`。
  例如 `https://example.com/api?url={url}&pwd={pwd}`，或 POST + 请求体 `url={url}&pwd={pwd}`。
- **响应自动识别**：JSON 里的 `url` / `dlink` / `directLink` / `downLink` / `downloadLink` / `download_url` /
  `downurl` / `real_url` / `link` / `parserUrl` … 都会被认出来；也支持数组（目录分享一次返回多个文件）和
  `data.url`、`data.list[0].url` 这种嵌套。认不出来时可以手填字段路径。
  - 如果接口直接 **302 重定向**到直链（不少解析站是这种），也会自动跟上。
  - 上面这些字段名覆盖了这类接口最常见的两种响应形状
    （`{code,msg,data:{directLink,…}}` 和 `{code,msg,data:{downLink,…}}`）；
    同一种形状里的 `apiLink`（不是下载地址）**不会**被误认成直链。
- **适用网盘**：不勾 = 全部；**直链默认不走接口**（本来就能直接下，送去解析只会弄坏），要走得显式勾上「直链」。
- **优先级**：配了解析接口就先走接口，接口挂了会**自动退回内置解析**，界面上会提示失败原因。
- **下载直链的请求头**（Referer / UA / Cookie 之类）也可以按接口单独配。
- 走接口拿到的直链**不受百度的单线程限制**——限速档位是对方账号的，再限成单线程就白配了。
- **首次启用要勾选下面的「用户承诺」**，不勾不允许保存。

### 合规边界（请先读这一段再用上面的功能）

PanBox 是一个**下载客户端**。它自己不做、也永远不会做下面这些事：

- ❌ 不内置、不默认启用任何解析服务，不提供解析站目录 / 市场 / 推荐；
- ❌ 不代收费用、不从解析服务分成、不为任何解析站引流；
- ❌ 不做「破解会员 / 秒传 / 伪造身份 / 变速外挂」类功能（服务协议明确禁止逆向，且这类手段对 2026 年的服务端限速模型已经失效）；
- ❌ 不帮助批量获取、转售他人网盘资源。

**用户承诺**：启用「解析接口」即表示你确认并同意——

1. 只用它下载**你自己有权下载**的内容；
2. **不**用于规避网盘会员 / 限速机制，也**不**用于获取、传播、转售他人受版权保护的资源；
3. 接口地址由你自己提供并自行确认合法性；PanBox 只做 HTTP 转发，不看、不存、不校验它返回什么。

> ⚠️ PanBox **不内置、也不推荐任何具体解析站**，接口地址完全由你提供，程序只做转发。
> 请自行确认所用服务的合规性 —— 使用他人会员账号取链可能违反对应网盘的服务协议。
> 作者不为任何第三方解析服务背书，也不对其可用性与合法性负责。
> 另外：填了提取码时**提取码会连同分享链接一起发给你配置的这个接口**（否则它取不到链）；
> 你自己的网盘 Cookie 只在本机使用，**不会**被发往接口。

---

## 常见问题

**Q：为什么下载速度没有突破网盘限制？**
A：因为做不到。网盘限速是**服务端**决定的，不是客户端代码限速。第三方工具能拿到直链，但直链背后仍是该账号的权限。不过"加线程有没有用"要分盘看，PanBox 的做法是**逐盘标定**：夸克/UC 是**按每条 TCP 连接**发额度（多开就快，已实测 0.8 → 5 MB/s），百度是**账号级总量**限速（多开反而 403），迅雷是 8 连接最好（再多 503），蓝奏云/直链不按连接发额度。所以 PanBox 给不同网盘配了不同的连接数，并且**只对按连接发额度的网盘**启用自研分段引擎。

**Q：那 PanBox 有什么用？**
A：① 一个入口管所有网盘，不用装 6 个客户端；② 批量解析、批量下载、统一队列；③ 逐盘标定的连接数 + 断点续传 + 实时速度；④ 对不限速盘（蓝奏云、123 云盘、天翼等）是真满速；⑤ 自动清理转存副本，不污染你的网盘。

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

解析规格来源（以下均为**许可证要求的署名**：PanBox 借鉴的是它们公开的**本地解析算法实现**，
用于 `electron/parsers/` 里的离线计算。PanBox **不调用**、**不推荐**、也不链接这些项目的任何
在线服务或接口，署名不代表对其服务可用性、合规性的背书）：

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
│  │  ├─ segmentDownloader.js 自研分段引擎（绕开 aria2 的 16 连接上限）
│  │  ├─ taskManager.js      任务轮询（800ms）与状态归一化（合并两个引擎）
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
node test\verify-custom-endpoint.js                         # 自定义解析接口：23 项（起本地 http 冒充解析站，不碰第三方）
node test\batch-live.js --only ilanzou --dl                 # 真实链接批量解析
node test\probe-parse-node.js <链接> --dl                   # 单条解析（纯 node）

# 端到端真实下载（需要 Electron）
Remove-Item Env:ELECTRON_RUN_AS_NODE
Start-Process node_modules\electron\dist\electron.exe `
  -ArgumentList 'test\e2e-netdisk.js','<你自己的分享链接> <提取码>' `
  -WorkingDirectory $PWD -NoNewWindow -Wait

# 界面级端到端（真的开窗口、点按钮、截图）
#   ⚠️ 参数一律走环境变量：Start-Process -ArgumentList 传数组时是空格拼接，
#      Chromium 的命令行解析器会把 https://… 这种位置参数吃掉，
#      结果是 Electron 根本不加载脚本（exit -1、stdout/stderr 全空）。
$env:PANBOX_UI_SHARE='<你自己的分享链接>'
$env:PANBOX_UI_OUT="$PWD\dl\ui-e2e"
Start-Process node_modules\electron\dist\electron.exe `
  -ArgumentList 'test\ui-e2e.js' `
  -WorkingDirectory $PWD -NoNewWindow -Wait
```

| 脚本 | 用途 |
|---|---|
| `smoke-parsers.js` | 离线冒烟（模块加载、识别、AES 往返、crc32 向量…） |
| `verify-custom-endpoint.js` | 自定义解析接口：23 项（本地 http 冒充解析站，覆盖字段识别/嵌套/数组/错误码/优先级/退回内置） |
| `verify-segment.js` | 分段引擎单元验证：21 项（16 连接字节+SHA256 精确、多连接观测、强杀断点续传、暂停/继续、移除清场、不支持 Range 时抛 `NO_RANGE` 回退 aria2） |
| `verify-seg-netdisk.js` | **真实网盘**：确认夸克/UC 的任务真的走了分段引擎、连接数 >16、字节精确 |
| `ui-remove-seg.js` | **界面级**：下载中点界面上的「✕ 移除」→ 任务行真的消失、分片被清（回归用户报的"点了没反应"） |
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
- **账号级限速是硬天花板**：内置解析拿到的直链速度取决于你自己账号的档位，且**每个网盘的「发额度方式」不一样**
  —— 夸克/UC 按**每条 TCP 连接**发（96 连接实测 4.4 / 5.3 MB/s，是本软件的实测最好成绩），百度按**账号总量**发
  （1–8 连接都是 0.08–0.10 MB/s，16+ 直接 403，加连接不但无效还会招致惩罚性降速），迅雷 8 连接最好（再多 503）。
  想突破账号档位只能用第三方解析接口（见上文），那是别人的账号在付带宽，请自行判断合规性。
- **123 云盘**的直链受**分享者**的每月提取流量配额限制（免费 10GB/月），配额用完就是"分享方提取流量包不足"，无解。
- **天翼云盘 / 移动云盘**尚未实现。
- 应用未做代码签名，首次运行会触发 SmartScreen。
- 不支持（也不打算支持）任何"破解会员""秒传""变速外挂"类功能——技术上对 2026 年的服务端限速模型已失效，且 `PanDownload` 作者 2020 年因《刑法》第 285 条第 3 款被捕。
