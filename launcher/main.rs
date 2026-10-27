#![cfg_attr(windows, windows_subsystem = "windows")]

//! DSH-X 原生外壳：拉起 node 跑管理服务，再把管理页装进自己的窗口。
//! Windows 上是 DSH.exe（WebView2），macOS 上是 DSH-X.app 里的 Contents/MacOS/DSH（WKWebView）。
//!
//! 和 0.1.x 的差别：安装包里不再有 Electron，也不再自带 node。首次启动先把 Node 运行时
//! 下载到每用户数据目录（见 runtime.rs），之后用它拉起 start.js。dsh 的页面默认交给系统
//! 浏览器；只有用户选了「内部标签页 / 独立窗口」才按需下载 Electron，由这里的标记行转成
//! 一次对 Electron 标签窗口的调用（单实例锁在 Electron 那边，见 shell/main.mjs）。
//!
//! 之所以要窗口而不是丢给系统浏览器：浏览器只允许脚本关闭「自己用 window.open 打开的」
//! 页面，所以系统浏览器里那个标签页谁也关不掉。窗口是本进程创建的，收放就都是自己的事。
//!
//! 关窗口 ≠ 退出：托盘还在、dsh 照常跑，需要时从托盘再叫回来。
//!
//! node 通过 stdout 上的标记行和外壳说话（见 server.js 的 host 默认实现）：
//! `__DSH_SHOW__` 叫回窗口，`__DSH_OPEN__ <地址>` 开独立窗口，`__DSH_TAB__ <json>` 开标签页。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
#[cfg(target_os = "macos")]
use tao::dpi::LogicalPosition;
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Window, WindowBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use wry::{Rect, WebContext, WebView, WebViewBuilder};

mod health;
mod runtime;
mod tray;
use runtime::Progress;
use tray::{LaunchEntry, LaunchMenus};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 每用户目录名（和 platform.js 的 APP_DIR_NAME 一致）：settings.json、运行时、日志都在它下面。
const APP_DIR_NAME: &str = "DSH";
/// 管理页地址上的 window 参数：页面据此决定自己画窗口按钮（Windows）还是给系统红绿灯让位（macOS）。
#[cfg(windows)]
const WINDOW_QUERY: &str = "1";
#[cfg(target_os = "macos")]
const WINDOW_QUERY: &str = "mac";
/// 红绿灯的位置（逻辑像素，相对窗口左上角）：对齐页面顶栏的竖直中线，页面在左边让出了这块。
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET: (f64, f64) = (18.0, 29.0);
/// 托盘图标边长：Windows 托盘只要 16/32；macOS 菜单栏按 18pt 显示，给 2 倍图才不糊。
#[cfg(windows)]
const TRAY_ICON_SIZE: u32 = 32;
#[cfg(target_os = "macos")]
const TRAY_ICON_SIZE: u32 = 36;
/// 管理页默认端口；设置页里可以改（存在每用户目录的 settings.json）。
const DEFAULT_PORT: u16 = 3780;
/// 等管理服务起来的时限；超了也照常开窗口，让页面自己显示连接失败。
const PORT_WAIT: Duration = Duration::from_secs(60);
/// 找管理页时最多往后扫这么多端口（和 server.js 的 PORT_SCAN 保持一致）。
const PORT_SCAN: u16 = 20;
/// 单个本机端口的探测不能拖住启动。Windows 防火墙有时会让一个未监听端口等约 2 秒才失败。
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(120);
const PROBE_IO_TIMEOUT: Duration = Duration::from_millis(180);
/// 顺延端口并行探测的总预算。超过这个时间就当作没有旧实例，继续创建窗口。
const PROBE_SCAN_BUDGET: Duration = Duration::from_millis(350);
/// 首次出现的窗口尺寸（逻辑像素）
const WINDOW_W: f64 = 1100.0;
const WINDOW_H: f64 = 760.0;
const WINDOW_MIN_W: f64 = 720.0;
const WINDOW_MIN_H: f64 = 520.0;
/// node 的 stderr 只留最后这么多行，够装下一条报错加它的堆栈
const STDERR_TAIL_LINES: usize = 40;
/// node 退出后，最多再等这么久让 stderr 读到头（进程没了，管道里可能还有最后几行）
const STDERR_FLUSH_WAIT: Duration = Duration::from_millis(500);
/// node 往 stdout 打这一行，就表示它要我们把窗口叫到前面（见 start.js 的 requestShow）。
const SHOW_SIGNAL: &str = "__DSH_SHOW__";
/// node 往 stdout 打这一行（后面跟一个空格和地址），表示「把这个地址装进独立窗口」
/// （见 server.js 的 OPEN_SIGNAL）。设置里选了桌面窗口时，页面上的「打开 DSH」走的就是它。
const OPEN_SIGNAL: &str = "__DSH_OPEN__";
/// node 往 stdout 打这一行（后面跟一个 JSON），表示「在标签窗口里打开这个实例」
/// （见 server.js 的 host.openTab 默认实现）。
const TAB_SIGNAL: &str = "__DSH_TAB__";
/// 菜单项 id
const ITEM_MANAGER: &str = "manager";
const ITEM_QUIT: &str = "quit";
/// macOS 应用菜单里的 ⌘W：和关窗口一样只是藏起来
#[cfg(target_os = "macos")]
const ITEM_CLOSE_WINDOW: &str = "close-window";

#[derive(Debug)]
enum UserEvent {
    Show,
    /// node 退出了（正常路径：托盘退出、/api/quit 收尾完）
    Exited,
    /// 安静退出：端口上已经是另一个实例的管理页，start.js 叫醒它之后退 0
    Exit,
    /// 以下几个来自页面：原生标题栏去掉了，最小化/最大化/关闭/拖动都由页面发过来
    Minimize,
    ToggleMaximize,
    Hide,
    Drag,
    /// 错误页上的「关闭」
    Quit,
    /// 轮询到的最新托盘状态
    Tray(TrayState),
    TrayError(String),
    /// 页面里点出来的链接：按当前打开方式决定交给标签窗口、独立窗口还是系统浏览器
    OpenExternal(String),
    /// node 标记行：开 Electron 独立窗口
    OpenWindow(String),
    /// node 标记行 / 页面链接：开 Electron 标签页
    OpenTab(Instance),
    /// 运行环境下载进度
    Boot(Progress),
    /// 运行环境装好、管理服务已就绪，可以把管理页装进窗口了
    BootReady,
    /// 运行环境或管理服务起不来：窗口里换成错误页
    BootFailed(String),
    /// 管理页的渲染进程退出或卡死：必须重载，WebView2 不会自己恢复
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    ManagerFailed(health::Failure),
}

/// 从 /api/tray 读回来的状态（纯文本 key=value，见 server.js）
#[derive(Debug, Default, Clone)]
struct TrayState {
    status: String,
    url: String,
    installed: bool,
    /// 界面语言（zh / en），由管理页的 /api/tray 带过来
    lang: String,
    /// 打开方式（tab / app / window / internal），由管理页的 /api/tray 带过来
    openmode: String,
    /// 本进程是不是由原生外壳托管（＝这个进程自己，永远为真；源码运行那一侧才是 0）
    shell: bool,
    theme: String,
    instances: Vec<Instance>,
    launches: Vec<LaunchEntry>,
}

impl TrayState {
    /// 该不该让 Electron 开独立窗口：设置里选了 window，且外壳在（本进程就是）。
    fn window_mode(&self) -> bool {
        self.openmode == "window" && self.shell
    }

    /// 该不该让 Electron 开标签页：设置里选了 internal，且外壳在。
    /// 运行环境有没有装好由调用方判断（没装就退回浏览器，页面那边会提示下载）。
    fn internal_mode(&self) -> bool {
        self.openmode == "internal" && self.shell
    }
}

/// 一个正在跑（或停着）的 dsh 实例。和 server.js 的 internalTabTarget 同一组字段。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Instance {
    id: String,
    title: String,
    url: String,
    status: String,
    managed: bool,
}

impl Instance {
    fn parse(value: &Value) -> Option<Self> {
        let id = value.get("id")?.as_str()?.to_string();
        let url = value.get("url")?.as_str()?.to_string();
        if id.is_empty() || (!url.is_empty() && !is_loopback_url(&url)) {
            return None;
        }
        Some(Self {
            id,
            url,
            title: value.get("title").and_then(Value::as_str).unwrap_or("DSH").to_string(),
            status: value.get("status").and_then(Value::as_str).unwrap_or("running").to_string(),
            managed: value.get("managed").and_then(Value::as_bool).unwrap_or(true),
        })
    }
}

/// 日志里给「渲染进程出什么事了」一个说法（只用于日志，不影响行为）。
fn failure_text(failure: health::Failure) -> &'static str {
    match failure {
        health::Failure::Exited => "退出",
        health::Failure::Unresponsive => "无响应",
    }
}

/// 管理页自动恢复的最小间隔：崩溃循环里不能无限重载（重载本身也会把 CPU 打满）。
const RECOVER_COOLDOWN: Duration = Duration::from_secs(60);

fn should_recover(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|at| now.duration_since(at) >= RECOVER_COOLDOWN)
}

fn parse_tray_state(text: &str) -> TrayState {
    let mut state = TrayState::default();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "status" => state.status = value.trim().to_string(),
            "url" => state.url = value.trim().to_string(),
            "installed" => state.installed = value.trim() == "1",
            "lang" => state.lang = value.trim().to_string(),
            "openmode" => state.openmode = value.trim().to_string(),
            "shell" => state.shell = value.trim() == "1",
            "theme" => state.theme = value.trim().to_string(),
            "instances" => {
                if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(value) {
                    state.instances = items.iter().filter_map(Instance::parse).collect();
                }
            }
            "launches" => {
                if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(value) {
                    state.launches = items.iter().filter_map(LaunchEntry::parse).collect();
                }
            }
            _ => {}
        }
    }
    state
}

/// node 那行标记 → 要打开的地址（不是这行就返回 None）。
fn parse_open_signal(line: &str) -> Option<String> {
    let url = line.trim().strip_prefix(OPEN_SIGNAL)?.trim();
    if url.is_empty() {
        return None;
    }
    Some(url.to_string())
}

/// node 那行标签标记 → 要打开的实例（不是这行就返回 None）。地址必须在本机，外站不进标签页。
fn parse_tab_signal(line: &str) -> Option<Instance> {
    let payload = line.trim().strip_prefix(TAB_SIGNAL)?.trim();
    let value: Value = serde_json::from_str(payload).ok()?;
    let target = Instance::parse(&value)?;
    if target.url.is_empty() {
        return None;
    }
    Some(target)
}

/// 地址的 host（没有 scheme 或 host 为空时返回 None）。只做够用的事：不引入 URL 库，
/// 只用来判断「这是不是本机地址」「是不是同一个源」。
fn url_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // 去掉 userinfo（user:pass@host）：@ 之后才是 host
    let authority = authority.rsplit('@').next()?;
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 字面量：[::1]:9716 → ::1
        return rest.split(']').next();
    }
    Some(authority.split(':').next().unwrap_or(""))
}

/// 是不是本机地址：dsh 的界面、管理页都在回环上；外链一律交给系统浏览器。
fn is_loopback_url(url: &str) -> bool {
    matches!(url_host(url), Some("127.0.0.1") | Some("localhost") | Some("::1"))
}

/// http(s) 地址（含本机）：这种才有可能交给系统浏览器打开。
fn is_web_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// 两个地址的「scheme://authority」是否相同——用来认出「这个链接就是 dsh 自己」。
fn same_origin(a: &str, b: &str) -> bool {
    match (origin_of(a), origin_of(b)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if scheme.is_empty() || authority.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase()))
}

/// 原生托盘。菜单项句柄要留着——状态一变就得改文案和可用性。
struct Tray {
    _icon: TrayIcon,
    launches: LaunchMenus,
    manager: MenuItem,
    quit: MenuItem,
}

impl Tray {
    fn sync(&mut self, state: &TrayState) {
        let en = state.lang == "en";
        self.manager.set_text(if en { "Open DSH-X" } else { "打开启动器" });
        self.quit.set_text(if en { "Quit" } else { "退出" });
        self.launches.sync(&state.launches, en);
    }
}

/// 托盘图标用不了 256 那帧（托盘只要 TRAY_ICON_SIZE），从大图缩下去。
fn load_tray_icon(root: &Path) -> Option<tray_icon::Icon> {
    let bytes = std::fs::read(root.join("assets").join("tray.ico")).ok()?;
    let (rgba, width, height) = decode_ico(&bytes)?;
    let source = image::RgbaImage::from_raw(width, height, rgba)?;
    let size = TRAY_ICON_SIZE;
    let scaled = image::imageops::resize(&source, size, size, image::imageops::FilterType::Lanczos3);
    tray_icon::Icon::from_rgba(scaled.into_raw(), size, size).ok()
}

fn build_tray(root: &Path) -> Option<Tray> {
    let menu = Menu::new();
    let manager = MenuItem::with_id(ITEM_MANAGER, "打开启动器", true, None);
    let quit = MenuItem::with_id(ITEM_QUIT, "退出", true, None);
    let _ = menu.append(&manager);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&quit);
    let launches = LaunchMenus::new(menu.clone());
    let icon = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        // Windows：左键留给「打开启动器界面」，菜单走右键。macOS 菜单栏的惯例是单击就出菜单，
        // 叫回窗口由程序坞图标负责（见 Event::Reopen）。
        .with_menu_on_left_click(cfg!(target_os = "macos"))
        .with_tooltip("DSH-X")
        .with_icon(load_tray_icon(root)?)
        .build()
        .ok()?;
    Some(Tray {
        _icon: icon,
        launches,
        manager,
        quit,
    })
}

/// 启动失败时显示的页面。刻意不用系统弹窗（mshta/javascript:alert 那种）——它长得和
/// 窗口里的其它东西没关系，是这套界面里唯一格格不入的一块。
const ERROR_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH-X</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         background: #15171c; color: #e7e9ee;
         font: 14px/1.6 "Microsoft YaHei UI", "Segoe UI", sans-serif;
         -webkit-user-select: none; user-select: none; }
  .card { width: 100%; max-height: 100%; display: flex; flex-direction: column;
          padding: 26px 28px; background: #1c1f26; border-top: 1px solid #2a2e38; }
  .head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #f2777a;
         box-shadow: 0 0 0 4px rgba(242, 119, 122, .16); }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 14px; color: #b9bec9; }
  pre { margin: 0 0 20px; padding: 10px 12px; background: #14161b; border: 1px solid #262a33;
        border-radius: 8px; overflow: auto; color: #9aa1ad;
        font: 12px/1.5 Consolas, "Courier New", monospace; white-space: pre-wrap;
        word-break: break-all; -webkit-user-select: text; user-select: text; }
  button { align-self: flex-start; border: 0; border-radius: 8px; padding: 9px 20px;
           background: #3b6cff; color: #fff; font: inherit; font-size: 13px; cursor: pointer; }
  button:hover { background: #4a78ff; }
</style></head>
<body>
  <div class="card">
    <div class="head" id="drag"><span class="dot"></span><h1>__TITLE__</h1></div>
    <p>__MESSAGE__</p>
    <pre>__DETAIL__</pre>
    <button onclick="window.ipc.postMessage('quit')">关闭 / Close</button>
  </div>
  <script>
    const drag = document.getElementById('drag');
    drag.addEventListener('mousedown', (e) => {
      if (e.target.tagName !== 'BUTTON') window.ipc.postMessage('drag');
    });
  </script>
</body></html>
"#;

/// 首次启动下载 Node 运行时那张页。和服务起来之后的管理页是两张页：这张不依赖服务，
/// 所以窗口先把它显示出来，运行环境装好再换成管理页。
const PREPARING_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH-X</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         background: #15171c; color: #e7e9ee;
         font: 14px/1.6 "Microsoft YaHei UI", "Segoe UI", sans-serif;
         -webkit-user-select: none; user-select: none; }
  .card { width: min(520px, calc(100vw - 48px)); padding: 30px 32px;
          background: #1c1f26; border: 1px solid #262a33; border-radius: 12px; }
  h1 { margin: 0 0 10px; font-size: 16px; font-weight: 600; }
  p { margin: 0 0 18px; color: #b9bec9; font-size: 13px; }
  .bar { height: 4px; border-radius: 999px; background: #2a2e38; overflow: hidden; }
  .bar > span { display: block; width: 0%; height: 100%; border-radius: inherit;
                background: #3b6cff; transition: width .18s ease; }
  .bar.indeterminate > span { width: 38%; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }
  .status { margin: 12px 0 0; color: #9aa1ad; font-size: 12px; font-variant-numeric: tabular-nums; }
</style></head>
<body>
  <div class="card">
    <h1>DSH-X</h1>
    <p>DSH-X 需要一份 Node 运行环境，正在准备。只需要下载这一次。<br>
       DSH-X needs a Node runtime. Downloading it once.</p>
    <div class="bar indeterminate" id="bar"><span></span></div>
    <p class="status" id="status"></p>
  </div>
  <script>
    window.bootProgress = (p) => {
      const bar = document.getElementById('bar')
      const status = document.getElementById('status')
      bar.classList.remove('indeterminate')
      if (p.total > 0) {
        bar.firstElementChild.style.width = Math.min(100, (p.done / p.total) * 100).toFixed(1) + '%'
      } else {
        bar.classList.add('indeterminate')
      }
      const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
      status.textContent = p.total > 0
        ? p.message + '  ' + mb(p.done) + ' / ' + mb(p.total) + ' MB'
        : p.message
    }
  </script>
</body></html>
"#;

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn error_page(title: &str, message: &str, detail: &str) -> String {
    ERROR_PAGE
        .replace("__TITLE__", &escape_html(title))
        .replace("__MESSAGE__", &escape_html(message))
        .replace("__DETAIL__", &escape_html(detail))
}

/// 把 node 的 stderr 一直读到头，只留最后 STDERR_TAIL_LINES 行，启动失败时拿来给用户看。
///
/// 按字节读再宽松解码，不用 lines()：这根管道里不保证是 UTF-8（中文 Windows 上有的报错是 GBK），
/// lines() 碰到一个坏字节就停，之后没人读，管道一满 node 就卡在 console.error 上。
fn drain_stderr(source: impl Read, tail: &Mutex<VecDeque<String>>) {
    let mut reader = BufReader::new(source);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&raw);
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if let Ok(mut tail) = tail.lock() {
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line.to_string());
        }
    }
}

/// 管理服务没起来时错误页上的那段细节：优先原样给出 node 自己的报错，一行都没抓到才指向
/// start.js 写的那份日志。
fn startup_failure_detail(tail: &VecDeque<String>, log: &Path) -> String {
    if tail.is_empty() {
        return format!("node 没有留下任何输出，可以看看日志：{}", log.display());
    }
    tail.iter().map(String::as_str).collect::<Vec<_>>().join("\n")
}

/// 配置端口：settings.json 里的 port（设置页可改），读不到/不合法就用默认值。
static CONFIGURED_PORT: OnceLock<u16> = OnceLock::new();
/// 实际在用的端口：管理页在自己端口被别的程序占用时会往后顺延，扫到哪个用哪个。
static LIVE_PORT: OnceLock<u16> = OnceLock::new();

/// 外壳自己的日志（和服务的 manager.log 并排）。打包后是 GUI 进程，stderr 没人看得到，
/// 启动/运行环境这类早期失败只能落到文件里，否则用户只能看到一张错误页。
fn log_line(dir: &Path, message: &str) {
    use std::io::Write as _;
    let line = format!("[{}] {message}\n", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0));
    let _ = std::fs::create_dir_all(dir);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("launcher.log")) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// 每用户目录（和 platform.js 的 userAppDir 一致）：Windows 是 %APPDATA%\DSH，
/// macOS 是 ~/Library/Application Support/DSH。
fn user_app_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    base.map(|dir| dir.join(APP_DIR_NAME))
}

fn configured_port() -> u16 {
    *CONFIGURED_PORT.get_or_init(|| {
        let text = user_app_dir()
            .map(|dir| dir.join("settings.json"))
            .and_then(|file| std::fs::read_to_string(file).ok());
        text.and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|json| json.get("port").and_then(|value| value.as_u64()))
            .filter(|port| (1..=65535).contains(port))
            .map(|port| port as u16)
            .unwrap_or(DEFAULT_PORT)
    })
}

fn live_port() -> u16 {
    *LIVE_PORT.get().unwrap_or(&configured_port())
}

fn manager_url() -> String {
    format!("http://127.0.0.1:{}/", live_port())
}

fn manager_addr() -> String {
    format!("127.0.0.1:{}", live_port())
}

/// 端口上是不是我们自己的管理页——/api/ping 带身份标记，能区分自己的实例和别人的程序。
fn probe_manager(port: u16) -> bool {
    let Some(text) = http_get_with_timeout(
        &format!("127.0.0.1:{port}"),
        "/api/ping",
        PROBE_CONNECT_TIMEOUT,
        PROBE_IO_TIMEOUT,
    ) else {
        return false;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|json| json.get("app").and_then(|value| value.as_str()).map(|app| app == "dsh-x"))
        .unwrap_or(false)
}

/// 找在跑的管理页：配置端口被占时它会顺延，所以从配置端口开始往后扫。
fn find_manager() -> Option<u16> {
    find_manager_from(configured_port())
}

fn find_manager_from(first: u16) -> Option<u16> {
    if probe_manager(first) {
        return Some(first);
    }

    // 以前这里逐个扫 20 个端口。在部分 Windows 环境里，一个未监听端口会等约 2 秒，
    // 冷启动最坏因此要卡几十秒。配置端口先单独探测，剩余顺延端口同时查，并给整个扫描
    // 一个很短的总预算；已有实例仍能被唤醒，新实例则尽快继续创建窗口。
    let (sender, receiver) = mpsc::channel();
    let mut pending = 0usize;
    for offset in 1..PORT_SCAN {
        let Some(port) = first.checked_add(offset) else {
            break;
        };
        pending += 1;
        let sender = sender.clone();
        thread::spawn(move || {
            let _ = sender.send(probe_manager(port).then_some(port));
        });
    }
    drop(sender);

    let deadline = Instant::now() + PROBE_SCAN_BUDGET;
    while pending > 0 {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match receiver.recv_timeout(remaining) {
            Ok(Some(port)) => return Some(port),
            Ok(None) => pending -= 1,
            Err(_) => break,
        }
    }
    None
}

/// 等管理页的结果
#[derive(Debug, PartialEq)]
enum Startup {
    Ready(u16),
    /// node 没等到管理页起来就退出了，带着它的退出码（拿不到就是 None）
    Exited(Option<i32>),
    TimedOut,
}

/// 等管理页起来（启动到 listen 之间有一小段），并把实际端口定下来。
/// `node_exit` 由等 node 退出的那条线程填：node 一退就不用再等了，端口上不会再有人来 listen。
fn wait_for_manager(node_exit: &OnceLock<Option<i32>>) -> Startup {
    wait_for_manager_with(find_manager, node_exit)
}

fn wait_for_manager_with(find: impl Fn() -> Option<u16>, node_exit: &OnceLock<Option<i32>>) -> Startup {
    let deadline = Instant::now() + PORT_WAIT;
    loop {
        // 先看 node：它已经退了的话，端口上就算有管理页，也是另一个实例的
        if let Some(code) = node_exit.get() {
            return Startup::Exited(*code);
        }
        if let Some(port) = find() {
            let _ = LIVE_PORT.set(port);
            return Startup::Ready(port);
        }
        if Instant::now() >= deadline {
            return Startup::TimedOut;
        }
        thread::sleep(Duration::from_millis(250));
    }
}

/// 用系统默认程序打开链接。
///
/// 别用 `cmd /c start`：cmd 会把 URL 再解析一遍，里面的 `&` 就是语句分隔符，
/// 页面上任何一个链接（插件页面、更新日志）被构造成 `http://127.0.0.1:1/?&calc`
/// 就成了任意命令执行。这里直接调 ShellExecuteW——`start` 内部走的也是它，
/// 参数按 argv 原样传，中间没有 shell。
#[cfg(windows)]
fn open_in_browser(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

/// macOS：`open` 按 argv 收参数、不经过 shell，同样没有注入问题。
#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) {
    let _ = Command::new("/usr/bin/open").arg(url).spawn();
}

/// 把隐藏/最小化的窗口叫回前台。
fn show_window(window: &tao::window::Window) {
    // 被 ─ 收到任务栏/程序坞的窗口，光 set_visible + set_focus 拉不回来
    window.set_minimized(false);
    window.set_visible(true);
    window.set_focus();
}

/// macOS 的应用菜单。没有它 ⌘Q/⌘W/⌘C/⌘V 全都不灵（WKWebView 的复制粘贴靠菜单里的
/// 标准动作派发），而无边框窗口又拿不到系统菜单。「退出」不用系统预设项：那会直接结束进程、
/// 绕过 node 的收尾，所以换成自己的项、走和托盘同一条 /api/quit。
#[cfg(target_os = "macos")]
fn build_app_menu() -> Menu {
    use tray_icon::menu::accelerator::{Accelerator, Code, Modifiers};
    use tray_icon::menu::Submenu;
    let quit = MenuItem::with_id(ITEM_QUIT, "Quit DSH-X", true, Some(Accelerator::new(Modifiers::META, Code::KeyQ)));
    let close = MenuItem::with_id(ITEM_CLOSE_WINDOW, "Close Window", true, Some(Accelerator::new(Modifiers::META, Code::KeyW)));
    let app = Submenu::with_items(
        "DSH-X",
        true,
        &[
            &PredefinedMenuItem::about(None, None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::show_all(None),
            &PredefinedMenuItem::separator(),
            &quit,
        ],
    );
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    );
    let window = Submenu::with_items(
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(None), &PredefinedMenuItem::fullscreen(None), &close],
    );
    let menu = Menu::new();
    for submenu in [app, edit, window].into_iter().flatten() {
        let _ = menu.append(&submenu);
    }
    menu
}

/// 极简 HTTP GET，只用来问本机管理服务一个短路径；读完整响应取正文即可。
fn http_get_with_timeout(
    addr: &str,
    path: &str,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> Option<String> {
    let socket: SocketAddr = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&socket, connect_timeout).ok()?;
    stream.set_read_timeout(Some(io_timeout)).ok()?;
    stream.set_write_timeout(Some(io_timeout)).ok()?;
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes())
        .ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    Some(
        raw.split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or_default()
            .trim()
            .to_string(),
    )
}

fn http_get(addr: &str, path: &str) -> Option<String> {
    http_get_with_timeout(
        addr,
        path,
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
}

/// 同样极简的 POST，用来让本机管理服务执行托盘菜单的动作；正文固定给个空 JSON。
fn http_post(addr: &str, path: &str) -> Option<String> {
    http_post_json(addr, path, "{}", Duration::from_secs(2))
}

fn http_post_json(addr: &str, path: &str, body: &str, timeout: Duration) -> Option<String> {
    let socket: SocketAddr = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let length = body.len();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(body.as_bytes()).ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    Some(raw)
}

fn tray_response_error(raw: &str) -> Option<String> {
    let Some((head, body)) = raw.split_once("\r\n\r\n") else { return Some("Invalid DSH-X response / 启动器响应无效".into()); };
    if head.lines().next().and_then(|line| line.split_whitespace().nth(1)) == Some("200") { return None; }
    Some(serde_json::from_str::<Value>(body).ok().and_then(|value| value.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "Tray action failed / 托盘操作失败，请查看日志".into()))
}

fn request_tray_action(body: Value, proxy: EventLoopProxy<UserEvent>, en: bool) {
    // 启动与修复可能较慢，后台请求不能卡住窗口和其他启动项的菜单。
    thread::spawn(move || {
        let result = http_post_json(&manager_addr(), "/api/tray/action", &body.to_string(), Duration::from_secs(120));
        let error = match result {
            Some(raw) => tray_response_error(&raw),
            None => Some(if en { "Unable to reach DSH-X. Check the logs." } else { "无法连接启动器，请查看日志" }.into()),
        };
        if let Some(error) = error { let _ = proxy.send_event(UserEvent::TrayError(error)); }
    });
}

/// 把 dsh.ico 解成 RGBA。ico 里 256 那帧是 PNG、小帧是 BMP，交给 image 统一处理。
fn decode_ico(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Ico).ok()?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    Some((rgba.into_raw(), width, height))
}

/// 窗口图标。exe 里内嵌的是同一张图，但 tao 不会自动取用，得自己解出来给它。
fn load_window_icon(root: &Path) -> Option<tao::window::Icon> {
    let bytes = std::fs::read(root.join("assets").join("dsh.ico")).ok()?;
    let (rgba, width, height) = decode_ico(&bytes)?;
    tao::window::Icon::from_rgba(rgba, width, height).ok()
}

/// 启动器文件（start.js、assets/…）所在的目录。
/// Windows 就是 exe 旁边；macOS 是包里的 Contents/Resources/app（可执行文件在 Contents/MacOS）。
fn app_root(exe: &Path) -> PathBuf {
    // 源码开发与冒烟测试：直接指到仓库根，不用先打一个安装包（打包后的安装目录不会设这个变量）。
    // 只认带 start.js 的目录，免得环境变量指歪了把外壳带到空目录去。
    if let Some(root) = std::env::var_os("DSH_APP_ROOT") {
        let root = PathBuf::from(root);
        if root.join("start.js").is_file() {
            return root;
        }
    }
    let dir = exe.parent().expect("install dir");
    // 安装布局：启动器自己的代码在 resources/app 下（Windows：<安装根>/resources/app；
    // macOS：<X>.app/Contents/Resources/app）。外壳在安装根 / Contents/MacOS，和 app 层分行。
    let windows_layout = dir.join("resources").join("app");
    if windows_layout.join("start.js").is_file() {
        return windows_layout;
    }
    #[cfg(target_os = "macos")]
    {
        let bundled = dir.parent().map(|contents| contents.join("Resources").join("app"));
        if let Some(bundled) = bundled.filter(|path| path.join("start.js").is_file()) {
            return bundled;
        }
    }
    // 源码开发：二进制在 launcher/target/<profile>/ 下，往上找到带 start.js 和 launcher/ 的
    // 仓库根。只认这两个标记，免得在别处误判。
    let mut probe = dir;
    for _ in 0..6 {
        if probe.join("start.js").is_file() && probe.join("launcher").is_dir() {
            return probe.to_path_buf();
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    dir.to_path_buf()
}

/// 管理页 webview 铺满整个窗口（页面自己让出红绿灯那块）。
fn webview_bounds(window: &Window) -> Rect {
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    Rect {
        position: LogicalPosition::new(0.0, 0.0).into(),
        size: LogicalSize::new(size.width, size.height).into(),
    }
}

/// 最小化或藏到托盘时让 WebView 主动收缩内存；只有状态变化时才调用，不跟着轮询反复调。
fn set_memory_active(view: &WebView, active: bool) {
    #[cfg(target_os = "windows")]
    {
        use wry::{MemoryUsageLevel, WebViewExtWindows};
        // WebView2 的 Low 模式仍执行脚本、保留 WebSocket 和草稿；旧运行时不支持时安静回退。
        let _ = view.set_memory_usage_level(if active { MemoryUsageLevel::Normal } else { MemoryUsageLevel::Low });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (view, active);
}

/// 让 Electron 在标签窗口里开一个实例。
///
/// Electron 还没装时退回系统浏览器：设置页在选「内部标签页」时会让用户先下载运行环境，
/// 这里是兜底——比如用户在托盘菜单里直接点了「打开」，不该什么都不发生。
fn open_electron_tab(root: &Path, target: &Instance) {
    let Some(dist) = user_app_dir().and_then(|dir| runtime::electron_runtime(&dir)) else {
        open_in_browser(&target.url);
        return;
    };
    let args = vec![
        "--tab".to_string(),
        target.url.clone(),
        "--title".to_string(),
        target.title.clone(),
    ];
    if runtime::launch_electron(&dist, root, &args, &manager_url()).is_err() {
        open_in_browser(&target.url);
    }
}

/// 让 Electron 开独立窗口（设置里的「独立桌面窗口」）。
fn open_electron_window(root: &Path, url: &str) {
    let Some(dist) = user_app_dir().and_then(|dir| runtime::electron_runtime(&dir)) else {
        open_in_browser(url);
        return;
    };
    let args = vec!["--window".to_string(), url.to_string()];
    if runtime::launch_electron(&dist, root, &args, &manager_url()).is_err() {
        open_in_browser(url);
    }
}

/// 页面里点出来的链接：管理页自己 → 叫回窗口；属于某个 dsh 实例 → 按打开方式进标签窗口 /
/// 独立窗口；其余 http(s) 交给系统浏览器。data:/blob: 不是能给系统打开的地址，宁可不理。
fn route_link(state: &TrayState, root: &Path, url: &str, proxy: &EventLoopProxy<UserEvent>) {
    if same_origin(url, &manager_url()) {
        let _ = proxy.send_event(UserEvent::Show);
        return;
    }
    let own = state.instances.iter().find(|target| !target.url.is_empty() && same_origin(url, &target.url));
    if state.internal_mode() {
        if let Some(target) = own {
            let target = target.clone();
            let root = root.to_path_buf();
            // 拉起 Electron 可能慢一点（首次要读很多文件），别卡住窗口线程
            thread::spawn(move || open_electron_tab(&root, &target));
            return;
        }
    } else if state.window_mode() {
        if let Some(target) = own {
            // 本机链接可能没有 token，使用这个实例自己的完整认证地址
            let target = target.url.clone();
            let root = root.to_path_buf();
            thread::spawn(move || open_electron_window(&root, &target));
            return;
        }
    }
    if is_web_url(url) {
        open_in_browser(url);
    }
}

/// 后台把服务拉起来：先确保 Node 运行时，再用它跑 start.js，最后等管理页的端口。
///
/// 整段都在线程里做：下载可能几十秒，WebView2 的初始化要在这段时间里并行完成。
fn boot(root: PathBuf, forwarded: Vec<String>, proxy: EventLoopProxy<UserEvent>) {
    let app_dir = user_app_dir().unwrap_or_else(|| root.join("data"));
    log_line(&app_dir, &format!("启动：app 目录 {}，用户目录 {}", root.display(), app_dir.display()));
    let node = match runtime::ensure_node(&app_dir, &root, |progress| {
        let _ = proxy.send_event(UserEvent::Boot(progress));
    }) {
        Ok(node) => node,
        Err(error) => {
            let _ = proxy.send_event(UserEvent::BootFailed(error));
            return;
        }
    };
    let script = root.join("start.js");
    log_line(&app_dir, &format!("使用 node：{}", node.display()));

    // 从 Finder / 程序坞打开的 macOS 应用只拿到 launchd 的精简 PATH（/usr/bin:/bin:…），
    // 用户 shell 里配的 Homebrew 等目录都不在；插件的构建脚本会用到 git 之类，这里补上常见位置。
    let mut dirs = vec![node.parent().unwrap_or(Path::new(".")).to_path_buf()];
    if let Some(old) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&old));
    }
    #[cfg(target_os = "macos")]
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let extra = PathBuf::from(extra);
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    let path = std::env::join_paths(dirs).ok();

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .args(&forwarded)
        .current_dir(&root)
        // 告诉 start.js：管理页由本进程的窗口承载，别再自己开浏览器
        .env("DSH_APP_WINDOW", "1")
        // 服务与 dsh 子进程都用这份下载来的 node（platform.js 的 RUNTIME_NODE 认它）
        .env("DSH_RUNTIME_NODE", &node)
        // 外壳本身永远能开标签窗口（Electron 没装时它会退回浏览器）：能力与「运行时装没装」
        // 是两件事，后者由服务端按数据目录里有没有 .ready 判断，这样用户中途下载完不用重启。
        .env("DSH_INTERNAL_TABS", "1")
        .stdout(Stdio::piped())
        // stderr 也接过来：从桌面启动时没有终端，继承下去的话 node 启动失败时说了什么就没人看得到
        .stderr(Stdio::piped());
    if let Some(path) = &path {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            log_line(&app_dir, &format!("拉起 node 失败：{error}"));
            let _ = proxy.send_event(UserEvent::BootFailed(format!(
                "启动器没能把 node 拉起来：{error}"
            )));
            return;
        }
    };

    let node_out = child.stdout.take();

    // node 的报错留个尾巴。这条线程要一直读到 node 退出：没人读的话管道会写满
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_reader = child.stderr.take().map(|err| {
        let tail = Arc::clone(&stderr_tail);
        thread::spawn(move || drain_stderr(err, &tail))
    });

    // node 退出（含托盘退出）就收摊，窗口跟着关。管理服务还没起来时退出不算「正常退出」：
    // 那种情况由下面 wait_for_manager 报错误页，别让这个事件把窗口提前关掉。
    let node_exit = Arc::new(OnceLock::new());
    let ready = Arc::new(AtomicBool::new(false));
    {
        let proxy = proxy.clone();
        let node_exit = Arc::clone(&node_exit);
        let ready = Arc::clone(&ready);
        thread::spawn(move || {
            let status = child.wait();
            // 进程没了不等于管道读完了：等一下读 stderr 的线程，把最后几行收齐再报退出。
            // 不死等——万一还有别的进程攥着这根管道，它永远读不到头
            if let Some(reader) = stderr_reader {
                let deadline = Instant::now() + STDERR_FLUSH_WAIT;
                while !reader.is_finished() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
            }
            let _ = node_exit.set(status.ok().and_then(|status| status.code()));
            if ready.load(Ordering::SeqCst) {
                let _ = proxy.send_event(UserEvent::Exited);
            }
        });
    }

    // node 说「把窗口叫出来」/「开独立窗口」/「开标签页」时，读的就是这几行约定标记
    if let Some(out) = node_out {
        let proxy = proxy.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if line.trim() == SHOW_SIGNAL {
                    let _ = proxy.send_event(UserEvent::Show);
                    continue;
                }
                if let Some(url) = parse_open_signal(&line) {
                    let _ = proxy.send_event(UserEvent::OpenWindow(url));
                    continue;
                }
                if let Some(target) = parse_tab_signal(&line) {
                    let _ = proxy.send_event(UserEvent::OpenTab(target));
                }
            }
        });
    }

    match wait_for_manager(&node_exit) {
        // 端口上是自己的另一个实例：start.js 叫醒它之后特意退 0（见它的 EALREADY 分支），
        // 这不是故障，跟着安静收摊
        Startup::Exited(Some(0)) => {
            log_line(&app_dir, "另一个实例在跑，叫醒它之后安静退出");
            let _ = proxy.send_event(UserEvent::Exit);
            return;
        }
        Startup::Exited(code) => {
            let code = code.map_or_else(|| "未知".to_string(), |code| code.to_string());
            let log = app_dir.join("manager.log");
            let tail = stderr_tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let detail = startup_failure_detail(&tail, &log);
            log_line(&app_dir, &format!("管理服务启动失败：退出码 {code}；{detail}"));
            let _ = proxy.send_event(UserEvent::BootFailed(format!(
                "node 没等管理页起来就退出了（退出码 {code}）。\n{detail}"
            )));
            return;
        }
        Startup::Ready(_) | Startup::TimedOut => {}
    }

    ready.store(true, Ordering::SeqCst);
    log_line(&app_dir, &format!("管理服务就绪：{}", manager_url()));

    // 每 1.5 秒问一次状态，用来更新托盘菜单的文案和可用项
    {
        let proxy = proxy.clone();
        thread::spawn(move || loop {
            let state = http_get(&manager_addr(), "/api/tray")
                .map(|text| parse_tray_state(&text))
                .unwrap_or_default();
            if proxy.send_event(UserEvent::Tray(state)).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(1500));
        });
    }

    let _ = proxy.send_event(UserEvent::BootReady);
}

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    let root = app_root(&exe);

    // 用户在 DSH.exe 上带的参数：原样转给 start.js（server.js 会把它们拼到 dsh
    // 命令行末尾），不再静默忽略。开头那个不带 `-` 的是 dsh 式调用里的 profile 名
    // （`DSH.exe web --host …`），启动 profile 由设置页决定，这里把它丢掉，只透传
    // flag。唤醒已有实例的那条路上参数会随本进程退出作废——那个实例已经在跑了。
    let mut forwarded: Vec<String> = std::env::args().skip(1).collect();
    if let Some(first) = forwarded.first() {
        if !first.starts_with('-') {
            forwarded.remove(0);
        }
    }

    // 已经有实例在跑就别再走后面那一套了。否则会先建出一个窗口、再拉一次 node 和
    // WebView2，等发现端口被占才收摊——用户看到的就是一个多余的窗口闪一下。
    // 直接让那个实例把窗口叫出来就完事（它的 node 收到 /api/wake 会回信号给我们）。
    if let Some(port) = find_manager() {
        let _ = LIVE_PORT.set(port);
        let _ = http_post(&manager_addr(), "/api/wake");
        std::process::exit(0);
    }

    let mut builder = EventLoopBuilder::<UserEvent>::with_user_event();
    let event_loop = builder.build();
    let proxy = event_loop.create_proxy();

    // WebView2 的初始化是启动里最贵的一段，放在后台拉服务之前做，两者就能并行。
    // 建不出来（WebView2 缺失等）就降级成「只有托盘、没有窗口」，浏览器顶上管理页，
    // 绝不能在 node 已经在跑的时候直接退出——那会留下没人管的进程。
    let data_dir = user_app_dir().unwrap_or_else(|| root.join("data")).join("webview");
    let _ = std::fs::create_dir_all(&data_dir);
    let mut context = WebContext::new(Some(data_dir));

    // 无边框窗口拿不到系统给的默认摆位，不指定的话会落在系统的层叠位置上；首次出现摆在主屏正中
    let centered = event_loop.primary_monitor().map(|monitor| {
        let screen = monitor.size();
        let area = LogicalSize::new(WINDOW_W, WINDOW_H).to_physical::<u32>(monitor.scale_factor());
        PhysicalPosition::new(
            monitor.position().x + (screen.width as i32 - area.width as i32) / 2,
            monitor.position().y + (screen.height as i32 - area.height as i32) / 2,
        )
    });

    let window_builder = WindowBuilder::new()
        .with_title("DSH-X")
        .with_window_icon(load_window_icon(&root))
        .with_inner_size(LogicalSize::new(WINDOW_W, WINDOW_H))
        .with_min_inner_size(LogicalSize::new(WINDOW_MIN_W, WINDOW_MIN_H));
    // 不要原生标题栏：图标、标题、三个按钮都由页面自己画，风格才统一
    #[cfg(windows)]
    let mut window_builder = window_builder.with_decorations(false);
    // macOS 反过来留着系统红绿灯（用户对它们的肌肉记忆比风格统一更重要），只把标题栏做透明、
    // 让页面铺满整个窗口，红绿灯挪到和页面顶栏对齐的位置
    #[cfg(target_os = "macos")]
    let mut window_builder = {
        use tao::platform::macos::WindowBuilderExtMacOS;
        window_builder
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true)
            .with_traffic_light_inset(LogicalPosition::new(TRAFFIC_LIGHT_INSET.0, TRAFFIC_LIGHT_INSET.1))
    };
    if let Some(position) = centered {
        window_builder = window_builder.with_position(position);
    }
    let window = match window_builder
        .build(&event_loop)
    {
        Ok(window) => Some(window),
        Err(error) => {
            // 建不出窗口，就没有能显示我们自己界面的地方了，只能退回系统浏览器——
            // 至少管理页本身还能用，托盘也照常工作
            eprintln!("窗口创建失败，已改用浏览器打开：{error}");
            open_in_browser(&manager_url());
            None
        }
    };

    // 页面的窗口操作走 IPC 转成事件，窗口本身留在事件循环里操作，避免到处共享所有权
    let ipc_proxy = proxy.clone();
    let link_proxy = proxy.clone();
    let nav_proxy = proxy.clone();
    let webview = match &window {
        Some(window) => match WebViewBuilder::new_with_web_context(&mut context)
            .with_url("about:blank")
            .with_bounds(webview_bounds(window))
            .with_ipc_handler(move |request| {
                let event = match request.body().as_str() {
                    "minimize" => UserEvent::Minimize,
                    "maximize" => UserEvent::ToggleMaximize,
                    "close" => UserEvent::Hide,
                    "drag" => UserEvent::Drag,
                    "quit" => UserEvent::Quit,
                    _ => return,
                };
                let _ = ipc_proxy.send_event(event);
            })
            // 外部链接（Star、运行地址、更新日志）原来一律交给系统浏览器。现在先问一遍
            // 事件循环：选了内部标签页 / 桌面窗口时，那个「运行地址」要进外壳而不是浏览器；
            // 其余（Star、更新日志等）照样交给系统浏览器。wry 在没设这个处理器时会把
            // target="_blank" 直接取消，点了就像没反应。
            .with_new_window_req_handler(move |url, _features| {
                let _ = link_proxy.send_event(UserEvent::OpenExternal(url));
                wry::NewWindowResponse::Deny
            })
            // 就地导航（页面里 location.href 那种兜底）会把窗口导走，连自定义标题栏
            // 一起弄丢，所以只放行管理页自己与本地页（准备页/错误页都是 data: 导航）；
            // 其余交给事件循环去分派（真正的外部网页会落到系统浏览器）。
            .with_navigation_handler(move |url| {
                if url == "about:blank" || url.starts_with("data:") || url.starts_with(&manager_url()) {
                    return true;
                }
                if is_web_url(&url) {
                    let _ = nav_proxy.send_event(UserEvent::OpenExternal(url));
                }
                false
            })
            .build_as_child(window)
        {
            Ok(webview) => Some(webview),
            Err(error) => {
                eprintln!("窗口创建失败，已改用浏览器打开：{error}");
                open_in_browser(&manager_url());
                None
            }
        },
        None => None,
    };

    // 管理页的渲染进程崩溃/卡死时 WebView2 不会自己恢复：窗口停在最后一帧，合成器却继续按帧
    // 工作，CPU/内存一路涨（issue 现场：两个进程挂六天、各 4.5 万 CPU 秒、占掉 1GB）。
    // 这里只订阅，重载放在事件循环里做——COM 回调里导航会踩重入限制。
    if let Some(view) = &webview {
        let proxy = proxy.clone();
        health::watch(view, move |failure| { let _ = proxy.send_event(UserEvent::ManagerFailed(failure)); });
    }

    // 托盘建在主线程：它的消息要靠下面这个事件循环的消息泵派发
    let mut tray = build_tray(&root);
    let mut state = TrayState::default();

    // macOS 的菜单栏菜单也得在事件循环跑起来之前挂上；句柄要一直留着，否则菜单项跟着失效
    #[cfg(target_os = "macos")]
    let app_menu = {
        let menu = build_app_menu();
        menu.init_for_nsapp();
        menu
    };

    // 运行环境与管理服务都在后台线程里准备；准备好之前窗口先显示「正在准备」那张页。
    {
        let root = root.clone();
        let forwarded = forwarded.clone();
        let proxy = proxy.clone();
        thread::spawn(move || boot(root, forwarded, proxy));
    }

    let mut manager_loaded = false;
    let mut service_failed = false;
    let mut manager_memory_active = true;
    // 管理页上次自动恢复的时间：崩溃循环里不能无限重载。
    let mut manager_reloaded_at: Option<Instant> = None;

    // webview 与 context 都是本帧的局部变量，run 不返回，所以它们的生命周期覆盖整个窗口期
    event_loop.run(move |event, _event_loop, control_flow| {
        #[cfg(target_os = "macos")]
        let _ = &app_menu;
        // Windows：左键点托盘＝打开启动器界面（菜单已经改成只在右键弹）。macOS 的左键是出菜单。
        while let Ok(tray_event) = TrayIconEvent::receiver().try_recv() {
            if cfg!(target_os = "macos") {
                continue;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = tray_event
            {
                match &window {
                    Some(window) => show_window(window),
                    None => open_in_browser(&manager_url()),
                }
            }
        }
        // 菜单事件走 muda 的全局 channel；托盘和窗口同在这条线程上，直接收
        while let Ok(menu_event) = MenuEvent::receiver().try_recv() {
            match menu_event.id().as_ref() {
                ITEM_MANAGER => match &window { Some(window) => show_window(window), None => open_in_browser(&manager_url()) },
                ITEM_QUIT => {
                    // 让 node 自己收尾（停掉 dsh、通知开着的页面），它一退我们跟着收摊
                    let _ = http_post(&manager_addr(), "/api/quit");
                }
                #[cfg(target_os = "macos")]
                ITEM_CLOSE_WINDOW => {
                    if let Some(window) = &window {
                        window.set_visible(false);
                    }
                }
                id => {
                    if let Some(body) = tray.as_ref().and_then(|tray| tray.launches.request(id)) {
                        request_tray_action(body, proxy.clone(), state.lang == "en");
                    }
                }
            }
        }
        // 菜单事件不会唤醒事件循环，所以按小步长醒着轮询
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(80));
        match event {
            // 窗口一出来先挂上「正在准备」那张页：运行环境可能还在下载，不能空等
            Event::NewEvents(tao::event::StartCause::Init) if !manager_loaded => {
                if let Some(webview) = &webview {
                    let _ = webview.load_html(PREPARING_PAGE);
                }
            }
            Event::UserEvent(UserEvent::Boot(progress)) => {
                if let Some(webview) = &webview {
                    let payload = serde_json::json!({
                        "phase": progress.phase,
                        "done": progress.done,
                        "total": progress.total,
                        "message": progress.message,
                    });
                    let _ = webview.evaluate_script(&format!("window.bootProgress({payload})"));
                }
            }
            Event::UserEvent(UserEvent::BootReady) => {
                manager_loaded = true;
                match &webview {
                    // 直接加载，不问服务端：window 参数是个常量，绕一趟 HTTP 只会拖慢启动
                    Some(webview) => {
                        let _ = webview.load_url(&format!("{}?window={WINDOW_QUERY}", manager_url()));
                    }
                    None => open_in_browser(&manager_url()),
                }
            }
            Event::UserEvent(UserEvent::BootFailed(detail)) => {
                service_failed = true;
                match &webview {
                    Some(webview) => {
                        let _ = webview.load_html(&error_page("启动失败 / Startup failed", "DSH-X 没能把管理服务拉起来。", &detail));
                    }
                    None => {
                        eprintln!("{detail}");
                        *control_flow = ControlFlow::ExitWithCode(1);
                    }
                }
            }
            Event::UserEvent(UserEvent::Exit) => *control_flow = ControlFlow::ExitWithCode(0),
            Event::UserEvent(UserEvent::Quit) => *control_flow = ControlFlow::ExitWithCode(1),
            Event::UserEvent(UserEvent::Show) => {
                if let Some(window) = &window {
                    show_window(window);
                }
            }
            Event::UserEvent(UserEvent::TrayError(error)) => {
                if let Some(window) = &window { show_window(window); }
                if let Some(manager) = &webview {
                    let message = serde_json::to_string(&error).unwrap_or_default();
                    let _ = manager.evaluate_script(&format!("notify({message})"));
                }
            }
            // node 的标记行：开独立窗口 / 标签页
            Event::UserEvent(UserEvent::OpenWindow(url)) => {
                let root = root.clone();
                let manager = manager_url();
                thread::spawn(move || {
                    let Some(dist) = user_app_dir().and_then(|dir| runtime::electron_runtime(&dir)) else {
                        open_in_browser(&url);
                        return;
                    };
                    let args = vec!["--window".to_string(), url.clone()];
                    if runtime::launch_electron(&dist, &root, &args, &manager).is_err() {
                        open_in_browser(&url);
                    }
                });
            }
            Event::UserEvent(UserEvent::OpenTab(target)) => {
                let root = root.clone();
                thread::spawn(move || open_electron_tab(&root, &target));
            }
            // 页面里点出来的链接：交给 route_link 按打开方式分派
            Event::UserEvent(UserEvent::OpenExternal(url)) => {
                route_link(&state, &root, &url, &proxy);
            }
            // macOS：窗口藏起来之后点程序坞图标，系统发的就是这个
            Event::Reopen { .. } => match &window {
                Some(window) => show_window(window),
                None => open_in_browser(&manager_url()),
            },
            // macOS 上系统也能直接结束我们（程序坞右键「退出」、注销关机），这时 node 还活着、
            // 占着端口；同步让它收尾，否则下次打开会撞上一个没有窗口的旧实例。
            // node 已经先退的正常路径上这一步连接被拒，立刻返回。
            #[cfg(target_os = "macos")]
            Event::LoopDestroyed => {
                let _ = http_post(&manager_addr(), "/api/quit");
            }
            Event::UserEvent(UserEvent::Exited) => *control_flow = ControlFlow::ExitWithCode(0),
            Event::UserEvent(UserEvent::ManagerFailed(failure)) => {
                // 重载而不是 reload：渲染进程已经没了/卡住时 reload 可能落空，重新导航一定带回页面。
                let now = Instant::now();
                if !should_recover(manager_reloaded_at, now) {
                    eprintln!("管理页渲染进程再次{}，60 秒内已恢复过，先不重复重载", failure_text(failure));
                } else {
                    manager_reloaded_at = Some(now);
                    eprintln!("管理页渲染进程{}，正在重新加载", failure_text(failure));
                    if let Some(webview) = &webview {
                        let _ = webview.load_url(&format!("{}?window={WINDOW_QUERY}", manager_url()));
                    }
                }
            }
            Event::UserEvent(UserEvent::Tray(next)) => {
                state = next;
                if let Some(tray) = &mut tray {
                    tray.sync(&state);
                }
                // 管理页里那条「打开 DSH」的链接要靠这些状态判断，页面自己会轮询；这里只留托盘。
            }
            Event::UserEvent(UserEvent::Minimize) => {
                if let Some(window) = &window {
                    window.set_minimized(true);
                }
            }
            Event::UserEvent(UserEvent::ToggleMaximize) => {
                if let Some(window) = &window {
                    window.set_maximized(!window.is_maximized());
                }
            }
            Event::UserEvent(UserEvent::Hide) => {
                if let Some(window) = &window {
                    window.set_visible(false);
                }
            }
            Event::UserEvent(UserEvent::Drag) => {
                if let Some(window) = &window {
                    let _ = window.drag_window();
                }
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. },
                window_id,
                ..
            } => {
                if let (Some(window), Some(manager)) = (&window, &webview) {
                    if window.id() == window_id {
                        let _ = manager.set_bounds(webview_bounds(window));
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                window_id,
                ..
            } => {
                if let Some(manager) = &window {
                    if manager.id() == window_id {
                        // 关窗口不退出：托盘还在、dsh 照常跑，需要时从托盘再叫回来。
                        // 但启动失败时窗口里只有一张错误页，留着托盘没有意义，直接退。
                        if service_failed {
                            *control_flow = ControlFlow::ExitWithCode(1);
                        } else {
                            manager.set_visible(false);
                        }
                    }
                }
            }
            _ => {}
        }
        // 最小化或留在托盘时让浏览器主动收缩内存；状态只在变化时应用，不跟轮询反复调用。
        if let (Some(window), Some(view)) = (&window, &webview) {
            let active = window.is_visible() && !window.is_minimized();
            if active != manager_memory_active {
                set_memory_active(view, active);
                manager_memory_active = active;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn decodes_the_icon_at_full_size() {
        let bytes = std::fs::read("../assets/dsh.ico").expect("read assets/dsh.ico");
        let (rgba, width, height) = decode_ico(&bytes).expect("decode ico");
        println!("icon decoded {width}x{height}, {} bytes", rgba.len());
        assert_eq!(rgba.len() as u32, width * height * 4, "RGBA buffer size");
        // image 该挑最大那帧；挑到 16x16 标题栏图标就糊了
        assert!(width >= 256 && height >= 256, "expected the 256 frame, got {width}x{height}");
    }

    #[test]
    fn missing_icon_is_not_fatal() {
        assert!(load_window_icon(Path::new("does-not-exist")).is_none());
    }

    #[test]
    fn finds_a_manager_on_a_shifted_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake manager");
        let port = listener.local_addr().expect("fake manager address").port();
        assert!(port > 1, "ephemeral port should have a previous port");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept launcher probe");
            let mut request = [0u8; 512];
            let _ = stream.read(&mut request);
            let body = r#"{"app":"dsh-x"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).expect("reply to launcher probe");
        });

        assert_eq!(find_manager_from(port - 1), Some(port));
    }

    #[test]
    fn stops_waiting_once_node_has_exited() {
        // node 启动失败退出后，不该再把 PORT_WAIT 等满
        let node_exit = Arc::new(OnceLock::new());
        {
            let node_exit = Arc::clone(&node_exit);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(300));
                let _ = node_exit.set(Some(1));
            });
        }
        let started = Instant::now();
        assert_eq!(wait_for_manager_with(|| None, &node_exit), Startup::Exited(Some(1)));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "kept waiting for {:?} after node exited",
            started.elapsed()
        );
    }

    #[test]
    fn a_dead_node_wins_over_a_manager_on_the_port() {
        // 第二个实例：端口上答话的是另一个实例的管理页，自己的 node 已经退 0，
        // 不能把那个端口当成自己的
        let node_exit = OnceLock::new();
        let _ = node_exit.set(Some(0));
        assert_eq!(wait_for_manager_with(|| Some(DEFAULT_PORT), &node_exit), Startup::Exited(Some(0)));
    }

    #[test]
    fn stderr_tail_keeps_only_the_last_lines() {
        let output: String = (0..STDERR_TAIL_LINES + 5).map(|index| format!("line {index}\r\n")).collect();
        let tail = Mutex::new(VecDeque::new());
        drain_stderr(output.as_bytes(), &tail);
        let tail = tail.into_inner().expect("tail");
        assert_eq!(tail.len(), STDERR_TAIL_LINES);
        assert_eq!(tail.front().map(String::as_str), Some("line 5"));
        assert_eq!(tail.back(), Some(&format!("line {}", STDERR_TAIL_LINES + 4)));
    }

    #[test]
    fn stderr_tail_survives_bytes_that_are_not_utf8() {
        // 「端口」的 GBK 编码夹在中间：读的线程不能就此停下，后面的行还得收到
        let mut output = b"first\n".to_vec();
        output.extend_from_slice(&[0xB6, 0xCB, 0xBF, 0xDA, b'\n']);
        output.extend_from_slice(b"\nError: listen EADDRINUSE\n    at <anonymous>");
        let tail = Mutex::new(VecDeque::new());
        drain_stderr(output.as_slice(), &tail);
        let tail = tail.into_inner().expect("tail");
        assert_eq!(tail.len(), 4, "blank lines are skipped: {tail:?}");
        assert_eq!(tail[0], "first");
        assert_eq!(tail[2], "Error: listen EADDRINUSE");
        assert_eq!(tail[3], "    at <anonymous>");
    }

    #[test]
    fn startup_failure_detail_prefers_what_node_said() {
        let log = Path::new("DSH").join("manager.log");
        let tail = VecDeque::from(["Error: boom".to_string(), "    at <anonymous>".to_string()]);
        let detail = startup_failure_detail(&tail, &log);
        assert_eq!(detail, "Error: boom\n    at <anonymous>");
        // node 的堆栈里有尖括号，进页面前得转义掉
        assert!(error_page("t", "m", &detail).contains("at &lt;anonymous&gt;"));
        assert!(startup_failure_detail(&VecDeque::new(), &log).contains("manager.log"));
    }

    #[test]
    fn empty_port_scan_stays_within_the_startup_budget() {
        // 这段端口在本机防火墙下逐个 TcpStream::connect 约等 2 秒。旧实现扫描 20 个
        // 最坏会卡几十秒；并行短超时实现即使机器繁忙也应远低于这个数量级。
        let started = Instant::now();
        assert_eq!(find_manager_from(48_761), None);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "empty scan took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn parses_the_open_signal_line() {
        let state = parse_tray_state("status=running\nurl=http://127.0.0.1:9716/?token=abc");
        assert_eq!(state.url, "http://127.0.0.1:9716/?token=abc");
        assert_eq!(
            parse_open_signal("__DSH_OPEN__ http://127.0.0.1:9716/?token=abc").as_deref(),
            Some("http://127.0.0.1:9716/?token=abc"),
        );
        // 叫窗口那行不能被当成打开地址；空地址也不行（那是「别开窗口」的意思）
        assert_eq!(parse_open_signal("__DSH_SHOW__"), None);
        assert_eq!(parse_open_signal("__DSH_OPEN__   "), None);
        assert_eq!(parse_open_signal("dsh web: http://127.0.0.1:9716/"), None);
    }

    #[test]
    fn parses_the_tab_signal_line() {
        let target = parse_tab_signal(
            r#"__DSH_TAB__ {"id":"web@1","title":"web · 1","url":"http://127.0.0.1:1234/?token=abc&x=2"}"#,
        )
        .expect("tab target");
        assert_eq!(target.title, "web · 1");
        assert!(target.url.ends_with("token=abc&x=2"));
        // 外站链接不进标签页；坏 JSON 也不能当成标记
        assert!(parse_tab_signal(r#"__DSH_TAB__ {"id":"x","url":"https://example.com/"}"#).is_none());
        assert!(parse_tab_signal("__DSH_TAB__ invalid").is_none());
        assert!(parse_tab_signal("__DSH_TAB__   ").is_none());
    }

    #[test]
    fn tray_state_carries_the_open_mode() {
        let window = parse_tray_state("status=running\nurl=http://127.0.0.1:9716/?token=x\nopenmode=window\nshell=1\nlang=en");
        assert!(window.window_mode(), "选了窗口且有外壳时才开 Electron 窗口");
        assert_eq!(window.lang, "en");
        // 源码运行（没有原生外壳）时窗口模式不成立：托盘要照旧交给系统浏览器
        assert!(!parse_tray_state("openmode=window\nshell=0").window_mode());
        assert!(!parse_tray_state("openmode=tab\nshell=1").window_mode());
        // 老版本 node 不给这两行：默认走浏览器，行为不变
        assert!(!parse_tray_state("status=running\nurl=http://127.0.0.1:9716/").window_mode());
        let internal = parse_tray_state("openmode=internal\nshell=1\ntheme=dark\ninstances=[{\"id\":\"web@1\",\"title\":\"web · 1\",\"url\":\"http://127.0.0.1:1234/?token=x\"},{\"id\":\"other@1\",\"url\":\"http://127.0.0.1:2345/?token=y\"}]");
        assert!(internal.internal_mode());
        assert_eq!(internal.theme, "dark");
        assert_eq!(internal.instances.len(), 2, "不能只跟随最近启动的实例");
        let named = parse_tray_state("launches=[{\"id\":\"abc\",\"instanceId\":\"home/version/profile\",\"name\":\"工作入口\",\"status\":\"starting\",\"installed\":true,\"busy\":true}]");
        assert_eq!(named.launches.len(), 1);
        assert_eq!(named.launches[0].name, "工作入口");
        assert_eq!(named.launches[0].instance_id, "home/version/profile");
        assert!(named.launches[0].busy);
    }

    #[test]
    fn tray_errors_preserve_the_specific_failure() {
        assert_eq!(tray_response_error("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}"), None);
        assert_eq!(tray_response_error("HTTP/1.1 500 Internal Server Error\r\n\r\n{\"error\":\"端口被占用\"}"), Some("端口被占用".into()));
        assert!(tray_response_error("invalid response").is_some());
    }

    #[test]
    fn tells_loopback_and_same_origin_apart() {
        assert!(is_loopback_url("http://127.0.0.1:9716/?token=x"));
        assert!(is_loopback_url("http://localhost:3780/"));
        assert!(is_loopback_url("https://[::1]:9716/"));
        assert!(!is_loopback_url("https://github.com/yyh-001/DSH-X"));
        assert!(!is_loopback_url("http://192.168.1.9:9716/"));
        assert!(!is_loopback_url("about:blank"));
        // 「运行地址」那条链接可能不带 token：同源就够了，真正的地址用 state.url
        assert!(same_origin("http://127.0.0.1:9716/?token=a", "http://127.0.0.1:9716/"));
        assert!(!same_origin("http://127.0.0.1:9716/", "http://127.0.0.1:3780/"));
        assert!(!same_origin("https://example.com/", "http://127.0.0.1:9716/"));
        assert!(!same_origin("about:blank", "http://127.0.0.1:9716/"));
    }

    #[test]
    fn preparing_page_exposes_the_progress_hook() {
        assert!(PREPARING_PAGE.contains("window.bootProgress"));
        assert!(!PREPARING_PAGE.contains("__"), "这张页没有占位符要替换");
    }

    #[test]
    fn manager_recovery_waits_out_the_cooldown() {
        let now = Instant::now();
        // 第一次失败立刻恢复（还没恢复过）
        assert!(should_recover(None, now));
        // 崩溃循环：冷却期内不再重载，免得把机器拖成重载死循环
        assert!(!should_recover(Some(now), now + Duration::from_secs(59)));
        assert!(should_recover(Some(now), now + RECOVER_COOLDOWN));
    }
}
