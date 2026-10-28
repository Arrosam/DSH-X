# AGENTS.md

给在这个仓库里干活的 AI 的说明书，人看也欢迎。**动手前先读「硬规矩」与「关键机制」两节。**

## 这是什么

DSH-X：DeepSeek Harness（`dsh`）的第三方启动器。`package.json` 的 `name` 是 `dsh-x`——deb 的包名取的就是它，别改回早先那个 `dsh-versions`。它启动的是 dsh 官方原版 Web 界面，自己不重做 dsh 的页面。

```
Windows/macOS 外壳  shell/（Electron）  DSH.exe / DSH-X.app：Chromium 窗口与内部标签页、托盘、菜单栏、单实例；服务跑在同一进程里
Node 服务  start.js → server.js        管理页后端 + 版本 / 插件 / 整合包 / 同步的全部业务
管理界面   public/index.html           单页手写 HTML + 原生 JS，无框架、无构建步骤
注入钩子   compat/  perf/              被注入 dsh 进程，修补运行时行为（见下）
```

**零第三方运行时依赖**：服务与页面的 import 都是 `node:` 内置或相对路径，没有构建步骤。安装包不依赖用户机器环境：dsh 子进程用 Electron 自带的 Node（打包时只把 npm / pnpm 抄进 `node/`），旧安装包里的 `node/node.exe` 继续兼容。
唯一的例外在**打包期**：三个平台的外壳都要 `electron` 与 `electron-builder`（`devDependencies`，打安装包前先 `npm install`）。`shell/` 之外的代码别 import 它们；`npm start` / `npm test` 不需要装。

## 怎么跑、怎么验

| 命令 | 干什么 |
|---|---|
| `npm start` | 起管理页（开发入口） |
| `npm run server` | 只起网页服务，不开浏览器 |
| `npm test` | 全部用例（`node --test`，300+ 用例，约 16 秒） |
| `node --test test/packs.test.mjs` | 单个用例文件 |
| `npm run electron` | 用 Electron 外壳从源码起（Windows / macOS / Linux，先 `npm install`） |
| `npm run dist` | 打安装包（都先 `npm install`；macOS 还要 Xcode CLT） |
| `node scripts/make-pack.mjs` | 把 `packs/<名字>/` 打成 `.dspack`（产物在 `release/packs/`） |

- **跑测试别把输出接管道**（`| head`、`| tail` 会把输出缓冲成 0 字节，等于白跑）；要留证据就重定向到文件。
- 没有 lint / 格式化配置，**也别加**：风格靠已有代码和这份文档。
- 用例里有三只"假服务器"（`test/fake-s3.mjs`、`fake-webdav.mjs`、`fake-proxy.mjs`），网络相关改动靠它们离线验证。

## 硬规矩

- **改完不要自动 commit、不要自动 `npm run dist`、不要发版。** 改动留在工作区，等用户明确指令；用户习惯自己按功能拆提交。
- commit message 用**中文**，格式 `类型: 说明`。类型只有四个，和发版说明的四块一一对应：`feat`（新增功能）/ `perf`（体验优化）/ `fix`（问题修复）/ `chore`（其他变更）。`node scripts/release-notes.mjs` 按前缀拆块生成草稿。
- README 中英成对改（`README.md` + `README.en.md`）；**改 README 默认是"砍"不是"加"**——用户会周期性说"写得太多"。
- Release notes 按 `docs/releases/TEMPLATE.md` 写进 `docs/releases/v<版本>.md`（**入库**，中英同篇、四块固定、一行一条、挂 `@贡献者`）；不写根因、验证过程、安装说明。预发布（rc / alpha）在 GitHub 上勾 Pre-release。QQ 群公告压到 400 字符内（只写用户看得见的变化，下载只留落地页一条链接），存一份到 `release/群公告-<版本>.txt`。
- 注释写**为什么**（这个仓库的风格：每个不显然的决定都带一段解释，很多是踩坑记录），用中文；不写逐行翻译代码的注释。
- `release/release-key.pem` 是发版签名私钥：不进仓库、别提交、别把内容打印到日志；动相关流程时提醒用户备份。

## 目录地图

| 路径 | 是什么 |
|---|---|
| `start.js` | 入口：端口与日志（`server.js` 在 Electron 外壳里被直接 import，不再经过它） |
| `server.js` | 管理页后端 + 全部业务（最大文件）：HTTP 路由、版本管理、插件安装、整合包、启动失败自愈 |
| `settings.js` | 设置读写；`safe*` 一族是校验函数（端口、路径、代理、语言……都从这过） |
| `registry.js` / `version.js` | dsh 版本发现、pnpm 交互（进度解析）、版本号比较；装版本失败时把 npm 的收尾报错换成具体提示（`describeNpmFailure`：ETARGET 发版不齐 / 404 没有这个包） |
| `plugins.js` | 插件开关：直接改 profile 的 `cordis.patch.yml`，不需要 dsh 在跑 |
| `mcp.js` / `skills.js` | MCP server 与技能的读写、探测、开关 |
| `packs.js` | 整合包：`.dspack`（manifest v5 ZIP）的解析 / 检查 / 安装 / 导出 / 回滚 |
| `zip.js` / `zipfile.js` | zip 的写与读（手写，无依赖） |
| `sync.js` | 同步引擎：S3 / WebDAV / 本地目录 / ZIP 四种后端共用一个"远端"抽象 |
| `proxy.js` | `netFetch`：Node 全局 fetch 不看系统代理，所有外网请求走它 |
| `platform.js` | 平台常量与「Electron 本体当 node 用」的推导（`RUNTIME_NODE` / `RUNTIME_NODE_ENV`）；只有常量，没有行为 |
| `filemanager.js` | 按平台挑一套文件管理实现，导出 `fileManager` 与 `APP_DIR`；业务代码只认它 |
| `filemanager-base.js` | 那个接口本身：契约、默认实现、其他 POSIX 平台的 xdg-open 兜底（`PosixFileManager`） |
| `filemanager-windows.js` / `filemanager-mac.js` / `filemanager-linux.js` | 三套实现类，都随跨平台核心包发，运行时按平台动态 import |
| `plugin-tool.js` | 命令行开关插件（dsh 起不来时的救命工具），有可执行位 |
| `stdio-unblock.cjs` | stdout/stderr 阻塞模式修补（`--require` 注入用） |
| `public/` | 管理界面与看板娘素材（`index.html` 是主体） |
| `scripts/` | 打包（`pack.mjs` / `pack-mac.mjs` / `pack-common.mjs` / `electron-prune.mjs`）、图标（`make-icons.py`）、落地页素材、发版说明草稿（`release-notes.mjs`，按 commit 前缀拆块）、发版清单与 SBOM |
| `plugins/` `packs/` | 插件源码（发 npm）与随包发的整合包配方（见「关键机制」，**两个目录别合并**） |
| `skills/` | 给 AI 用的技能源码（随仓库分发，不进安装包）：`dsh-x-selfcheck` 只读自检 DSH-X 环境（环境/管理页/数据目录/DSH_HOME/profile/实例/插件/技能/同步/日志），`node skills/dsh-x-selfcheck/scripts/selfcheck.mjs`，零依赖；用例见 `test/selfcheck-skill.test.mjs` |
| `compat/` `perf/` | 注入 dsh 进程的钩子：兼容修补与加速 |
| `shell/` | Windows / macOS / Linux 的 Electron 外壳（`main.mjs` 窗口 / 托盘 / 菜单，`tabs.mjs` 内部标签页，`preload.cjs` 页面桥，`updater.mjs` electron-updater）；`package.json` 是外壳版本，核心版本在根 `package.json` |
| `test/` | 用例与假服务器 |
| `docs/` | GitHub Pages 落地页 + 看板娘设计稿（`mascot-design/`）+ `releases/`（入库的发版说明，格式见 `TEMPLATE.md`） |
| `assets/` | 图标 master（`icon.png` → `make-icons.py` 出全套） |
| `data/` `release/` `vendor/` | 运行时数据与产物，gitignored，可重建，**不用整理** |

**顶层 .js 平铺是有意的，不是没整理**：核心文件按 `scripts/pack-common.mjs` 的 `APP_FILES` 原样拷进 `resources/core`（Windows：`<安装目录>/resources/core/`；macOS：`DSH-X.app/Contents/Resources/core/`），外壳在 `resources/app`，启动时动态 import 核心的 `server.js`。要把它们收进 `src/` 得同时改 `APP_FILES` 与拷贝目标、`platform.js`/`server.js` 的根路径推导、核心更新路径和 `scripts/pack.mjs`，并重新打包验证，别只挪文件。

## 关键机制

### 版本、实例与数据

- 每个 dsh 版本装在数据目录（默认 `%APPDATA%\DSH\data`，设置里可改）的 `versions/<版本>/`。
- **一个「版本 × profile」一个实例**，可以同时跑，各占各的端口：默认给会起 web 的 profile 传 `--port 0`，由系统现挑，启动器再从 dsh 打印的地址里读回真实端口。
- 端口也能手工钉死（控制页那个「端口」输入框 → `settings.json` 的 `instancePorts`，键 `版本@profile`）：钉了就传 `--port <它>`，链接每次启动都一样（书签、手机上的地址才留得住）。钉住的组合起不来时（`EADDRINUSE`）报错要点名端口和占用者。**这是 dsh 实例的端口，跟管理页端口（`port`）是两回事，两者不能撞。**
- dsh 本体数据在 `DSH_HOME`（默认 `~/.dsh`，可配），跨版本共享，所以换版本不用重装插件。
- 启动器自己的设置与日志在 `%APPDATA%\DSH`（macOS 为 `~/Library/Application Support/DSH`）。

### profile

dsh 的环境隔离单位。模板名（web / headless / acp / sdk / …）会自动初始化，自定义名必须先有 `package.json`，否则 dsh 拒绝启动。插件按 profile 分，会话与记忆共享。启动器提供切换与开关；插件开关就是往 `cordis.patch.yml` 写 `- id: <行> / disabled: true`，删掉该块即恢复。

恢复档（`recovery.js`，官方 desktop `sanitizeProfile` 的同款语义）：`POST /api/recover` 把补丁层**改名**成 `cordis.patch.yml.bak-<时间戳>`（备份即改名、不解析补丁内容），再按侧车记录摘掉清单里非 `@deepseek-ai/*` 的 bundle；`POST /api/recover/restore` 把备份改回来、现役补丁先挪到新备份、并按侧车放回被摘的 bundle。改补丁层/清单前都过 `withProfileLock`（profile 目录里一个存 PID 的 `lock` 文件，`wx` 独占创建、属主僵死才清理）——与官方锁同名同语义。这是逐行自动禁用都失效时的最后手段；清单 JSON 坏掉时只告警、补丁层照样移走（救援优先，官方是整单失败）。

### 插件与整合包（两个目录，别合并）

- `plugins/<包名>/` 是**插件实现的源码与发布源**（npm 包：`dsh-x-memory`、`dsh-x-sync`、`dsh-x-aquarium`），**不随安装包发**：插件都发到 npm，用户从插件页 / 整合包装，装完能看远程版本、能更新。改了这里的代码要 `npm publish`（版本号记得加）。
- `packs/dsh-x-recommended/` 是**整合包配方**（`manifest.json` + `dspack.json` + README），**不含代码**，随安装包发；依赖一律写 npm 版本号。
- 没有「内置插件」这条路：预置到当前 profile 的开关、随包发插件的复制逻辑、整合包里的 `"…": "bundled"` 依赖解析都已撤（`planInstall` 见到 `bundled` 会直接报错）。
- 为什么不能合并：`.dspack` 只认 `overrides/`、`home/`、`profiles/` 与几个根文件，插件源码放进去会被当"不属于整合包"跳过（`packs.js` 的解析）；反过来 `plugins/` 下每个子目录都被当成一个 npm 包。

### 文件管理：一个接口，三套实现

每用户目录与安装布局、路径大小写、目录链接类型、系统文件对话框、在资源管理器 / 访达 / 文件管理器里打开或定位、交给系统默认程序打开地址、登录自启——这些**全部**走 `filemanager.js` 导出的 `fileManager`，业务代码里不再写 `process.platform === 'win32' ? … : …`。

- 契约在 `filemanager-base.js` 的 `FileManager` 上，每个方法的注释就是规范（失败怎么抛、取消返回什么、哪些错误可以当成成功）。
- `filemanager.js` 用**动态 import** 只加载当前平台那一套：三套实现都随跨平台核心包发，静态 import 会把另外两套也拉进来。它有顶层 await，所以实现类静态 import 的是 `filemanager-base.js` 而不是它——反过来 import 会死锁（Node 报 unsettled top-level await），这也是基类单独一个文件的唯一理由。
- 实现类的外部依赖（`execFile`、`statSync`、`existsSync`、`env`、`home`、`root`）都从构造函数注进去，所以 `test/filemanager.test.mjs` 能在一台机器上把三套实现跑在同一组断言上，不按平台 skip。
- `platform.js` 只剩常量与 `RUNTIME_NODE` 那套推导：打包脚本要在任何一台机器上 import 它，不能被平台判断牵连；`launchArgs()` 也用 `RUNTIME_NODE`，Electron 里它就是 Electron 本体。
- **Linux**：`filemanager-linux.js` 用 `$XDG_CONFIG_HOME/DSH`（默认 `~/.config/DSH`）、`xdg-open`、zenity/kdialog 对话框和 XDG autostart（`~/.config/autostart/dsh-x.desktop`）；AppImage 的启动项用 `APPIMAGE` 本身，避免挂载目录每次变化。
- 还留在 `server.js` 里的平台判断是**另一摊事**，故意没收进来：pnpm 子进程怎么起、`killTree`、GB18030 解码、Chromium 的安装位置、自更新包的名字。它们不是文件管理，而且本来就按参数传平台、能直接测。

### 注入进 dsh 的钩子（compat / perf）

- `compat/register.mjs`、`perf/register.mjs` 由启动器注入；worker 线程注入的是 `compat/worker-events.cjs`（worker 的 execArgv 是空的，只能靠 NODE_OPTIONS）。
- NODE_OPTIONS 里的路径走 `nodeOptionsPath()`（`server.js`）：反斜杠换正斜杠、含空白才包引号——**引号会吃反斜杠**，所以不能只加引号。**别退回「NODE_PATH 传目录 + 裸文件名」**：Electron 主进程不消费 NODE_PATH，会把应用顶死。
- dsh 自己的 Node 开关（系统证书库、请求头上限、两个 ESM 补丁钩子）走**命令行参数**，不塞 NODE_OPTIONS：后者会被 dsh 的所有子进程继承，agent 在 shell 里跑的 node 可能是老版本。
- 改会话事件词汇表（`SESSION_TYPES`）要**两处同步**：主线程的 `compat/session-events.mjs` 与 worker 的 `compat/worker-events.cjs` 各有一份副本。

### 核心更新（core-npm.js / apply-update.mjs）

- 发布侧：核心作为一个跨平台 npm 包发版：`dsh-x-core`（Windows / mac / Linux 共用；三套 filemanager 和 node 包装都在包里，运行时按平台选）。`scripts/pack-core.mjs` 把 `release/core-stage` 打成 tarball，包里的 `package.json` 的 `main` 是 `server.js`，并带 `dshX.electron`（构建所用的 Electron 版本）；CI 在 mac arm64 job 上用 `NPM_TOKEN` 按版本通道发到 `latest` / `rc` / `alpha`。Windows / mac / Linux job 只出各自的安装包。
- **版本分两套**：根 `package.json` 是核心版本（npm 核心包、安装包里的基线核心），`shell/package.json` 是外壳版本（electron-builder 的安装包、`latest.yml`、npm CLI 包）。UI/服务端改动只 bump 核心版本，外壳版本不动，所以不会触发 100MB+ 的安装包更新；只有 Electron/主进程/托盘/更新器变化才 bump 外壳版本。
- **bump 规则**：只改核心 → 只 bump 根 `package.json`；只改外壳/Electron → 只 bump `shell/package.json`；Electron 升级时两个都 bump（核心包要按新 Electron 重发，npm 不允许覆盖同版本）。只改核心时 npm CLI 包版本不变，CI 的 `npm view` 检查会跳过重复发布。
- **迁移**：旧 0.1.20 外壳只认 `dsh-x-core-win` / `dsh-x-core-mac`，不会看到新的 `dsh-x-core`，所以先发新核心包也不会被旧外壳的 `app-apply` 拿去换 `resources/app`。旧安装要先 bump `shell/package.json` 发一次新外壳（electron-updater 会拉），之后新外壳/CLI 才走 `dsh-x-core`；旧的平台包保持原样，不再发新版本。
- 客户端：`/api/self` 的 `app` 来自 npm registry 的 dist-tags（按核心版本所在通道选），`/api/self/app-download` 下载 tarball、校验 npm 的 `dist.integrity`（sha512）、解到暂存目录，`/api/self/app-apply` 负责切换。registry 默认官方/镜像跟着设置里的下载源走，`DSH_CORE_REGISTRY` 可以覆盖（本地演示用）。
- **安装布局**：`resources/app` 只有外壳（Electron main/tray/updater/preload/tabs + `electron-updater` 依赖），`resources/core` 是基线核心。mac 是 `Contents/Resources/app` + `Contents/Resources/core`；Linux AppImage 是 `AppDir/resources/app` + `AppDir/resources/core`。外壳启动时按 `DSH_CORE_DIR` → `%APPDATA%\DSH\core\current`（mac `~/Library/Application Support/DSH/core/current`，Linux `$XDG_CONFIG_HOME/DSH/core/current`，默认 `~/.config/DSH/core/current`）→ `resources/core` 选核心，动态 import 它的 `server.js`；核心声明 `dshX.electron` 和当前外壳不一致时退回基线。
- 核心切换：
  - 内置基线 → 复制暂存目录到 `core/current`，写 `pending`，用外壳的 `host.relaunch`（`app.relaunch()`，等本进程退出后才拉起新外壳）重启；新核心起不来时外壳的 `recoverBaseline` 删掉 current 并回退基线。
  - 已经在 `core/current` → 替换助手 `apply-update.mjs`（等父进程退出 → 备份 → 换目录 → 重启 → 45 秒内等不到启动标记 `<APP_DIR>/update-ok` 就回滚）。
  - 核心在用户目录里，不在签名的 .app 内，mac 不需要重签；旧版换 `Resources/app` + `MAC_APP_SWAP_SCRIPT` 的代码只为兼容旧安装包保留，核心更新不再走它。
- **外壳/Electron 升级**：`shell/updater.mjs` 用 electron-updater（electron-builder 的 NSIS/dmg/AppImage + `latest.yml`/`latest-linux.yml` + blockmap）。主进程把 `shellUpdate` 状态/操作挂在 host 上，页面走 `/api/shell-update/check|download|install`，进度是 SSE `shellUpdate`。安装时先停 dsh、退出，再静默安装并拉起新版。mac 的包是临时签名、装不上更新包，所以只出 dmg、不发 zip/latest-mac.yml，`updater.mjs` 在 mac 上直接当不支持（`DSH_UPDATE_FEED` 仍可本地演练）；拿到 Developer ID 后加回 zip 目标并放开那里的平台限制。Linux 的 AppImage 自更新要求从 AppImage 启动（`APPIMAGE` 环境变量存在）；deb 装出来的进程没有这个变量，`updater.mjs` 直接当不支持，用户去发布页换包（核心那层照旧走 npm）。
- **核心升级**：核心包声明 `dshX.electron`，和当前进程不一致时 `checkAppUpdate` 返回 `reason: 'electron'`，页面提示先更新外壳；核心更新只换核心目录，不动 Electron。
- 边界：源码运行、npm 版（`NPM_MODE`）、npm 上还没有对应平台包时都不提供核心更新；拆包后的核心模式（`DSH_CORE=1`）关掉 GitHub 安装包自更新检查，由外壳的 electron-updater 负责。
- 快捷方式图标：electron-builder 的快捷方式指向 `DSH.exe`，图标随外壳安装包更新；核心模式不再调 `refreshShortcuts`。
- 本地验收：`node scripts/update-flow-demo.mjs` 用 `release/core-stage` 造一份 0.1.21 的假核心和假 npm registry，复制 `release/eb/win-unpacked` 到 `release/test-install`，按打印的命令（`APPDATA` 指到 `test-install/userdata`、带 `DSH_CORE_REGISTRY`）启动，点更新即可走「复制到 core/current → 重启外壳」；外壳更新用 `DSH_UPDATE_FEED` 指到本地 latest.yml 目录。

### npm 版（npm-package/）

- `npm-package/` 是 `@yyh001/dsh-x` CLI 包：`npm i -g @yyh001/dsh-x` 后 `dsh-x` 启动。包里有 `shell/` 和图标（`assets/icon.png`、`tray.ico`、`tray.png`），版本跟 `shell/package.json` 走；依赖 `electron`（版本跟根 `package.json` 的 devDependencies 对齐），核心从 npm 拉跨平台的 `dsh-x-core` 到用户缓存（Windows `%LOCALAPPDATA%\dsh-x`、mac `~/Library/Caches/dsh-x`、Linux `~/.cache/dsh-x`），然后 `spawn(electron, [包根])` 启动外壳，并用 `DSH_CORE_DIR` 指向缓存核心。
- CLI 设置 `DSH_NPM=1`、`DSH_CORE_DIR` 和 `DSH_ELECTRON_BIN`；核心的 `NPM_MODE` 会关掉安装包/核心自更新，设置页「关于」提示用 `npm update -g @yyh001/dsh-x`。`node/` 包装脚本优先用 `DSH_ELECTRON_BIN`，找不到才回退安装版的 `DSH.exe` / `Contents/MacOS/DSH` / AppImage 根目录的 `DSH`。
- `scripts/pack-npm.mjs` 打包/发布 CLI（含外壳）；CI 的 `npm-package` job 在三个平台构建后发 `dsh-x`（需要 `NPM_TOKEN` 和 npm 上的包名）。npm 版没有快捷方式、卸载项和开机自启；数据目录与安装版共用。

### 打包与安装布局

- 文件管理的实现类不在 `APP_FILES` 里，`copyAppFiles` 把三套都拷进核心包（`FILE_MANAGERS`）；运行时 `filemanager.js` 按平台动态 import 只加载一套。核心包跨平台，所以不能再按平台只带一套；外壳才按平台分开。
- `APP_FILES`（`scripts/pack-common.mjs`）= 核心源码清单；`copyAppFiles` 把它们平铺拷进核心目录（macOS: `DSH-X.app/Contents/Resources/core/`；Windows: `<安装目录>/resources/core/`；Linux AppImage: `AppDir/resources/core/`），**不打 asar**：dsh 子进程要按真实路径读 `compat/`、`perf/`。核心的 `package.json` 的 `main` 是 `server.js`，由外壳动态 import。
- 核心目录里还有 `node/`（运行时目录：只有 npm / pnpm 的 JS 包和 `node` / `node.cmd` 包装，**没有 node.exe**——dsh 子进程用 Electron 自带的 Node）、`public/`、`assets/`、`compat/`、`perf/`、`packs/`。
- **Windows / macOS / Linux 外壳都是 Electron**：`pack.mjs` 先分别组装 `release/shell-stage`（`shell/` + 图标 + `electron-updater` 依赖，版本 = `shell/package.json`）和 `release/core-stage`（`APP_FILES` + `node/`，版本 = 根 `package.json`），再交给 electron-builder（`electron-builder.config.mjs`）出 NSIS/dmg/AppImage/deb；`directories.app` 指 shell-stage，core-stage 走 `extraResources` 放到 `resources/core`。`asar: false` 保持真实文件路径。早先的 Rust 安装引擎与 Inno 安装脚本已删，三个平台的安装包全由 electron-builder 出。
- **Electron 版本钉死 44.7.0，别随手升**：dsh 的 `node-addon-require-builtin` 只给几个 Electron 版本留了预编译（43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6），版本对不上时 dsh 一启动就报 `unsupported Electron runtime fingerprint`（见 `dsh: host preparation failed`）。升级 Electron 前先看 dsh 那边的支持列表，改完在打包版里真启动一个实例验证。
- 三个平台和服务同进程（Electron 外壳），用 `setHost({ onWake, openTab, openWindow, exit, relaunch, shellUpdate })` 直接接管；`relaunch` 供核心更新后重启外壳（`app.relaunch()`，避免单实例锁把新进程顶掉）。旧 Rust 外壳读 stdout 标记行的路径已经退役。
- dsh / npm / pnpm 子进程一律用 `platform.js` 的 `RUNTIME_NODE`，**别用 `process.execPath` 自己拼**：Electron 里 `RUNTIME_NODE` 就是 Electron 本体，拉子进程时必须同时展开 `RUNTIME_NODE_ENV`（里面是 `ELECTRON_RUN_AS_NODE=1`），否则会当 GUI 打开；`withBundledRuntime` / `orderRuntimePaths` 负责把 `node/` 里的 `node` / `node.cmd` 包装放进 PATH。
- 自更新（Windows）：electron-updater 下载 NSIS 安装包 → 静默安装 → 由安装程序拉起新版；Linux 用 `latest-linux.yml` + AppImage（从 AppImage 启动时 `APPIMAGE` 环境变量存在，electron-updater 才能替换）。macOS 目前不提供外壳自更新：临时签名装不上 zip 更新包，发布页只发 dmg 供手动安装。electron-builder 的 `latest.yml` / `latest-linux.yml` 和 `.blockmap` 必须一起上传，否则差分/更新取不到包。
- 发版产物要一起传：Windows 的 `DSH-Setup-<外壳版本>.exe` + `.blockmap` + `latest.yml`，mac 的 dmg（外壳自更新暂不提供，所以不发 zip/latest-mac.yml），Linux 的 AppImage + deb + `latest-linux.yml`（deb 不进这个 yml）；核心 npm 包（`<核心版本>`）由 `pack-core.mjs` 单独发。只改核心时外壳版本不变，安装包名和 `latest*.yml` 的版本与上次相同（electron-updater 因此不提示外壳更新），核心走 npm 更新。

### 网络与子进程环境

- 外网请求一律走 `netFetch`（`proxy.js`）：先代理后直连、回环地址不代理。Node 22.19 的全局 fetch 不认代理。
- 给 dsh 子进程的 PATH 末尾追加运行时的 `.bin` 与写死 node 的 shim，但**用户自己的 pnpm 优先**（见 `orderRuntimePaths`）。store 主版本跟着 pnpm 主版本走（8→v3 / 10→v10 / 11、12→v11），拿错版本去动 profile 会 `ERR_PNPM_UNEXPECTED_STORE`，所以**插件命令**会先按 profile 的 `node_modules/.modules.yaml` 记的 store 挑一次 pnpm（`preferredPnpmDir`/`pickPnpmDir`，挑不出来才回退「系统优先」，并把两边的 store 版本写进日志）。便携兜底那份是 pnpm 11.27.1，版本钉在 `pack-common.mjs` 的 `PNPM_VERSION`，打包时按版本号校验缓存（`vendor/pnpm`）。
- dsh CLI 在参数解析阶段就拒掉保留 profile 名（`desktop`，官方留给自家 Electron 端），两个入口各有一套绕法（`CLI_BLOCKED_PROFILES`）：
  - **启动**：入口换成 `reserved-profile-boot.mjs`（直接调 boot 层，argv 形状与 CLI 一致）。
  - **插件命令**：CLI 只按名字找 profile，所以给原件在同目录建一个目录链接别名（`.dsh-alias-desktop` → `desktop`，`ensureProfileAlias`，Windows 用 junction），命令改指别名 —— 一份目录两个名字，不复制也不漂移。别名以点开头，`listProfiles` 会跳过，界面里只看得到 `desktop`。
  - 两者的理由与边界：真名 `desktop` 永远留给官方桌面端（别去改它的目录内容），启动器只是换入口/换名字去用同一份数据。
- 可选下载源（镜像 / 官方），要传给 dsh 子进程，让它装插件时用同一个源。

## 改代码时容易踩的

- **Node 22.19：注册过 ESM 钩子后 `error.stack` 变成只读**（`writable: false`）。dsh 的 app-boot 会写 `error.stack = ...`，一写就抛 `TypeError`，把原始错误码顶掉。`compat/session-events.mjs` 已把它包进 try/catch，**别去掉**。
- **插件 import 失败会让 dsh 秒退**（插件树的单点故障）。涉及 profile 依赖、补丁层的改动要格外保守，改完用 `plugin-tool.js list` 或真启动一次验证。
- **Windows 的 junction**：pnpm 用 junction 指向 `.pnpm`，目标被删就悬空，读目录会报 `UNKNOWN ... -4094`；还有一类机器根本读不了 junction。两条退路都在 `server.js`（清理悬空链接、让 pnpm 不用链接），清理时要扫进 `@scope` 一层。
- 管理页端口每次启动可能变（被占用会顺延）：旧链接 401、旧标签页里"插件包加载失败"都是正常现象，不用"修"。
- cookie 堆到 16 KB 会让全站 `HTTP 431`：给 cookie 加内容前先算总量。
- 测试输出别接管道（会说第二遍，因为真有人踩）。
- `data/`、`release/`、`vendor/` 里的东西可以随便清（都是产物），但 `release/release-key.pem` 除外。
