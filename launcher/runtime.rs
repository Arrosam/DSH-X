//! 运行环境：Node 与 Electron 都不再随安装包发，而是按需下载到每用户数据目录的 `runtime/` 下。
//!
//! 为什么分成两份：装完 DSH-X 只需要 Node（服务与 dsh 子进程都用它），Electron 只有用户
//! 选了「内部标签页 / 独立窗口」才有用。运行环境放在数据目录而不是安装目录，一是 macOS 的
//! `.app` 签过名、往里写东西会破坏签名，二是这样「启动器更新」和「运行环境」互不相干。
//!
//! 版本与哈希来自仓库根的 `runtime-versions.json`。这里在**编译期**把它嵌进二进制：
//! 外壳要在还没有 Node 的时候工作，不能依赖安装目录里某个还没验证过的文件。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// 仓库根的 runtime-versions.json，编译期嵌入（见文件头的理由）。
const VERSIONS: &str = include_str!("../runtime-versions.json");

/// 下载 Node 的地址：国内镜像优先，官方站兜底。和打包脚本以前那套顺序一致。
const NODE_MIRRORS: [&str; 2] = [
    "https://npmmirror.com/mirrors/node",
    "https://nodejs.org/dist",
];

/// Electron 运行时的下载不在这里做（服务端下载，见 runtime-download.js）；外壳只负责发现和拉起。

/// 下载进度：给「正在准备运行环境」那张页用。
#[derive(Debug, Clone)]
pub struct Progress {
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub message: String,
}

fn versions() -> Value {
    serde_json::from_str::<Value>(VERSIONS).unwrap_or(Value::Null)
}

/// 当前平台+架构在清单里的键（darwin-arm64 / darwin-x64 / win32-x64 …）。
pub fn platform_key() -> String {
    let os = if cfg!(target_os = "macos") { "darwin" } else { "win32" };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// 清单里的一行：版本、压缩包名、sha256。
struct Entry {
    version: String,
    file: String,
    sha256: String,
}

fn entry(kind: &str) -> Option<Entry> {
    let table = versions();
    let table = table.get(kind)?;
    let version = table.get("version")?.as_str()?.to_string();
    let item = table.get(&platform_key())?;
    Some(Entry {
        version,
        file: item.get("file")?.as_str()?.to_string(),
        sha256: item.get("sha256")?.as_str()?.to_string(),
    })
}

/// 运行环境根目录（<数据目录>/runtime）。
pub fn runtime_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("runtime")
}

fn node_dir(app_dir: &Path, version: &str) -> PathBuf {
    runtime_dir(app_dir).join("node").join(version)
}

fn node_binary_in(dir: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let binary = dir.join("node.exe");
    #[cfg(not(windows))]
    let binary = dir.join("bin").join("node");
    binary.is_file().then_some(binary)
}

/// 已经在用的 node：旧安装包自带的那份优先（0.1.x 的 `node/node.exe`，升级上来的机器还能用），
/// 其次是数据目录里下载的那份。
pub fn find_node(app_dir: &Path, app_root: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let legacy = app_root.join("node").join("node.exe");
    #[cfg(not(windows))]
    let legacy = app_root.join("node").join("node");
    if legacy.is_file() {
        return Some(legacy);
    }
    let version = entry("node")?.version;
    node_binary_in(&node_dir(app_dir, &version))
}

/// 确保数据目录里有一份能用的 Node，没有就下载、校验、解压。返回可执行文件路径。
pub fn ensure_node(
    app_dir: &Path,
    app_root: &Path,
    mut progress: impl FnMut(Progress),
) -> Result<PathBuf, String> {
    if let Some(binary) = find_node(app_dir, app_root) {
        return Ok(binary);
    }
    let item = entry("node").ok_or_else(|| format!("没有 {} 的 Node 运行时清单", platform_key()))?;
    let target = node_dir(app_dir, &item.version);
    // 解压到目标旁边再改名：中途失败不会留下一个「看起来装了、其实缺文件」的目录。
    let staging = runtime_dir(app_dir)
        .join("node")
        .join(format!(".staging-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| format!("创建运行时目录失败：{error}"))?;

    progress(Progress {
        phase: "download".into(),
        done: 0,
        total: 0,
        message: "正在下载运行环境… / Downloading the runtime…".into(),
    });
    let archive = staging.join(&item.file);
    download(&item.file, &archive, &item.sha256, &mut progress)?;

    progress(Progress {
        phase: "extract".into(),
        done: 0,
        total: 0,
        message: "正在解压与校验… / Extracting…".into(),
    });
    extract(&archive, &staging, &item.file)?;
    let unpacked = staging.join(archive_stem(&item.file));
    if !unpacked.is_dir() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("解压后没有找到 {}", archive_stem(&item.file)));
    }
    let _ = fs::remove_dir_all(&target);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建运行时目录失败：{error}"))?;
    }
    fs::rename(&unpacked, &target).map_err(|error| format!("安装运行时失败：{error}"))?;
    let _ = fs::remove_dir_all(&staging);
    node_binary_in(&target).ok_or_else(|| "运行时里缺少 node 可执行文件".to_string())
}

fn archive_stem(file: &str) -> &str {
    file.trim_end_matches(".tar.gz").trim_end_matches(".zip")
}

/// 逐个镜像试下载，边下边报进度；下完核对 sha256。先写 `.part` 再改名，断网不会留半截文件。
fn download(
    file: &str,
    dest: &Path,
    sha256: &str,
    progress: &mut impl FnMut(Progress),
) -> Result<(), String> {
    let mut last = String::new();
    for mirror in NODE_MIRRORS {
        let url = format!("{mirror}/v{}/{}", entry("node").map(|item| item.version).unwrap_or_default(), file);
        match fetch(&url, dest, sha256, progress) {
            Ok(()) => return Ok(()),
            Err(error) => last = format!("{url}: {error}"),
        }
    }
    Err(format!("下载 {file} 失败：{last}"))
}

fn fetch(
    url: &str,
    dest: &Path,
    sha256: &str,
    progress: &mut impl FnMut(Progress),
) -> Result<(), String> {
    let response = ureq::get(url)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|error| error.to_string())?;
    let total = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let part = dest.with_extension("part");
    let _ = fs::remove_file(&part);
    let mut out = fs::File::create(&part).map_err(|error| error.to_string())?;
    let mut reader = response.into_reader();
    let mut buffer = [0u8; 64 * 1024];
    let mut done = 0u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        out.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
        done += read as u64;
        progress(Progress {
            phase: "download".into(),
            done,
            total,
            message: "正在下载运行环境… / Downloading the runtime…".into(),
        });
    }
    drop(out);
    if total > 0 && done != total {
        let _ = fs::remove_file(&part);
        return Err(format!("只收到 {done}/{total} 字节"));
    }
    if !sha256.is_empty() && sha256_file(&part)? != sha256.to_ascii_lowercase() {
        let _ = fs::remove_file(&part);
        return Err("校验失败：文件与清单里的 sha256 不一致".into());
    }
    fs::rename(&part, dest).map_err(|error| error.to_string())
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

/// 解压：macOS 的 Node 是 tar.gz（系统自带 tar，别再引一个解压库），Windows 是 zip。
fn extract(archive: &Path, into: &Path, file: &str) -> Result<(), String> {
    if file.ends_with(".zip") {
        extract_zip(archive, into)
    } else {
        let status = Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(into)
            .status()
            .map_err(|error| format!("调用 tar 失败：{error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("tar 解压失败（退出码 {:?}）", status.code()))
        }
    }
}

fn extract_zip(archive: &Path, into: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| format!("ZIP 读不了：{error}"))?;
    for index in 0..zip.len() {
        let mut member = zip.by_index(index).map_err(|error| error.to_string())?;
        let Some(name) = member.enclosed_name() else {
            return Err("压缩包里有非法路径".into());
        };
        let path = into.join(name);
        if member.is_dir() {
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut out = fs::File::create(&path).map_err(|error| error.to_string())?;
        std::io::copy(&mut member, &mut out).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 已经装好的 Electron 运行时目录（数据目录 runtime/electron/<版本>/，带 .ready 才算装好）。
/// 版本变化不改安装目录：这里取最新的那一份，旧版本留着，出问题能换回去。
pub fn electron_runtime(app_dir: &Path) -> Option<PathBuf> {
    let root = runtime_dir(app_dir).join("electron");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(&root).ok()? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_dir() || !path.join(".ready").is_file() {
            continue;
        }
        if electron_binary(&path).is_none() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

fn electron_binary(dist: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let binary = dist
        .join("Electron.app")
        .join("Contents")
        .join("MacOS")
        .join("Electron");
    #[cfg(not(target_os = "macos"))]
    let binary = dist.join("electron.exe");
    binary.is_file().then_some(binary)
}

/// 拉起 Electron 标签窗口：`<electron> <app目录> --tab <url> --title <标题>`。
///
/// 单实例由 Electron 自己管：第二次拉起的进程会把参数交给已有实例然后退出，所以外壳不需要
/// 额外的管道或控制端口。管理页地址走环境变量，标签窗口据此轮询实例状态。
pub fn launch_electron(
    dist: &Path,
    app_root: &Path,
    args: &[String],
    manager_url: &str,
) -> Result<(), String> {
    let binary = electron_binary(dist).ok_or_else(|| "Electron 运行时不完整".to_string())?;
    let mut command = Command::new(binary);
    command
        .arg(app_root)
        .args(args)
        .current_dir(app_root)
        .env("DSH_MANAGER_URL", manager_url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 Electron 失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_platform_key() {
        let key = platform_key();
        assert!(key == "darwin-arm64" || key == "darwin-x64" || key == "win32-x64", "unexpected {key}");
    }

    #[test]
    fn every_platform_entry_has_a_version_file_and_hash() {
        let table = versions();
        for kind in ["node", "electron"] {
            let entry = table.get(kind).expect("runtime table");
            assert!(entry.get("version").and_then(Value::as_str).is_some());
            for platform in ["darwin-arm64", "darwin-x64", "win32-x64"] {
                let item = entry.get(platform).unwrap_or_else(|| panic!("{kind} / {platform}"));
                let file = item.get("file").and_then(Value::as_str).expect("file name");
                let sha = item.get("sha256").and_then(Value::as_str).expect("sha256");
                assert!(file.len() > 8, "{kind}/{platform}: {file}");
                assert_eq!(sha.len(), 64, "{kind}/{platform}: {sha}");
            }
        }
    }

    #[test]
    fn archive_names_strip_to_their_directory() {
        assert_eq!(archive_stem("node-v22.19.0-darwin-arm64.tar.gz"), "node-v22.19.0-darwin-arm64");
        assert_eq!(archive_stem("electron-v44.7.0-win32-x64.zip"), "electron-v44.7.0-win32-x64");
    }

    #[test]
    fn missing_runtime_directories_are_not_mistaken_for_installed_ones() {
        let dir = std::env::temp_dir().join(format!("dsh-runtime-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(electron_runtime(&dir).is_none());
        assert!(find_node(&dir, &dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
