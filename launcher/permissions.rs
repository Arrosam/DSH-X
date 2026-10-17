//! Windows 的媒体授权使用可见的原生提示，避免依赖嵌入式浏览器的默认权限气泡。
//! GetDeferral 让 WebView 回调先返回：在回调内开模态窗口会触发 WebView2 重入并挂起。

#[cfg(not(windows))]
pub fn install(_view: &wry::WebView, _window: &tao::window::Window) {}
#[cfg(not(windows))]
pub fn poll(_lang: &str) {}

#[cfg(windows)]
mod native {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use tao::platform::windows::WindowExtWindows;
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_YESNO, MB_ICONQUESTION, MB_DEFBUTTON2};
    use wry::WebViewExtWindows;

    struct Pending {
        args: ICoreWebView2PermissionRequestedEventArgs,
        deferral: ICoreWebView2Deferral,
        owner: usize,
        origin: String,
        camera: bool,
    }

    impl Drop for Pending {
        fn drop(&mut self) {
            // 即使窗口已关闭、设置权限失败，也必须释放请求，不能把页面永久挂住。
            unsafe { let _ = self.deferral.Complete(); }
        }
    }

    thread_local! {
        // COM 对象始终留在创建 WebView 的 UI 线程。
        static REQUESTS: RefCell<VecDeque<Pending>> = const { RefCell::new(VecDeque::new()) };
    }

    pub fn install(view: &wry::WebView, window: &tao::window::Window) {
        let owner = window.hwnd() as usize;
        let mut token = 0;
        let result = unsafe {
            view.webview().add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                        return Ok(());
                    }
                    let mut uri = Default::default();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    // 子框架也会请求权限：只接受本地 DSH 地址，并显示真正的请求来源。
                    if !super::super::is_loopback_url(&uri) {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        return Ok(());
                    }
                    let origin = uri.split('/').take(3).collect::<Vec<_>>().join("/");
                    let pending = Pending {
                        args: args.clone(), deferral: args.GetDeferral()?, owner, origin,
                        camera: kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                    };
                    REQUESTS.with(|queue| queue.borrow_mut().push_back(pending));
                    Ok(())
                })),
                &mut token,
            )
        };
        if let Err(error) = result { eprintln!("注册媒体权限处理器失败：{error}"); }
    }

    pub fn poll(lang: &str) {
        // 不拿着 RefCell 借用开模态窗口，消息循环可能收到下一次权限请求。
        let pending = REQUESTS.with(|queue| queue.borrow_mut().pop_front());
        let Some(pending) = pending else { return };
        let english = lang == "en";
        let device = match (english, pending.camera) {
            (true, true) => "camera", (true, false) => "microphone",
            (false, true) => "摄像头", (false, false) => "麦克风",
        };
        let text = if english {
            format!("{} wants to use your {device}.\n\nAllow access?", pending.origin)
        } else {
            format!("{} 请求使用{device}。\n\n是否允许？", pending.origin)
        };
        let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "DSH-X".encode_utf16().chain(Some(0)).collect();
        let answer = unsafe {
            MessageBoxW(pending.owner as _, text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2)
        };
        unsafe {
            let state = if answer == IDYES { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY };
            let _ = pending.args.SetState(state);
        }
    }
}

#[cfg(windows)]
pub use native::{install, poll};

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, mpsc, atomic::{AtomicBool, AtomicUsize, Ordering}};
    use std::time::{Duration, Instant};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::platform::{run_return::EventLoopExtRunReturn, windows::EventLoopBuilderExtWindows};
    use tao::window::WindowBuilder;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetWindowThreadProcessId, PostMessageW, IDNO, WM_COMMAND};
    use wry::{WebContext, WebViewBuilder, WebViewBuilderExtWindows};

    #[test]
    #[ignore = "requires a Windows desktop session and WebView2; run this test alone with --nocapture"]
    fn native_media_prompt_completes_without_blocking_page() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let running = Arc::new(AtomicBool::new(true));
        let serving = running.clone();
        let server = std::thread::spawn(move || {
            while serving.load(Ordering::SeqCst) {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
                    let mut request = [0; 8192];
                    if stream.read(&mut request).unwrap_or(0) == 0 { continue; }
                    let body = "<html><script>setInterval(()=>window.ipc.postMessage('tick'),50);navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());window.ipc.postMessage('allowed')}).catch(e=>window.ipc.postMessage(e.name))</script></html>";
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                } else { std::thread::sleep(Duration::from_millis(10)); }
            }
        });
        let mut event_loop = EventLoopBuilder::<()>::with_user_event().with_any_thread(true).build();
        let window = WindowBuilder::new().with_title("DSH-X media permission test").build(&event_loop).unwrap();
        let path = std::env::temp_dir().join(format!("dsh-media-test-{}", std::process::id()));
        let mut context = WebContext::new(Some(path));
        let ticks = Arc::new(AtomicUsize::new(0));
        let page_ticks = ticks.clone();
        let (tx, rx) = mpsc::channel();
        let view = WebViewBuilder::new_with_web_context(&mut context)
            // 只提供模拟音频设备，权限请求仍走真实 WebView2；测试绝不读取物理麦克风。
            .with_additional_browser_args("--use-fake-device-for-media-stream")
            .with_ipc_handler(move |request| {
                if request.body() == "tick" { page_ticks.fetch_add(1, Ordering::SeqCst); }
                else { let _ = tx.send(request.body().clone()); }
            }).build(&window).unwrap();
        install(&view, &window);
        let responder = std::thread::spawn(move || {
            let class: Vec<u16> = "#32770".encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "DSH-X".encode_utf16().chain(Some(0)).collect();
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                let mut previous = std::ptr::null_mut();
                loop {
                    let dialog = unsafe { FindWindowExW(std::ptr::null_mut(), previous, class.as_ptr(), title.as_ptr()) };
                    if dialog.is_null() { break; }
                    let mut process = 0;
                    unsafe { GetWindowThreadProcessId(dialog, &mut process); }
                    if process == std::process::id() {
                        let before = ticks.load(Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(300));
                        let progressing = ticks.load(Ordering::SeqCst) > before;
                        // 只操作本测试进程的对话框，避免触碰用户正在使用的 DSH-X。
                        unsafe { PostMessageW(dialog, WM_COMMAND, IDNO as usize, 0); }
                        return (true, progressing);
                    }
                    previous = dialog;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            (false, false)
        });
        view.load_url(&url).unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut result = None;
        event_loop.run_return(|_, _, flow| {
            poll("en");
            if let Ok(value) = rx.try_recv() { result = Some(value); }
            *flow = if result.is_some() || Instant::now() >= deadline { ControlFlow::Exit }
                else { ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(20)) };
        });
        let (shown, progressing) = responder.join().unwrap();
        running.store(false, Ordering::SeqCst);
        server.join().unwrap();
        assert!(shown, "必须实际显示原生媒体授权提示");
        assert!(progressing, "授权提示打开期间 WebView 页面仍能运行并发送消息");
        assert_eq!(result.as_deref(), Some("NotAllowedError"), "拒绝后必须结束权限请求，不能挂住页面");
    }
}
