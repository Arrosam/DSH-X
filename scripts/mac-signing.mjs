import { MAC_BUNDLE_ID } from '../platform.js'
import { run } from './pack-common.mjs'

/** 固定证书用 SHA-1 指纹选取，避免两台 CI runner 上同名证书误选到不同私钥。 */
export function macSigningIdentity(env = process.env) {
  const identity = (env.DSH_MAC_SIGNING_IDENTITY || '').trim()
  if (identity && !/^[0-9a-f]{40}$/i.test(identity)) {
    throw new Error('DSH_MAC_SIGNING_IDENTITY 必须是 40 位证书 SHA-1 指纹')
  }
  if (!identity && env.DSH_MAC_REQUIRE_SIGNED === '1') {
    throw new Error('正式 macOS 包缺少固定签名证书（DSH_MAC_SIGNING_IDENTITY）')
  }
  return identity.toUpperCase() || '-'
}

/**
 * 签整个 .app。安装包里已经没有 Electron 框架和 Helper 子进程了，只有
 * Contents/MacOS/DSH 一个可执行文件（app 层是纯 JS/资源），所以不需要逐层签子代码。
 * 同一张证书跨版本、跨架构重用，系统才能用签名要求认出更新后的应用。
 */
export function signMacBundle(bundle, env = process.env) {
  const identity = macSigningIdentity(env)
  const keychain = (env.DSH_MAC_KEYCHAIN || '').trim()
  const keychainArgs = keychain ? ['--keychain', keychain] : []
  run('codesign', ['--force', '--sign', identity, '--identifier', MAC_BUNDLE_ID, ...keychainArgs, bundle])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle])
  console.log(identity === '-' ? 'macOS: ad-hoc 签名（仅供本地测试）' : `macOS: 固定证书签名 ${identity}`)
}
