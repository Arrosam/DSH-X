//! 渲染进程健康监控：WebView2 的页面进程退出或卡死时，把事件交给事件循环去处理。
//!
//! 为什么需要它：WebView2 不会自己从这两种状态里恢复。渲染进程卡死时窗口停在最后一帧，
//! 但浏览器的合成/GPU 进程继续按帧工作——实测一台机器上就这么挂了六天，两个
//! `msedgewebview2.exe` 各烧掉 4.5 万 CPU 秒、占掉 1GB 内存，系统可用内存只剩 276MB、
//! pages/sec 1153（用户只能手动杀进程，杀了之后宿主才重新拉起一个 GPU 进程）。
//! 所以外层必须自己发现并重载，而不是等用户看见一块死画面。
//!
//! 回调里不做导航：WebView2 的 COM 回调里直接导航会踩重入限制（`permissions.rs`
//! 里记过同类坑），这里只把结论丢回事件循环。

/// 会让页面再也回不来的两种失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 渲染进程退出（崩溃、被系统结束）。
    Exited,
    /// 渲染进程卡死（不响应，但进程还在，会一直占着 CPU/内存）。
    Unresponsive,
}

/// 订阅 `ProcessFailed`。非 Windows 平台是空实现：macOS 的页面进程终止由 WKWebView
/// 自己的 `with_on_web_content_process_terminate_handler` 处理（见 `tabs.rs`）。
pub fn watch(view: &wry::WebView, on_failed: impl Fn(Failure) + 'static) {
    #[cfg(target_os = "windows")]
    windows::watch(view, on_failed);
    #[cfg(not(target_os = "windows"))]
    let _ = (view, on_failed);
}

#[cfg(target_os = "windows")]
mod windows {
    use super::Failure;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::ProcessFailedEventHandler;
    use wry::WebViewExtWindows;

    pub fn watch(view: &wry::WebView, on_failed: impl Fn(Failure) + 'static) {
        let mut token = 0;
        let result = unsafe {
            view.webview().add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    args.ProcessFailedKind(&mut kind)?;
                    // 只认渲染进程：GPU/utility 进程掉了 WebView2 自己会重建，页面不受影响。
                    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                        on_failed(Failure::Exited);
                    } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                        on_failed(Failure::Unresponsive);
                    }
                    Ok(())
                })),
                &mut token,
            )
        };
        if let Err(error) = result {
            // 注册失败只影响自愈，不影响页面本身：留一行日志，别让启动失败。
            eprintln!("注册渲染进程失败处理器失败：{error}");
        }
    }
}
