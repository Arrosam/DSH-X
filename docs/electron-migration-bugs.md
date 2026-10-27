# macOS Electron shell: two old bugs to recheck

这份记录写于「macOS 外壳从 Rust + WKWebView 搬到 Electron」的那次迁移。后来外壳又搬回原生（Rust + WKWebView 只管控制面板窗口），dsh 的内部标签页 / 独立窗口改由按需下载的 Electron 标签窗口承载（见 `no-electron-runtime.md`）。下面两个旧 WKWebView 时代的 bug 仍值得在 Electron 标签窗口里复查，确认是不是 Chromium 也有的问题。

## 1. Arrow keys in an empty composer insert junk characters

- **Symptom:** in an internal DSH tab, pressing the arrow keys while the composer is empty inserts invisible control characters such as `\u001c\u001c\u001d\u001d\u001d`.
- **Likely cause:** how WKWebView handles NSEvent arrow keys (`NSUpArrowFunctionKey` and so on). `\x1c`–`\x1f` are exactly the ASCII control codes for left / right / up / down, so the keys appear to be inserted as text instead of being treated as editing commands.
- **First result on the new shell:** sending ↑ ↑ ↓ ← → to an empty `<textarea>` in a tab over the DevTools protocol left the value empty. This used a mock page, **not the real dsh composer**.
- **Please recheck:** start a real dsh instance with the open mode set to "DSH-X internal tabs", then press the arrow keys in an empty composer: single presses, holding a key down, and with an input method active.

## 2. Internal tabs crash at random

- **Symptom:** an internal tab randomly goes black or white, and reloading returns 401.
- **Known cause on the old shell:** the WebKit web content process crashing (JavaScriptCore JIT SIGSEGV / EXC_BREAKPOINT in the logs, often in event callbacks triggered by typing). Commit `7eb8294` added re-authentication and reload after a crash, but didn't stop the crashes.
- **How the new shell handles it:** when a tab fires `render-process-gone`, the shell navigates back to the start-token URL (`recover` in `shell/tabs.mjs`, the same authentication path as the old shell).
- **First result on the new shell:** forcing the tab's renderer to crash with `Page.crash` brought the tab back automatically (the mock server received a second request). The shell process also ran for about 20 hours with no crash logged.
- **Please recheck:** use a real dsh for a long session (several tabs, frequent switching, long typed conversations) and see whether it still crashes. If it does, attach the crash report from `~/Library/Application Support/DSH/electron/Crashpad` and `manager.log`.

## Limitations

- 上述检查是在旧 Electron 外壳从源码运行时做的（`npm run electron` 已随外壳搬回原生删除）。现在要复现，先编原生外壳（`cd launcher && cargo build --release --bin DSH`），用 `DSH_APP_ROOT=$PWD launcher/target/release/DSH` 从源码起，再在设置页下载 Electron 运行时后选「内部标签页」。
- 现在 Windows 的控制面板回到 WebView2、macOS 是 WKWebView；但 dsh 的内部标签页两边都是按需下载的 Electron（Chromium），所以 WebView2-only 的症状只可能出现在管理页，不会进 dsh 页面。
