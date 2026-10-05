'use strict'
/* 自更新签名校验用的内置公钥（Ed25519，raw 32 字节的 base64）。
 *
 * 用途：electron/core/updateSig.js 在允许下载/安装自更新包之前，先从 GitHub release
 * 取回 latest.yml 与 latest.yml.sig，用这把公钥对 latest.yml 的原始字节验签；
 * 验不过（或没有 .sig）就拒绝更新。latest.yml 里带着安装包的 sha512，所以签住元数据
 * 等于签住安装包 —— 光有 GitHub 发布权限或能伪造 TLS 的人也换不了包。
 *
 * 配对的私钥只在发版机上、且放在仓库外面（优先 D:\workSpace\panbox-secrets\update-signing.key，
 * 其次 %USERPROFILE%\.panbox-secrets\update-signing.key），由 tools/sign-update.js 使用。
 * 私钥绝不入库；换掉这把公钥 = 所有已装的老客户端都会验签失败而拒更，非必要不要换。
 *
 * 指纹（raw 32 字节的 SHA-256，base64）：SHA256:VZduToILu/TsY+nPb1zgp1OSPaukZNLt0lZwxnVwX+g=
 */
const PUBLIC_KEY_B64 = 'iQymuvRHvxUiB9eJJq+621LR9QPd9gLVWjSGlW+6jHg='

module.exports = { PUBLIC_KEY_B64 }
