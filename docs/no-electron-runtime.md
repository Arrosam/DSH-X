# 不内置 Electron：外壳、运行时与按需下载

这次要把「DSH-X = 一个 Electron 应用」改成「DSH-X = 自己 + 按需下载的运行时」。目标与取舍记在这里，改代码前先读。

## 目标

- 安装包里**没有** Electron，也没有 Node：装完只有一个原生外壳和启动器自己的代码。
- 默认把 dsh 页面交给系统浏览器打开；只有用户选了「DSH-X 内部标签页 / 独立窗口」，才下载 Electron。
- **DSH-X 的更新只换自己的代码**（app 层 + 安装包），已下载的 Node / Electron 运行时不跟着变。
- Windows 与 macOS 同一套约定。

## 三层结构

```
安装包（约 15 MB；macOS 实测 dmg 14.5 MiB、.app 48 MB、外壳二进制 2.9 MiB）
  DSH.exe / DSH-X.app/Contents/MacOS/DSH      原生外壳（Rust：tao + wry + tray-icon）
  resources/app/（mac: Resources/app/）        启动器自己的代码（本仓库顶层 .js + public / shell / compat / perf / packs）

每用户数据目录（APP_DIR，Windows: %APPDATA%\DSH，macOS: ~/Library/Application Support/DSH）
  settings.json / manager.log / launcher.log / electron/   原有内容（electron/ 是 Electron 窗口的浏览器数据）
  runtime/node/<node 版本>/                    首次运行下载的 Node（含 npm）
  runtime/electron/<electron 版本>/            用户选择内部标签页 / 独立窗口后下载的 Electron
```

运行时放数据目录而不是安装目录，有两个硬理由：macOS 的 `.app` 是签过名的，往里写东西会破坏签名；Windows 的 `Program Files` 也不一定可写。顺带满足「更新不动运行时不」——更新只改 `resources/app` 里的东西。

## 外壳职责与启动链路

外壳（`launcher/` 的 `DSH`）负责：控制面板窗口、托盘 / 菜单栏、单实例、开机自启（自启项指向外壳，由 `filemanager` 的实现类写），以及拉起和收掉 Node 服务。关窗口只是藏起来，托盘还在、dsh 照常跑；退出走托盘菜单 → `POST /api/quit` → 服务收尾 → 外壳跟着退。

1. 外壳启动先看 `runtime/node/<版本>/`（`find_node` 也接受旧安装包留下的 `app/node/node.exe`；升级安装包会清掉它）。缺就在窗口里显示准备页（`launcher/main.rs` 的 `PREPARING_PAGE`），下载官方 Node 发行包：先 npmmirror、再 nodejs.org 兜底，版本与 sha256 来自仓库根的 `runtime-versions.json`——外壳**编译期**把这份表嵌进二进制，因为这时还没有 Node，不能信安装目录里某个还没校验的文件。解压到 `runtime/node/.staging-<pid>` 再整体改名（macOS 是 tar.gz 走系统 tar，Windows 是 zip 走 zip 库）。
2. 用下载好的 node 拉起 `start.js`：`PATH` 前置该运行时，`DSH_APP_WINDOW=1`，`DSH_RUNTIME_NODE=<node 路径>`，`DSH_INTERNAL_TABS=1`（外壳能不能开标签窗口）。
3. 服务在 stdout 上打标记行，外壳读：
   - `__DSH_SHOW__` —— 把控制面板窗口叫到前面；
   - `__DSH_OPEN__ <url>` —— 用 Electron 独立窗口打开；
   - `__DSH_TAB__ <json>` —— 用 Electron 标签窗口打开（JSON 带 `id` / `title` / `url` / `status`，认证地址因此只在本机管道里传）。
   “Electron 装没装”由服务端按数据目录里有没有 `.ready` 现查，用户中途下载完不需要重启；外壳拉不起 Electron 时退回系统浏览器。
4. 控制面板窗口是 wry 的 WebView（Windows WebView2 / macOS WKWebView），指向 `http://127.0.0.1:<端口>/?window=1|mac`，窗口按钮与拖动仍走 `window.ipc`。第二次启动外壳时先探测端口上的管理页（`/api/ping` 认 `app: "dsh-x"`），找到就请它把自己的窗口叫出来，然后安静退出——不再起第二个服务。

## 打开方式

| openMode | 谁打开 | 需要 Electron |
|---|---|---|
| `tab`（默认） | 系统默认浏览器 | 否 |
| `app` | 机器上装的 Chrome / Edge 应用窗口 | 否 |
| `window` | Electron 独立窗口 | 是 |
| `internal` | Electron 标签窗口 | 是 |

服务把「外壳能托管」（`DSH_APP_WINDOW=1`；`DSH_INTERNAL_TABS=1` 表示外壳支持标签窗口）和「运行时已下载」（现查 `.ready`）合起来判断（`server.js` 的 `openRoute` 看前一条和 `.ready`）；不成立就降级系统浏览器，日志和设置页都会说明原因。用户选内部标签 / 独立窗口但运行时没装时，设置页给下载按钮并显示进度：进度走 SSE 的 `runtime` 事件，`GET /api/runtime` 是重载后的快照，`POST /api/runtime/download|cancel` 控制。装好立即生效，不需要重启。

## Electron 运行时的下载

- 由**服务端**（JS）做，不占 Rust：Node 那时已经在跑了，下载 / 校验 / 解压都有现成工具，代理（`proxy.js` 的 `netFetch`）、SSE 进度、取消也都是现成的。
- 版本与压缩包 sha256 写在仓库根的 `runtime-versions.json`，按 平台+架构 查表；外壳编译期嵌入这份文件，服务端与打包脚本读同一份。
- 下载地址是 Electron 官方 GitHub Release（`v<版本>/<压缩包名>`），镜像按设置里的下载源套 `updateUrlCandidates`。边下边算 sha256；解压到 `runtime/electron/.tmp-<版本>-<id>`，确认可执行文件在，再写 `.ready`（JSON，含版本 / 平台 / 架构 / 安装时间）并整体改名到 `runtime/electron/<版本>/`；失败清理半成品。解压用系统工具（macOS `ditto`、Windows 自带 `bsdtar`，没有 tar 才退 PowerShell）：Electron.app 里有大量符号链接，只认文件的解压器会把它解坏。
- `platform.js` 的 `electronRuntime()` 只认 `.ready`。外壳不关心下载过程，只在需要开窗口时扫一遍 `runtime/electron/`，取装了 `.ready` 且可执行文件在的最新一份（按目录 mtime）。

## Electron 标签窗口

下载下来的是**原版 Electron**，不预先改包。外壳这样拉起：

```
<runtime>/electron/<版本>/Electron.app/Contents/MacOS/Electron <app 目录> --tab <url> --title <标题>
<runtime>/electron/<版本>/electron.exe <app 目录> --tab <url> --title <标题>
```

- 传进去的 `<app 目录>` 是 app 层根目录（安装布局下是 `resources/app`，不是 `shell/`）：它的 `package.json` 的 `main` 指向 `shell/main.mjs`，Electron 从这个入口启动标签窗口。
- 管理服务地址走环境变量 `DSH_MANAGER_URL`（`http://127.0.0.1:<端口>/`），标签窗口据此轮询 `/api/tray` 拿语言、主题和实例列表（标签的标题与地址）。
- 标签窗口和独立窗口用 Electron 自己的**单实例锁**：第二次拉起的进程在 `second-instance` 里通过 `requestSingleInstanceLock` 的 `additionalData` 把 `--tab` / `--window` 交给已有实例，然后退出。外壳不需要额外的管道或端口。
- 标签窗口不再承载控制面板、也没有托盘，只做 dsh 页面的窗口和标签条；设置页仍在原生窗口里。窗口全关就是 Electron 退出，服务和 dsh 实例都不受影响。`shell/` 的更新跟着 app 层走，Electron 版本变化不牵动它。

## 更新边界

- 安装包 / app 层更新：只换 `resources/app`（mac 还要重签 `.app`），照现在的增量更新流程。Node / Electron 运行时在数据目录里，不碰。
- Electron 运行时的版本只由 app 层带的 `runtime-versions.json` 决定：app 更新换了新版本号后，旧运行时不算数，用户需要在设置页重新下载一次新的；旧版本目录留着。**目前没有单独的运行时更新 / 回滚 UI**，外壳按 mtime 取最新那个带 `.ready` 的目录。
- 旧的「引导器安装包（DSH-Setup-lite）+ `current.json` + junction」那套随 Electron 一起退役：外壳自己就会下 Node，不需要第二个下载器。

## 迁移

- 0.1.x 的安装版升级上来：安装包装好新的外壳与 app 层，数据目录里没有 `runtime/`，首次启动走一次 Node 下载。
- 旧安装目录里的 `node/node.exe`、Electron 框架文件由安装包清理（`dsh-setup.iss` 的 `[InstallDelete]`）；macOS 是把新 `.app` 整个拖进「应用程序」替换旧包。
- `openMode` 若还是 `internal`/`window` 而 Electron 没装：服务按能力降级到浏览器，页面提示重新选。

## 退役清单

`launcher/boot.rs` 与 `boot/`、`scripts/dsh-boot-setup.iss`、lite 安装包与 `runtime-<版本>` 资产、`scripts/electron-prune.mjs`、`shell/env.mjs`、`electron` / `@electron/packager` 两个 devDependencies（`package-lock.json` 里一并清掉）。

app 层里的 `node/` 仍然保留——但只放 npm / pnpm 的 JS 包和 `npm` / `npx` / `pnpm` / `pnpx` 包装（没有 node 可执行文件）：`dsh plugin` 要靠 pnpm，而 pnpm 装到数据目录会污染签名过的安装目录；node 本体则由下载的运行时提供，包装脚本调用 PATH 上的 `node`。

## 已验证到什么程度

- **macOS 打包**：`.app` 里没有 Frameworks、也没有 `node.exe`；`codesign --verify --deep --strict` 通过（ad-hoc 签名，未公证）。dmg 14.5 MiB，`.app` 48 MB，外壳二进制 2.9 MiB。
- **首次启动**：在隔离的 HOME 里实测：下载 Node → 拉起服务 → 控制面板窗口可用。
- **Electron 运行时**：实测经 gh-proxy 下载 Electron 44.7.0、sha256 校验通过、解压后写 `.ready`；能力上报随即变成可用，`POST /api/open` 用下载来的 Electron 拉起了标签窗口，全程没重启。
- **服务端接口**：`GET /api/runtime`、`POST /api/runtime/download|cancel` 与 SSE 的 `runtime` 事件按上面的语义工作。

## 未验证 / 仍需决定

- **Windows**：本轮只在 macOS 上编译、运行和打包。Windows 的 WebView2、托盘、单实例、`DSH.exe` → `resources/app` 布局、Inno 安装包与体积都还没在 Windows 上冒烟。
- **0.1.x 覆盖升级**：安装包的清理清单已写好，但没有真机升级验证；旧用户第一次启动的 Node 下载时长也未测。
- **macOS 最低系统版本**：`Info.plist` 写的是 `LSMinimumSystemVersion=11.0`（跟着下载的 Node 22 与 Rust 的部署目标）；但按需下载的 Electron 对 macOS 的最低要求可能更高，选内嵌窗口的用户实际门槛以 Electron 官方支持为准，未在 macOS 11/12 上验证。
- **运行时升级 / 回滚**：见「更新边界」——旧目录保留，但没有选择或回滚的入口。
- **版本表的可信来源**：`runtime-versions.json` 里的版本与 sha256 是人工核对的，仓库里没有对照官方 `SHASUMS256.txt` 的自动校验；换版本时要人工核一遍。
- **Electron 下载体积**：随平台 / 架构变化，文档和 README 都不写固定数字。
