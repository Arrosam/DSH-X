# AGENTS.md

给在这个仓库里干活的 AI 的说明书，人看也欢迎。**动手前先读「硬规矩」与「关键机制」两节。**

## 这是什么

DSH-X：DeepSeek Harness（`dsh`）的第三方启动器。仓库叫 DSH-X，`package.json` 里的名字是更早的 `dsh-versions`。它启动的是 dsh 官方原版 Web 界面，自己不重做 dsh 的页面。

```
Windows/macOS 外壳  launcher/（Rust：tao + wry + tray-icon）
                    DSH.exe / DSH-X.app：控制面板窗口（WebView2 / WKWebView）、托盘 / 菜单栏、
                    单实例、开机自启；首次运行把 Node 下到数据目录，再用它拉起服务
Node 服务          start.js → server.js        管理页后端 + 版本 / 插件 / 整合包 / 同步的全部业务
管理界面           public/index.html           单页手写 HTML + 原生 JS，无框架、无构建步骤
dsh 页面窗口       shell/（按需下载的 Electron） --tab / --window / --show；只做 dsh 页面与标签条，不跑服务
注入钩子           compat/  perf/              被注入 dsh 进程，修补运行时行为（见下）
安装引擎           launcher/installer.rs        DSH-Setup.exe：网页安装界面 + 内嵌 Inno 引擎（只负责装，不跑 dsh）
```

**服务与页面没有第三方运行时依赖**：它们的 import 都是 `node:` 内置或相对路径，没有构建步骤。安装包里既没有 Electron 也没有 Node：Node 由外壳首次运行时下载到每用户数据目录（版本与 sha256 钉在仓库根的 `runtime-versions.json`，外壳编译期嵌入），Electron 只在用户选了「内部标签页 / 独立窗口」时由服务按需下载。`shell/` 只 import 下载来的那份 Electron 自带的 `electron` 模块，它不算 npm 依赖；Windows 的 WebView2 用系统自带的那份，建不出窗口时外壳退回浏览器。
打包期也不需要 `npm install`：外壳用 `cargo build --release --bin DSH` 编（需要 Rust 工具链；macOS 另需 Xcode CLT 出 dmg 并签名，Windows 的 Inno Setup 6 由 `pack.mjs` 按需下载）。`package.json` 里不该再出现 `electron` / `@electron/packager` 这类 devDependencies。

## 怎么跑、怎么验

| 命令 | 干什么 |
|---|---|
| `npm start` | 起管理页（开发入口） |
| `npm run server` | 只起网页服务，不开浏览器 |
| `npm test` | 全部用例（`node --test`） |
| `node --test test/packs.test.mjs` | 单个用例文件 |
| `cd launcher && cargo build --release --bin DSH`，再 `DSH_APP_ROOT=$PWD launcher/target/release/DSH` | 从源码编并起原生外壳：它自己下 Node → 拉服务 → 开控制面板窗口 |
| `npm run dist` | 打安装包（需 Rust；macOS 需 Xcode CLT；Windows 的 Inno Setup 6 自动下载；不需要 `npm install`） |
| `node scripts/make-pack.mjs` | 把 `packs/<名字>/` 打成 `.dspack`（产物在 `release/packs/`） |

- 从源码起外壳会往**真实的**每用户数据目录（`%APPDATA%\DSH` / `~/Library/Application Support/DSH`）下载一份 Node 运行时；`DSH_APP_ROOT` 只换 app 层的位置。
- **跑测试别把输出接管道**（`| head`、`| tail` 会把输出缓冲成 0 字节，等于白跑）；要留证据就重定向到文件。
- 没有 lint / 格式化配置，**也别加**：风格靠已有代码和这份文档。
- 用例里有三只"假服务器"（`test/fake-s3.mjs`、`fake-webdav.mjs`、`fake-proxy.mjs`），网络相关改动靠它们离线验证。

## 硬规矩

- **改完不要自动 commit、不要自动 `npm run dist`、不要发版。** 改动留在工作区，等用户明确指令；用户习惯自己按功能拆提交。
- commit message 用**中文**。
- README 中英成对改（`README.md` + `README.en.md`）；**改 README 默认是"砍"不是"加"**——用户会周期性说"写得太多"。
- Release notes 照 dsh 官方风格：一行一条、分 2–4 块、挂 `@贡献者`；不写根因、验证过程、安装说明。QQ 群公告压到 400 字符内（只写用户看得见的变化，下载只留落地页一条链接），存一份到 `release/群公告-<版本>.txt`。
- 注释写**为什么**（这个仓库的风格：每个不显然的决定都带一段解释，很多是踩坑记录），用中文；不写逐行翻译代码的注释。
- `release/release-key.pem` 是发版签名私钥：不进仓库、别提交、别把内容打印到日志；动相关流程时提醒用户备份。

## 目录地图

| 路径 | 是什么 |
|---|---|
| `start.js` | 入口：端口与日志（原生外壳拉起的就是它；`server.js` 由它 import） |
| `server.js` | 管理页后端 + 全部业务（最大文件）：HTTP 路由、版本管理、插件安装、整合包、启动失败自愈 |
| `settings.js` | 设置读写；`safe*` 一族是校验函数（端口、路径、代理、语言……都从这过） |
| `registry.js` / `version.js` | dsh 版本发现、pnpm 交互（进度解析）、版本号比较；装版本失败时把 npm 的收尾报错换成具体提示（`describeNpmFailure`：ETARGET 发版不齐 / 404 没有这个包） |
| `plugins.js` | 插件开关：直接改 profile 的 `cordis.patch.yml`，不需要 dsh 在跑 |
| `mcp.js` / `skills.js` | MCP server 与技能的读写、探测、开关 |
| `packs.js` | 整合包：`.dspack`（manifest v5 ZIP）的解析 / 检查 / 安装 / 导出 / 回滚 |
| `zip.js` / `zipfile.js` | zip 的写与读（手写，无依赖） |
| `sync.js` | 同步引擎：S3 / WebDAV / 本地目录 / ZIP 四种后端共用一个"远端"抽象 |
| `proxy.js` | `netFetch`：Node 全局 fetch 不看系统代理，所有外网请求走它 |
| `platform.js` | 平台常量 + 运行时推导：`RUNTIME_NODE` 优先取外壳传的 `DSH_RUNTIME_NODE`，`electronRuntime()` 只认数据目录里的 `.ready`；`runtime-versions.json` 也在这读。只有常量与纯函数，没有行为 |
| `runtime-download.js` | 服务端下载 Electron 运行时：官方发行包 → sha256 校验 → ditto（mac）/ bsdtar（Windows）解压 → 写 `.ready`；进度走 SSE，失败清半成品 |
| `filemanager.js` | 按平台挑一套文件管理实现，导出 `fileManager` 与 `APP_DIR`；业务代码只认它 |
| `filemanager-base.js` | 那个接口本身：契约、默认实现、Linux 的 xdg-open 兜底（`PosixFileManager`） |
| `filemanager-windows.js` / `filemanager-mac.js` | 两套实现类，**各自只进对应平台的安装包** |
| `plugin-tool.js` | 命令行开关插件（dsh 起不来时的救命工具），有可执行位 |
| `stdio-unblock.cjs` | stdout/stderr 阻塞模式修补（`--require` 注入用） |
| `public/` | 管理界面与看板娘素材（`index.html` 是主体） |
| `scripts/` | 打包（`pack.mjs` / `pack-mac.mjs` / `pack-common.mjs` / `dsh-setup.iss` / `installer-engine.iss`）、mac 签名（`mac-signing.mjs` / `setup-mac-signing.sh`）、图标（`make-icons.py`）、落地页素材、发版清单与 SBOM |
| `plugins/` `packs/` | 插件源码（发 npm）与随包发的整合包配方（见「关键机制」，**两个目录别合并**） |
| `skills/` | 给 AI 用的技能源码（随仓库分发，不进安装包）：`dsh-x-selfcheck` 只读自检 DSH-X 环境（环境/管理页/数据目录/DSH_HOME/profile/实例/插件/技能/同步/日志），`node skills/dsh-x-selfcheck/scripts/selfcheck.mjs`，零依赖；用例见 `test/selfcheck-skill.test.mjs` |
| `compat/` `perf/` | 注入 dsh 进程的钩子：兼容修补与加速 |
| `launcher/` | 原生外壳 `DSH`（`main.rs` 窗口 / 托盘 / 标记行 / 拉起 Electron，`runtime.rs` 首次运行下载 Node，`tray.rs` 菜单，`health.rs` 渲染进程自愈），外加安装引擎 `DSH-Setup`（`installer.rs` 读网页安装界面的进度、拉起内嵌 Inno 引擎）。旧的 lite 引导器与内部标签页已删 |
| `shell/` | 按需拉起的 Electron 标签窗口宿主（`main.mjs` 窗口，`strip.html` 标签条页，`tabs.mjs` 标签状态机，`host.mjs` 参数 / 第二实例 / 跟随实例，`preload.cjs` 页面桥）；不跑服务、没有托盘和控制面板 |
| `test/` | 用例与假服务器 |
| `docs/` | GitHub Pages 落地页、看板娘设计稿（`mascot-design/`），以及架构与签名说明（`no-electron-runtime.md` / `mac-signing.md`） |
| `assets/` | 图标 master（`icon.png` → `make-icons.py` 出全套） |
| `data/` `release/` `vendor/` | 运行时数据与产物，gitignored，可重建，**不用整理** |

**顶层 .js 平铺是有意的，不是没整理**：安装目录也是平铺的——`scripts/pack-common.mjs` 的 `APP_FILES` 按名字把文件原样拷进 `resources/app`（Windows：`<安装目录>/resources/app/`；macOS：`DSH-X.app/Contents/Resources/app/`），`shell/` 按 `../filemanager.js` / `../platform.js` 引用 app 层，打包时 `package.json` 的 `main` 改指 `shell/main.mjs`。要把它们收进 `src/` 得同时改多处（`APP_FILES` 与拷贝目标、`platform.js`/`server.js` 的根路径推导、`shell/` 的相对引用、`dsh-setup.iss` 与 `pack-mac.mjs` 的布局）并重新打包验证，别只挪文件。

## 关键机制

### 运行时与打开方式

- 运行时不在安装目录，而在每用户数据目录（`%APPDATA%\DSH` / `~/Library/Application Support/DSH`）的 `runtime/` 下：
  - `runtime/node/<node 版本>/`：外壳首次运行下载（先 npmmirror、再 nodejs.org 兜底），版本和 sha256 来自仓库根的 `runtime-versions.json`——外壳**编译期**把这份表嵌进二进制（那时还没有 Node，不能信安装目录里某个还没校验的文件）。解压到 `.staging-<pid>` 再改名；`find_node` 还认旧安装包自带的 `node/node.exe`（0.1.x 升上来的机器，安装包会把它清掉）。
  - `runtime/electron/<electron 版本>/`：服务按需下载（`runtime-download.js`）。解压完写 `.ready` 才算装好；外壳和 `platform.js` 的 `electronRuntime()` 都只认这个标记，解压到一半的目录不会被当成运行时。
- 放数据目录而不是安装目录有两个硬理由：macOS 的 `.app` 签过名，往里写会破坏签名；Windows 的 `Program Files` 也不一定可写。顺带满足「更新不动运行时」。
- 外壳拉起服务时的环境变量就是契约：`DSH_APP_WINDOW=1`（管理页装进外壳窗口，别再开浏览器）、`DSH_RUNTIME_NODE=<下载的 node>`（服务和 dsh 子进程都用它，`platform.js` 的 `RUNTIME_NODE` 认这个）、`DSH_INTERNAL_TABS=1`（外壳支持开标签窗口），PATH 里前置运行时的目录。**能力与「装没装」是两件事**：`DSH_INTERNAL_TABS` 只表示外壳支持，Electron 有没有下载由服务现查 `.ready`，所以用户中途下完不用重启。
- 外壳与服务之间没有别的 IPC，只有 stdout 标记行（`server.js` 的 host 默认实现）：`__DSH_SHOW__` 叫回控制面板窗口，`__DSH_OPEN__ <url>` 拉 Electron 独立窗口，`__DSH_TAB__ <json>` 拉 Electron 标签窗口；Electron 没装或拉不起来时外壳退回系统浏览器。标签窗口是这样拉起的：`<运行时>/electron/<版本>/Electron.app/Contents/MacOS/Electron <app 目录> --tab <url> --title <标题>`（Windows 是 `electron.exe`），管理页地址走环境变量 `DSH_MANAGER_URL`，单实例锁在 Electron 那边（第二次拉起只把参数交给已有实例）。
- 控制面板窗口是 wry 的 WebView（Windows WebView2 / macOS WKWebView），指向 `http://127.0.0.1:<端口>/?window=1|mac`，窗口按钮与拖动仍走 `window.ipc`。关窗口只是藏起来，托盘还在、dsh 照常跑；退出是托盘菜单 → `/api/quit` → node 收尾 → 外壳跟着退。

### 打开方式

| openMode | 谁打开 | 需要 Electron 运行时 |
|---|---|---|
| `tab`（默认） | 系统默认浏览器 | 否 |
| `app` | 机器上装的 Chrome / Edge 应用窗口 | 否 |
| `window` | Electron 独立窗口（`__DSH_OPEN__`） | 是 |
| `internal` | Electron 标签窗口（`__DSH_TAB__`） | 是 |

- `openRoute()`（`server.js`）要「外壳能托管 + 运行时已下载」两条同时成立才走 Electron；否则降级系统浏览器，日志和设置页都会说明原因（`app` 不经过外壳，找不到 Chrome/Edge 也降级浏览器）。用户选了内嵌方式但运行时没装时，设置页显示下载按钮和进度：进度走 SSE 的 `runtime` 事件，`GET /api/runtime` 是重载后的快照，`POST /api/runtime/download|cancel` 控制。装好立即生效，不需要重启。

### 版本、实例与数据

- 每个 dsh 版本装在数据目录（默认 `%APPDATA%\DSH\data`，设置里可改）的 `versions/<版本>/`。
- **一个「版本 × profile」一个实例**，可以同时跑，各占各的端口：默认给会起 web 的 profile 传 `--port 0`，由系统现挑，启动器再从 dsh 打印的地址里读回真实端口。
- 端口也能手工钉死（控制页那个「端口」输入框 → `settings.json` 的 `instancePorts`，键 `版本@profile`）：钉了就传 `--port <它>`，链接每次启动都一样（书签、手机上的地址才留得住）。钉住的组合起不来时（`EADDRINUSE`）报错要点名端口和占用者。**这是 dsh 实例的端口，跟管理页端口（`port`）是两回事，两者不能撞。**
- dsh 本体数据在 `DSH_HOME`（默认 `~/.dsh`，可配），跨版本共享，所以换版本不用重装插件。
- 启动器自己的设置、日志与下载的运行时都在 `%APPDATA%\DSH`（macOS 为 `~/Library/Application Support/DSH`）。

### profile

dsh 的环境隔离单位。模板名（web / headless / acp / sdk / …）会自动初始化，自定义名必须先有 `package.json`，否则 dsh 拒绝启动。插件按 profile 分，会话与记忆共享。启动器提供切换与开关；插件开关就是往 `cordis.patch.yml` 写 `- id: <行> / disabled: true`，删掉该块即恢复。

恢复档（`recovery.js`，官方 desktop `sanitizeProfile` 的同款语义）：`POST /api/recover` 把补丁层**改名**成 `cordis.patch.yml.bak-<时间戳>`（备份即改名、不解析补丁内容），再按侧车记录摘掉清单里非 `@deepseek-ai/*` 的 bundle；`POST /api/recover/restore` 把备份改回来、现役补丁先挪到新备份、并按侧车放回被摘的 bundle。改补丁层/清单前都过 `withProfileLock`（profile 目录里一个存 PID 的 `lock` 文件，`wx` 独占创建、属主僵死才清理）——与官方锁同名同语义。这是逐行自动禁用都失效时的最后手段；清单 JSON 坏掉时只告警、补丁层照样移走（救援优先，官方是整单失败）。

### 插件与整合包（两个目录，别合并）

- `plugins/<包名>/` 是**插件实现的源码与发布源**（npm 包：`dsh-x-memory`、`dsh-x-sync`、`dsh-x-aquarium`），**不随安装包发**：插件都发到 npm，用户从插件页 / 整合包装，装完能看远程版本、能更新。改了这里的代码要 `npm publish`（版本号记得加）。
- `packs/dsh-x-recommended/` 是**整合包配方**（`manifest.json` + `dspack.json` + README），**不含代码**，随安装包发；依赖一律写 npm 版本号。
- 没有「内置插件」这条路：预置到当前 profile 的开关、随包发插件的复制逻辑、整合包里的 `"…": "bundled"` 依赖解析都已撤（`planInstall` 见到 `bundled` 会直接报错）。
- 为什么不能合并：`.dspack` 只认 `overrides/`、`home/`、`profiles/` 与几个根文件，插件源码放进去会被当"不属于整合包"跳过（`packs.js` 的解析）；反过来 `plugins/` 下每个子目录都被当成一个 npm 包。

### 文件管理：一个接口，两套实现

每用户目录与安装布局、路径大小写、目录链接类型、系统文件对话框、在资源管理器 / 访达里打开或定位、交给系统默认程序打开地址、登录自启——这些**全部**走 `filemanager.js` 导出的 `fileManager`，业务代码里不再写 `process.platform === 'win32' ? … : …`。

- 契约在 `filemanager-base.js` 的 `FileManager` 上，每个方法的注释就是规范（失败怎么抛、取消返回什么、哪些错误可以当成成功）。
- `filemanager.js` 用**动态 import** 挑实现：另一套实现根本不在安装目录里，静态 import 会直接报模块找不到。它有顶层 await，所以实现类静态 import 的是 `filemanager-base.js` 而不是它——反过来 import 会死锁（Node 报 unsettled top-level await），这也是基类单独一个文件的唯一理由。
- 实现类的外部依赖（`execFile`、`statSync`、`existsSync`、`env`、`home`、`root`）都从构造函数注进去，所以 `test/filemanager.test.mjs` 能在一台机器上把两套实现跑在同一组断言上，不按平台 skip。
- `platform.js` 只剩常量与运行时的推导：打包脚本要在任何一台机器上 import 它，不能被平台判断牵连；`fileManager.launchArgs()` 在源码运行时用 `RUNTIME_NODE` 拼自启命令，打包后指向外壳可执行文件。
- **加 Linux**：照着两个实现类写一个 `filemanager-linux.js`，在 `filemanager.js` 的 `pickFileManager()` 里挂上，加进 `pack-common.mjs` 的 `FILE_MANAGERS`，再把它加进 `test/filemanager.test.mjs` 的 `IMPLEMENTATIONS`（那条「必须自己实现」的用例会替你盯着哪些方法不能漏）。在那之前 Linux 落到 `PosixFileManager`：xdg-open 能用，对话框和自启如实报不支持。
- 还留在 `server.js` 里的平台判断是**另一摊事**，故意没收进来：pnpm 子进程怎么起、`killTree`、GB18030 解码、Chromium 的安装位置、自更新包的名字。它们不是文件管理，而且本来就按参数传平台、能直接测。

### 注入进 dsh 的钩子（compat / perf）

- `compat/register.mjs`、`perf/register.mjs` 由启动器注入；worker 线程注入的是 `compat/worker-events.cjs`（worker 的 execArgv 是空的，只能靠 NODE_OPTIONS）。
- NODE_OPTIONS 里的路径走 `nodeOptionsPath()`（`server.js`）：反斜杠换正斜杠、含空白才包引号——**引号会吃反斜杠**，所以不能只加引号。**别退回「NODE_PATH 传目录 + 裸文件名」**：旧 Electron 外壳（服务与外壳同进程）不消费 NODE_PATH，会把应用顶死；现在服务虽由普通 node 跑，这段写法也别改回去。
- dsh 自己的 Node 开关（系统证书库、请求头上限、两个 ESM 补丁钩子）走**命令行参数**，不塞 NODE_OPTIONS：后者会被 dsh 的所有子进程继承，agent 在 shell 里跑的 node 可能是老版本。
- 改会话事件词汇表（`SESSION_TYPES`）要**两处同步**：主线程的 `compat/session-events.mjs` 与 worker 的 `compat/worker-events.cjs` 各有一份副本。

### 应用层增量更新（app-update.js / apply-update.mjs）

- 发布侧：`scripts/app-manifest.mjs build` 给打包后的 app 目录生成文件清单（路径/大小/sha256、启动器版本、平台；mac 的可执行包装脚本还带 `mode`，zip 不存权限）与整包 zip；有 `release/release-key.pem`（或 `DSH_RELEASE_KEY`）时用 Ed25519 签名。`pack.mjs` 只出 `app-<版本>-win.*`，CI 的 mac job 出 `app-<版本>-mac.*`。清单里**没有** Electron 版本，也**没有** runtime 资产——运行时不跟 app 更新一起变。
- 客户端：`/api/self` 带 `app` 检查结果（清单必须用内置公钥 `APP_PUBLIC_KEY` 验签通过），页面按「约 N MB」展示增量大小；`/api/self/app-download` 下载整包并逐文件核对哈希后解到暂存目录，`/api/self/app-apply` 负责切换。
- Windows：替换助手（`apply-update.mjs`）等**服务与原生外壳都退出**（`--pid` / `--shell-pid`，旧外壳的单实例逻辑会把过早拉起的实例挡回去）→ 备份旧 `resources/app` → 换目录 → 按 `shellExecutable(ROOT)` 拉起外壳 → 45 秒内等不到启动标记 `<APP_DIR>/update-ok` 就回滚并重启旧版。
- macOS：`MAC_APP_SWAP_SCRIPT` 换 `.app/Contents/Resources/app` → `codesign --force --deep --sign <身份>` 重签整个包 → `open` 重启 → 45 秒启动标记，失败回滚并重签旧包。只对 ad-hoc / 未签名的包开放（`macSignatureAllowsIncremental`）；固定证书签名的包重签会破坏公证，直接回退完整 dmg。
- 边界：只有「已打包的安装版 + 签名清单」才走增量；未签名清单、固定证书签名的 mac 包、源码运行自动回退完整安装包。旧 lite 引导器（`current.json` + junction）与它的自更新（`boot-update.exe`）已随 Electron 一起退役，清单不再有 `boot` 字段。
- 版本更新后启动器会刷新桌面/开始菜单快捷方式图标（`refreshShortcuts`）：图标文件名带版本号（`assets/dsh-<版本>.ico`），每个版本只改一次并记戳。
- 所有下载都走 `updateUrlCandidates`：默认「国内加速」是镜像优先（gh-proxy → ghfast → 直连兜底）。
- 本地调试更新：`DSH_UPDATE_BASE` 指到本地资产目录、`DSH_UPDATE_VERSION` 当最新版本（见 `server.js` 的 `TEST_UPDATE_BASE`）。

### 打包与安装布局

- 文件管理的实现类不在 `APP_FILES` 里，由 `copyAppFiles(out, platform)` 按平台挑一个（`FILE_MANAGERS`）：Windows 的包里没有 `filemanager-mac.js`，反之亦然。平台没有对应实现时打包直接报错，不会装出一个起不来的包。
- `APP_FILES`（`scripts/pack-common.mjs`）= 启动器源码清单；`copyAppFiles` 把它们平铺拷进 app 目录（macOS: `DSH-X.app/Contents/Resources/app/`；Windows: `<安装目录>/resources/app/`），**不打 asar**：dsh 子进程要按真实路径读 `compat/`、`perf/`，Electron 标签窗口按 `package.json` 的 `main`（打包时改指 `shell/main.mjs`）找入口，原生外壳则直接跑 `start.js`。
- app 目录里还有 `node/`（只有 npm / pnpm 的 JS 包和 `npm`、`npx`、`pnpm`、`pnpx` 包装脚本，**没有 node 可执行文件**；包装脚本调用 PATH 上的 node，也就是外壳下载的运行时）、`public/`、`assets/`、`compat/`、`perf/`、`packs/`、`shell/`。npm 必须随 app 走（`registry.js` 找不到 npm 会往自己目录里下载），pnpm 也是（`dsh plugin` 靠它）；node 本体不能进包——macOS 签名后不能写、Windows 安装目录也不一定可写。
- **Windows**：`pack.mjs` 先 `cargo build --release --bin DSH`（`launcher/` 的 Rust 还编安装引擎 `DSH-Setup`：`cargo build --release --features installer --bin DSH-Setup`），把 `DSH.exe` 放安装根、`APP_FILES` 拷进 `resources/app`，再用 Inno（`scripts/dsh-setup.iss`，安装界面进度走 `installer-engine.iss`）打 `DSH-Setup.exe`。Inno Setup 6 没装时 `pack.mjs` 下载到 `vendor/`；升级安装包会主动清掉旧 Electron / `node/` / lite 引导器的残留（`[InstallDelete]`）。
- **macOS**：`pack-mac.mjs` 自己写 `Info.plist`（`LSMinimumSystemVersion=11.0`，比 Electron 时代的 13 低）、生成 `AppIcon.icns`、签名整个 `.app`（见 `docs/mac-signing.md`）、再压 dmg；两个架构各自在对应架构的机器上原生编译 Rust。
- **Electron 版本钉在 `runtime-versions.json`，别随手升**：dsh 的 `node-addon-require-builtin` 只给几个 Electron 版本留了预编译（43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6），版本对不上时 dsh 一启动就报 `unsupported Electron runtime fingerprint`（见 `dsh: host preparation failed`）。升级前先看 dsh 那边的支持列表，改完在下载好的运行时里真启动一个实例验证。
- dsh / npm / pnpm 子进程一律用 `platform.js` 的 `RUNTIME_NODE`，**别用 `process.execPath` 自己拼**：原生外壳拉起服务时它就是数据目录里下载的 node；只有过渡期的旧 Electron 外壳里 `RUNTIME_NODE` 才是 Electron 本体，那时必须同时展开 `RUNTIME_NODE_ENV`（`ELECTRON_RUN_AS_NODE=1`），否则会当 GUI 打开。`withBundledRuntime` / `orderRuntimePaths` 负责把 app 层 `node/` 的包装放进 PATH。
- 网页安装界面的进度桥：引擎往 `/STATUSFILE` 写 `阶段:百分比`（`preparing`/`files`/`finishing`/`cleaning`，见 `scripts/installer-engine.iss` 与 `dsh-setup.iss` 的 `CurStepChanged`），`launcher/installer.rs` 每 120ms 读一次、以 `{type:'progress',stage,percent}` 交给 `installer/index.html` 取本地化文案。两侧互相容忍：新引擎配旧外壳，旧外壳解析不动就停在上一个数；旧引擎只写纯数字，新外壳回落 `files`。`DSH-Setup.exe --preview` 单跑界面（demo 会走完四个阶段）。
- 自更新（Windows）：下载 `DSH-Setup.exe` → 静默安装 → 由安装程序拉起新版。macOS 是挂 dmg、把新 .app 拷到旧包旁边，退出后由 `MAC_SWAP_SCRIPT` 换包。改这条链路时，父进程必须**等安装程序真的起来再退**，否则复刻流程会误判成"更新坏了"。
- 发版产物要一起传：Windows 的 `DSH-Setup.exe` 与 `app-*-win.*`，mac 的 dmg（**不传 dmg，mac 的自更新就取不到包**）与 `app-*-mac.*`；不再有 `runtime-<版本>` 和 `DSH-Setup-lite.exe`。清单、签名、SBOM 见 README 的「打包」一节。

### 网络与子进程环境

- 外网请求一律走 `netFetch`（`proxy.js`）：先代理后直连、回环地址不代理。Node 22.19 的全局 fetch 不认代理。
- 给 dsh 子进程的 PATH 末尾追加当前版本的 `.bin`，并补上 app 层 `node/` 的包装（`withVersionBin` / `withBundledRuntime`），但**用户自己的 pnpm 优先**（见 `orderRuntimePaths`）。store 主版本跟着 pnpm 主版本走（8→v3 / 10→v10 / 11、12→v11），拿错版本去动 profile 会 `ERR_PNPM_UNEXPECTED_STORE`，所以**插件命令**会先按 profile 的 `node_modules/.modules.yaml` 记的 store 挑一次 pnpm（`preferredPnpmDir`/`pickPnpmDir`，挑不出来才回退「系统优先」，并把两边的 store 版本写进日志）。便携兜底那份是 pnpm 11.27.1，版本钉在 `pack-common.mjs` 的 `PNPM_VERSION`，打包时按版本号校验缓存（`vendor/pnpm`）。
- dsh CLI 在参数解析阶段就拒掉保留 profile 名（`desktop`，官方留给自家 Electron 端），两个入口各有一套绕法（`CLI_BLOCKED_PROFILES`）：
  - **启动**：入口换成 `reserved-profile-boot.mjs`（直接调 boot 层，argv 形状与 CLI 一致）。
  - **插件命令**：CLI 只按名字找 profile，所以给原件在同目录建一个目录链接别名（`.dsh-alias-desktop` → `desktop`，`ensureProfileAlias`，Windows 用 junction），命令改指别名 —— 一份目录两个名字，不复制也不漂移。别名以点开头，`listProfiles` 会跳过，界面里只看得到 `desktop`。
  - 两者的理由与边界：真名 `desktop` 永远留给官方桌面端（别去改它的目录内容），启动器只是换入口/换名字去用同一份数据。
- 可选下载源（镜像 / 官方），要传给 dsh 子进程，让它装插件时用同一个源；Electron 运行时下载也按它选镜像。

## 改代码时容易踩的

- **`runtime-versions.json` 是版本与 sha256 的单一来源**：外壳**编译期**把它嵌进二进制，服务与打包脚本读运行时那份。改版本 / 哈希要重编外壳，否则「外壳下的版本」和「服务以为的版本」会对不上。
- **安装包里没有 Node**：首次启动必须联网下载，Electron 只在用户选内嵌窗口时下载。调运行时逻辑时别把半成品当成已安装（外壳与 `platform.js` 只认 `.ready` / 解压后整体改名）。
- **Node 22.19：注册过 ESM 钩子后 `error.stack` 变成只读**（`writable: false`）。dsh 的 app-boot 会写 `error.stack = ...`，一写就抛 `TypeError`，把原始错误码顶掉。`compat/session-events.mjs` 已把它包进 try/catch，**别去掉**。
- **插件 import 失败会让 dsh 秒退**（插件树的单点故障）。涉及 profile 依赖、补丁层的改动要格外保守，改完用 `plugin-tool.js list` 或真启动一次验证。
- **Windows 的 junction**：pnpm 用 junction 指向 `.pnpm`，目标被删就悬空，读目录会报 `UNKNOWN ... -4094`；还有一类机器根本读不了 junction。两条退路都在 `server.js`（清理悬空链接、让 pnpm 不用链接），清理时要扫进 `@scope` 一层。
- 管理页端口每次启动可能变（被占用会顺延）：旧链接 401、旧标签页里"插件包加载失败"都是正常现象，不用"修"。
- cookie 堆到 16 KB 会让全站 `HTTP 431`：给 cookie 加内容前先算总量。
- 测试输出别接管道（会说第二遍，因为真有人踩）。
- `data/`、`release/`、`vendor/` 里的东西可以随便清（都是产物），但 `release/release-key.pem` 除外。
