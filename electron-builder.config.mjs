import { join } from 'node:path'

/**
 * electron-builder 配置：外壳/Electron 的自更新交给 electron-updater。
 *
 * 安装包仍然包含 Electron 外壳和一份核心；核心另有 npm 通道（dsh-x-core-*），
 * 两个通道各自更新自己那层：
 * - 外壳/Electron：electron-updater（NSIS/dmg），换整个安装包
 * - 核心：npm（core-npm.js），换 resources/app
 *
 * asar: false：dsh 子进程和 compat/perf 钩子要按真实路径读文件，asar 里读不到。
 * 签名：Windows 暂不签名（SmartScreen 会警告）；macOS 没有 Developer ID 时 identity 为 null，
 * electron-updater 的 mac 自更新不可用，回退完整 dmg。
 */
export default {
  appId: 'io.github.yyh-001.dsh-x',
  productName: 'DSH-X',
  copyright: 'Copyright (C) 2026 yyh',
  directories: {
    app: 'release/app-stage',
    output: 'release/eb',
    buildResources: 'assets',
  },
  asar: false,
  npmRebuild: false,
  files: ['**/*'],
  publish: [
    {
      provider: 'github',
      owner: 'yyh-001',
      repo: 'DSH-X',
      releaseType: 'release',
    },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: join('assets', 'dsh.ico'),
    executableName: 'DSH',
    artifactName: 'DSH-Setup-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DSH-X',
    uninstallDisplayName: 'DSH-X',
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    installerIcon: join('assets', 'dsh.ico'),
    uninstallerIcon: join('assets', 'dsh.ico'),
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    icon: join('assets', 'icon.png'),
    category: 'public.app-category.developer-tools',
    executableName: 'DSH',
    artifactName: 'DSH-X-${version}-${arch}.${ext}',
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: {
    title: 'DSH-X',
    artifactName: 'DSH-X-${version}-${arch}.${ext}',
  },
}
