#![cfg_attr(windows, windows_subsystem = "windows")]

// 微型引导器（DSH-Boot，安装后改名 DSH.exe）：
// - 已装好（current.json + runtime + app 都在）时：直接启动当前版本的 runtime，立刻退出
// - 首次运行：显示下载进度，下载 runtime 与 app（各自带签名清单），解压校验后建 junction、写
//   current.json，再启动
//
// 布局（安装根目录）：
//   DSH.exe                          ← 本程序（快捷方式指向它）
//   current.json                     { "runtime": "44.7.0", "app": "0.1.21" }
//   runtime/<electron版本>/          ← Electron 运行时（DSH.exe + dll/pak/locales…）
//       resources/app → junction → ../../app/<启动器版本>
//   app/<启动器版本>/                ← resources/app 的内容
//
// 只依赖内置模块与少量 crate；清单验签用内置 Ed25519 公钥（与 scripts/release-pubkey.pem 同一把）。

#[cfg(windows)]
mod boot {
    use base64::Engine;
    use ed25519_dalek::{Signature, VerifyingKey};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::{Read, Write},
        os::windows::process::CommandExt,
        path::{Path, PathBuf},
        process::Command,
        thread,
        time::Duration,
    };
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        window::WindowBuilder,
    };
    use wry::{WebContext, WebViewBuilder};

    const REPO: &str = "yyh-001/DSH-X";
    const MIRRORS: [&str; 2] = ["https://gh-proxy.com/", "https://ghfast.top/"];
    /// 内置公钥（scripts/release-pubkey.pem 的 base64 主体，32 字节 Ed25519）。
    const PUBLIC_KEY_B64: &str = "qIKBGwG4iFvoqTtqIN+rcWgOsTjGRmM0BggjZBDAspU=";
    const PAGE: &str = include_str!("../boot/index.html");
    const NO_WINDOW: u32 = 0x08000000;
    /// 编译时写入的启动器版本（build.rs 从 package.json 取）。
    const BOOT_VERSION: &str = env!("DSH_BOOT_VERSION");

    #[derive(Clone)]
    struct Progress {
        phase: String,
        done: u64,
        total: u64,
        message: String,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }

    /// 引导器是 GUI 进程，没有控制台；所有步骤写进日志，出问题能查。
    fn log(message: &str) {
        use std::io::Write;
        let path = std::env::var("DSH_BOOT_LOG").unwrap_or_else(|_| {
            std::env::temp_dir().join("dsh-boot.log").to_string_lossy().into_owned()
        });
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "[{}] {message}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        }
    }

    fn zh() -> bool {
        unsafe { GetUserDefaultUILanguage() & 0x3ff == 4 }
    }

    fn say(key: &str) -> &'static str {
        let (zh_text, en_text) = match key {
            "preparing" => ("正在准备安装…", "Preparing…"),
            "runtime" => ("正在下载 Electron 运行时…", "Downloading the Electron runtime…"),
            "app" => ("正在下载启动器…", "Downloading the launcher…"),
            "extract" => ("正在解压与校验…", "Extracting and verifying…"),
            "launch" => ("正在启动…", "Starting…"),
            "failed" => ("安装没有完成", "Setup did not finish"),
            _ => ("请稍候…", "Please wait…"),
        };
        if zh() { zh_text } else { en_text }
    }

    fn verifying_key() -> VerifyingKey {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(PUBLIC_KEY_B64)
            .expect("内置公钥解码失败");
        let bytes: [u8; 32] = raw.as_slice().try_into().expect("公钥长度不对");
        VerifyingKey::from_bytes(&bytes).expect("公钥无效")
    }

    fn verify_manifest(bytes: &[u8], signature_b64: &str) -> bool {
        let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(signature_b64.trim()) else {
            return false;
        };
        let Ok(signature) = Signature::from_slice(&raw) else {
            return false;
        };
        verifying_key().verify_strict(bytes, &signature).is_ok()
    }

    /// 调试/测试用：DSH_BOOT_BASE 指到一个本地目录（扁平存放发布资产），不走镜像。
    fn local_base() -> Option<String> {
        std::env::var("DSH_BOOT_BASE").ok().filter(|value| !value.trim().is_empty())
    }

    fn candidates(url: &str) -> Vec<String> {
        if local_base().is_some() {
            return vec![url.to_string()];
        }
        let mut list: Vec<String> = MIRRORS.iter().map(|prefix| format!("{prefix}{url}")).collect();
        list.push(url.to_string());
        list
    }

    fn get_bytes(url: &str) -> Result<Vec<u8>, String> {
        let mut last = String::new();
        for candidate in candidates(url) {
            match ureq::get(&candidate)
                .timeout(Duration::from_secs(120))
                .call()
            {
                Ok(response) => {
                    let mut buffer = Vec::new();
                    if let Err(error) = response.into_reader().read_to_end(&mut buffer) {
                        last = format!("{candidate}: {error}");
                        continue;
                    }
                    return Ok(buffer);
                }
                Err(error) => last = format!("{candidate}: {error}"),
            }
        }
        Err(format!("下载失败：{last}"))
    }

    /// 带进度的下载：先写 .part 再改名，中途失败不会留下半截文件。
    fn download(url: &str, dest: &Path, mut on_progress: impl FnMut(u64, u64)) -> Result<(), String> {
        let mut last = String::new();
        for candidate in candidates(url) {
            match ureq::get(&candidate)
                .timeout(Duration::from_secs(600))
                .call()
            {
                Ok(response) => {
                    let total = response
                        .header("content-length")
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    let part = dest.with_extension("part");
                    let _ = fs::remove_file(&part);
                    let mut file = fs::File::create(&part).map_err(|error| error.to_string())?;
                    let mut reader = response.into_reader();
                    let mut buffer = [0u8; 64 * 1024];
                    let mut done = 0u64;
                    let mut failed = false;
                    loop {
                        let read = match reader.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(read) => read,
                            Err(error) => {
                                last = format!("{candidate}: {error}");
                                failed = true;
                                break;
                            }
                        };
                        file.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
                        done += read as u64;
                        on_progress(done, total);
                    }
                    drop(file);
                    if failed {
                        let _ = fs::remove_file(&part);
                        continue;
                    }
                    if total > 0 && done != total {
                        let _ = fs::remove_file(&part);
                        last = format!("{candidate}: 只收到 {done}/{total} 字节");
                        continue;
                    }
                    fs::rename(&part, dest).map_err(|error| error.to_string())?;
                    return Ok(());
                }
                Err(error) => last = format!("{candidate}: {error}"),
            }
        }
        Err(format!("下载失败：{last}"))
    }

    fn install_root() -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        exe.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "拿不到安装目录".to_string())
    }

    fn read_current(root: &Path) -> Option<Value> {
        let text = fs::read_to_string(root.join("current.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn runtime_dir(root: &Path, version: &str) -> PathBuf {
        root.join("runtime").join(version)
    }

    fn app_dir(root: &Path, version: &str) -> PathBuf {
        root.join("app").join(version)
    }

    fn runtime_exe(root: &Path, version: &str) -> PathBuf {
        runtime_dir(root, version).join("DSH.exe")
    }

    /// 已装好就返回 (runtime 版本, app 版本)；缺任何一块都返回 None。
    fn installed(root: &Path) -> Option<(String, String)> {
        let current = read_current(root)?;
        let runtime = current.get("runtime")?.as_str()?.to_string();
        let app = current.get("app")?.as_str()?.to_string();
        if !runtime_exe(root, &runtime).is_file() {
            return None;
        }
        if !app_dir(root, &app).is_dir() {
            return None;
        }
        Some((runtime, app))
    }

    fn launch(root: &Path, runtime: &str) -> Result<(), String> {
        let exe = runtime_exe(root, runtime);
        Command::new(&exe)
            .current_dir(runtime_dir(root, runtime))
            .creation_flags(NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("启动失败：{error}"))
    }

    /// 用 cmd 建 junction（符号链接要管理员权限，junction 不用）。
    fn junction(link: &Path, target: &Path) -> Result<(), String> {
        if fs::symlink_metadata(link).is_ok() {
            let _ = fs::remove_dir(link);
        }
        if let Some(parent) = link.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let status = Command::new("cmd")
            .args([
                "/c",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &target.to_string_lossy(),
            ])
            .creation_flags(NO_WINDOW)
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("建目录链接失败（mklink 退出码 {:?}）", status.code()))
        }
    }

    fn sha256_file(path: &Path) -> Result<String, String> {
        let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    /// 解压 zip 到 target，逐个文件对照清单校验大小与 sha256（只落清单里的文件）。
    fn extract_verified(
        zip_path: &Path,
        manifest: &Value,
        target: &Path,
        mut on_progress: impl FnMut(u64, u64),
    ) -> Result<(), String> {
        let files = manifest
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| "清单里没有文件".to_string())?;
        let file = fs::File::open(zip_path).map_err(|error| error.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("ZIP 读不了：{error}"))?;
        let staging = target.with_extension("staging");
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        let total = files.len() as u64;
        for (index, entry) in files.iter().enumerate() {
            let relative = entry
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "清单条目缺路径".to_string())?;
            if relative.starts_with('/') || relative.split('/').any(|part| part == "..") {
                return Err(format!("清单里有非法路径：{relative}"));
            }
            let expected_size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
            let expected_hash = entry.get("sha256").and_then(Value::as_str).unwrap_or("");
            let mut member = archive
                .by_name(relative)
                .map_err(|_| format!("安装包缺少 {relative}"))?;
            let out_path = staging.join(relative.replace('/', "\\"));
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut out = fs::File::create(&out_path).map_err(|error| error.to_string())?;
            let mut hasher = Sha256::new();
            let mut size = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = member.read(&mut buffer).map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
                out.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
                size += read as u64;
            }
            drop(out);
            if size != expected_size || format!("{:x}", hasher.finalize()) != expected_hash {
                return Err(format!("{relative} 校验失败"));
            }
            on_progress(index as u64 + 1, total);
        }
        if fs::symlink_metadata(target).is_ok() {
            fs::remove_dir_all(target).map_err(|error| error.to_string())?;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::rename(&staging, target).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn latest_tag() -> Result<String, String> {
        if let Ok(version) = std::env::var("DSH_BOOT_VERSION") {
            let version = version.trim().trim_start_matches('v').to_string();
            if !version.is_empty() {
                return Ok(version);
            }
        }
        let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
        let bytes = get_bytes(&url)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        value
            .get("tag_name")
            .and_then(Value::as_str)
            .map(|tag| tag.trim_start_matches('v').to_string())
            .ok_or_else(|| "读不到最新版本".to_string())
    }

    fn asset_url(version: &str, name: &str) -> String {
        if let Some(base) = local_base() {
            return format!("{}/{name}", base.trim_end_matches('/'));
        }
        format!("https://github.com/{REPO}/releases/download/v{version}/{name}")
    }

    fn fetch_manifest(version: &str, name: &str) -> Result<Value, String> {
        let bytes = get_bytes(&asset_url(version, name))?;
        let signature = String::from_utf8(get_bytes(&asset_url(version, &format!("{name}.sig")))?)
            .map_err(|error| error.to_string())?;
        if !verify_manifest(&bytes, &signature) {
            return Err(format!("{name} 的签名校验失败"));
        }
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    }

    fn archive_name(manifest: &Value) -> String {
        manifest
            .get("archive")
            .and_then(|archive| archive.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    fn archive_sha(manifest: &Value) -> String {
        manifest
            .get("archive")
            .and_then(|archive| archive.get("sha256"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    fn install(root: &Path, mut progress: impl FnMut(Progress)) -> Result<(), String> {
        progress(Progress { phase: "preparing".into(), done: 0, total: 0, message: say("preparing").into() });
        let version = latest_tag()?;
        log(&format!("最新版本 {version}"));
        let app_manifest = fetch_manifest(&version, &format!("app-{version}-win.manifest.json"))?;
        let electron = app_manifest
            .get("electronVersion")
            .and_then(Value::as_str)
            .ok_or_else(|| "应用清单缺 Electron 版本".to_string())?
            .to_string();
        log(&format!("应用清单 OK，Electron {electron}"));
        let runtime_manifest = fetch_manifest(&version, &format!("runtime-{electron}-win.manifest.json"))?;
        log("运行时清单 OK");

        let temp = std::env::temp_dir().join(format!("dsh-boot-{}", std::process::id()));
        fs::create_dir_all(&temp).map_err(|error| error.to_string())?;
        let result = (|| -> Result<(), String> {
            // app 先下：体积小，失败重试代价低
            let app_zip = temp.join("app.zip");
            progress(Progress { phase: "app".into(), done: 0, total: 0, message: say("app").into() });
            download(
                &asset_url(&version, &archive_name(&app_manifest)),
                &app_zip,
                |done, total| progress(Progress { phase: "app".into(), done, total, message: say("app").into() }),
            )?;
            if sha256_file(&app_zip)? != archive_sha(&app_manifest) {
                return Err("启动器安装包校验失败".into());
            }
            progress(Progress { phase: "extract".into(), done: 0, total: 0, message: say("extract").into() });
            log("应用包下载完成，开始解压");
            extract_verified(&app_zip, &app_manifest, &app_dir(root, &version), |_, _| {})?;
            log("应用解压校验完成");

            let runtime_zip = temp.join("runtime.zip");
            progress(Progress { phase: "runtime".into(), done: 0, total: 0, message: say("runtime").into() });
            download(
                &asset_url(&version, &archive_name(&runtime_manifest)),
                &runtime_zip,
                |done, total| progress(Progress { phase: "runtime".into(), done, total, message: say("runtime").into() }),
            )?;
            if sha256_file(&runtime_zip)? != archive_sha(&runtime_manifest) {
                return Err("Electron 运行时安装包校验失败".into());
            }
            progress(Progress { phase: "extract".into(), done: 0, total: 0, message: say("extract").into() });
            log("运行时包下载完成，开始解压");
            extract_verified(&runtime_zip, &runtime_manifest, &runtime_dir(root, &electron), |_, _| {})?;
            log("运行时解压校验完成");

            junction(
                &runtime_dir(root, &electron).join("resources").join("app"),
                &app_dir(root, &version),
            )?;
            log("junction 建好");
            log("写入 current.json");
            let current = json!({ "runtime": electron, "app": version, "boot": BOOT_VERSION });
            fs::write(
                root.join("current.json"),
                format!("{}\n", serde_json::to_string_pretty(&current).unwrap_or_default()),
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })();
        let _ = fs::remove_dir_all(&temp);
        result
    }

    fn arg_value(name: &str) -> String {
        let args: Vec<String> = std::env::args().collect();
        args.iter().position(|arg| arg == name).and_then(|index| args.get(index + 1)).cloned().unwrap_or_default()
    }

    /// 启动标记：应用在管理服务起来后写到 APPDATA 下的 DSH/update-ok（和 APP_DIR 一致）。
    fn marker_path(root: &Path) -> PathBuf {
        let custom = arg_value("--marker");
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
        match std::env::var("APPDATA") {
            Ok(base) => PathBuf::from(base).join("DSH").join("update-ok"),
            Err(_) => root.join("update-ok"),
        }
    }

    /// 等旧进程退出：更新后重启时它可能还占着管理端口。
    fn wait_process_exit(pid: u32, timeout: Duration) -> bool {
        if pid == 0 {
            return true;
        }
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            let alive = Command::new("cmd")
                .args(["/c", "tasklist", "/FI", &format!("PID eq {pid}"), "/NH"])
                .creation_flags(NO_WINDOW)
                .output()
                .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
                .unwrap_or(false);
            if !alive {
                return true;
            }
            thread::sleep(Duration::from_millis(200));
        }
        false
    }

    /// 发现 boot-update.exe（应用下载并校验过的新引导器）就替换自己：
    /// 运行中的 exe 不能覆盖但可以改名，改名后写入新文件、拉起新进程、自己退出。
    fn self_replace(root: &Path) -> bool {
        let update = root.join("boot-update.exe");
        if !update.is_file() {
            return false;
        }
        let current = match std::env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                log(&format!("自更新：拿不到自身路径 {error}"));
                return false;
            }
        };
        let old = current.with_extension("exe.old");
        let _ = fs::remove_file(&old);
        if let Err(error) = fs::rename(&current, &old) {
            log(&format!("自更新：改名旧 exe 失败 {error}"));
            return false;
        }
        if let Err(error) = fs::rename(&update, &current) {
            let _ = fs::rename(&old, &current);
            log(&format!("自更新：换上新 exe 失败 {error}"));
            return false;
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        match Command::new(&current).args(&args).spawn() {
            Ok(_) => {
                log("自更新：已换成新引导器，重启");
                true
            }
            Err(error) => {
                // 新进程起不来：把旧的换回去，继续用旧版本
                let _ = fs::rename(&current, &update);
                let _ = fs::rename(&old, &current);
                log(&format!("自更新：新引导器起不来 {error}"));
                false
            }
        }
    }

    /// 把当前引导器版本补进 current.json（老安装没有这个字段）。
    fn stamp_boot(root: &Path) {
        let mut current = read_current(root).unwrap_or_default();
        if !current.is_object() {
            return;
        }
        if current.get("boot").and_then(Value::as_str) == Some(BOOT_VERSION) {
            return;
        }
        if let Some(object) = current.as_object_mut() {
            object.insert("boot".into(), Value::String(BOOT_VERSION.into()));
        }
        let _ = fs::write(root.join("current.json"), format!("{}
", serde_json::to_string_pretty(&current).unwrap_or_default()));
    }

    /// 新进程启动时清理上一份被改名让位的 exe（旧进程可能还没完全退出，重试几秒）。
    fn cleanup_old(root: &Path) {
        let old = root.join("DSH.exe.old");
        if !old.exists() {
            return;
        }
        for _ in 0..10 {
            if fs::remove_file(&old).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    pub fn run() {
        let wait_pid: u32 = arg_value("--wait-pid").parse().unwrap_or(0);
        if wait_pid > 0 {
            wait_process_exit(wait_pid, Duration::from_secs(60));
        }
        let root = match install_root() {
            Ok(root) => root,
            Err(error) => {
                fatal(&error);
                return;
            }
        };
        // 上一轮应用更新下载了新引导器：先换掉自己（换完新进程接着跑，本进程退出）
        if self_replace(&root) {
            return;
        }
        cleanup_old(&root);
        // 已经装好：不闪窗口，直接起当前版本
        if let Some((runtime, app)) = installed(&root) {
            stamp_boot(&root);
            let current = read_current(&root).unwrap_or_default();
            // 上一次更新还没被确认（current.json 里有 previous）：等新版本写出启动标记，
            // 等不到就回滚到 previous 并重启旧版本
            if current.get("previous").is_some() {
                let marker = marker_path(&root);
                let _ = fs::remove_file(&marker);
                if launch(&root, &runtime).is_ok() && wait_marker(&marker, Duration::from_secs(45)) {
                    let mut next = current.clone();
                    if let Some(object) = next.as_object_mut() {
                        object.remove("previous");
                    }
                    let _ = fs::write(root.join("current.json"), format!("{}\n", serde_json::to_string_pretty(&next).unwrap_or_default()));
                    log(&format!("更新已确认：app {app}"));
                } else {
                    let previous = current.get("previous").cloned().unwrap_or_default();
                    let prev_runtime = previous.get("runtime").and_then(Value::as_str).unwrap_or("").to_string();
                    let prev_app = previous.get("app").and_then(Value::as_str).unwrap_or("").to_string();
                    let can_rollback = !prev_runtime.is_empty()
                        && !prev_app.is_empty()
                        && runtime_exe(&root, &prev_runtime).is_file()
                        && app_dir(&root, &prev_app).is_dir();
                    if can_rollback {
                        let _ = junction(
                            &runtime_dir(&root, &prev_runtime).join("resources").join("app"),
                            &app_dir(&root, &prev_app),
                        );
                        let restored = json!({ "runtime": prev_runtime, "app": prev_app, "boot": BOOT_VERSION });
                        let _ = fs::write(root.join("current.json"), format!("{}\n", serde_json::to_string_pretty(&restored).unwrap_or_default()));
                        let _ = launch(&root, &prev_runtime);
                        log(&format!("新版本没有启动成功，已回滚到 app {prev_app}"));
                    } else {
                        log("新版本没有启动成功，且找不到可回滚的旧版本");
                    }
                }
                return;
            }
            let _ = launch(&root, &runtime);
            return;
        }
        first_run(root);
    }

    /// 等新版本写出启动标记（app 在服务起来后写）。
    fn wait_marker(marker: &Path, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if marker.is_file() {
                return true;
            }
            thread::sleep(Duration::from_millis(250));
        }
        false
    }

    fn first_run(root: PathBuf) {
        let event_loop = EventLoopBuilder::<Progress>::with_user_event().build();
        // 居中到主屏；允许缩放（内容长的时候用户可以自己拉大）
        let size = LogicalSize::new(520.0, 280.0);
        let position = event_loop
            .primary_monitor()
            .or_else(|| event_loop.available_monitors().next())
            .map(|monitor| {
                let screen = monitor.size();
                let window = size.to_physical::<u32>(monitor.scale_factor());
                tao::dpi::PhysicalPosition::new(
                    screen.width.saturating_sub(window.width) / 2,
                    screen.height.saturating_sub(window.height) / 2,
                )
            });
        let mut builder = WindowBuilder::new()
            .with_title("DSH-X")
            .with_decorations(false)
            .with_resizable(true)
            .with_inner_size(size)
            .with_min_inner_size(LogicalSize::new(420.0, 220.0));
        if let Some(position) = position {
            builder = builder.with_position(position);
        }
        let window = match builder.build(&event_loop)
        {
            Ok(window) => window,
            Err(error) => {
                fatal(&error.to_string());
                return;
            }
        };
        let proxy = event_loop.create_proxy();
        let mut context = WebContext::new(Some(std::env::temp_dir().join("dsh-boot-webview")));
        let page = PAGE.replace("__LANG__", if zh() { "zh" } else { "en" });
        let ipc_proxy = proxy.clone();
        let view = match WebViewBuilder::new_with_web_context(&mut context)
            .with_url("about:blank")
            .with_ipc_handler(move |request| {
                if request.body().contains("close") {
                    let _ = ipc_proxy.send_event(Progress { phase: "close".into(), done: 0, total: 0, message: String::new() });
                }
            })
            .with_navigation_handler(|url| url == "about:blank" || url.starts_with("data:text/html"))
            .build(&window)
        {
            Ok(view) => view,
            Err(error) => {
                fatal(&format!("WebView2: {error}"));
                return;
            }
        };
        let mut loaded = false;
        let mut started = false;
        let mut launch_after: Option<String> = None;
        event_loop.run(move |event, _, flow| {
            let _keep_alive = &window;
            *flow = ControlFlow::Wait;
            match event {
                Event::NewEvents(tao::event::StartCause::Init) if !loaded => {
                    loaded = true;
                    let _ = view.load_html(&page);
                }
                Event::UserEvent(progress) if progress.phase == "close" => {
                    *flow = ControlFlow::Exit;
                }
                Event::UserEvent(progress) => {
                    let script = format!(
                        "window.bootProgress({})",
                        json!({ "phase": progress.phase, "done": progress.done, "total": progress.total, "message": progress.message })
                    );
                    let _ = view.evaluate_script(&script);
                    if progress.phase == "done" {
                        launch_after = Some(progress.message.clone());
                    }
                }
                Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
                _ => {}
            }
            if !started {
                started = true;
                let proxy = proxy.clone();
                let root = root.clone();
                thread::spawn(move || {
                    match install(&root, |progress| {
                        let _ = proxy.send_event(progress);
                    }) {
                        Ok(()) => {
                            let current = read_current(&root).unwrap_or_default();
                            let runtime = current.get("runtime").and_then(Value::as_str).unwrap_or("").to_string();
                            let _ = proxy.send_event(Progress {
                                phase: "done".into(),
                                done: 0,
                                total: 0,
                                message: runtime,
                            });
                        }
                        Err(error) => {
                            log(&format!("安装失败：{error}"));
                            let _ = proxy.send_event(Progress {
                                phase: "error".into(),
                                done: 0,
                                total: 0,
                                message: format!("{}：{error}", say("failed")),
                            });
                        }
                    }
                });
            }
            if let Some(runtime) = launch_after.take() {
                log(&format!("启动 runtime {runtime}"));
                let _ = launch(&root, &runtime);
                *flow = ControlFlow::Exit;
            }
        });
    }

    fn fatal(message: &str) {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(wnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
        }
        let wide = |text: &str| -> Vec<u16> { OsStr::new(text).encode_wide().chain(Some(0)).collect() };
        unsafe {
            MessageBoxW(0, wide(message).as_ptr(), wide("DSH-X").as_ptr(), 0x10);
        }
    }
}

#[cfg(windows)]
fn main() {
    boot::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
