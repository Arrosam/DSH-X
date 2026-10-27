// 本地测试通道的 Ed25519 私钥（PKCS#8 DER 的 base64）。
//
// 只用于 `scripts/update-flow-demo.mjs` 给假发布资产签名；对应公钥是
// app-update.js 里的 TEST_APP_PUBLIC_KEY，客户端只在设置了 DSH_UPDATE_BASE 时信任它。
// 正式发布用的私钥在 release/release-key.pem（不随仓库分发）。
import { createPrivateKey } from 'node:crypto'

const DER_BASE64 = 'MC4CAQAwBQYDK2VwBCIEIBU3cD4CUMRdrAiDMPVto0tO9oTxDCf47Oc/Wfv0grL9'

/** 返回 PEM 字符串，直接喂给 scripts/app-manifest.mjs 的 buildAppAssets。 */
export function testReleaseKeyPem() {
  return createPrivateKey({ key: Buffer.from(DER_BASE64, 'base64'), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
}
