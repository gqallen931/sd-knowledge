import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * LLM 密钥的可逆加密设施（S1-01，架构文档 §5.1.3）。
 *
 * 为什么需要：`llm_providers` 存的是「SD 调外部模型」的凭证，调用时必须还原成明文，
 * 所以不能像 `api_keys`（外部调 SD）那样单向哈希。仓库里既有的 `securityService` 只有
 * PBKDF2 哈希（不可逆），没有可逆加密设施，因此本任务自建一套。
 *
 * 设计：
 * - AES-256-GCM（认证加密，防密文被篡改后静默解出垃圾）。
 * - 密钥源是**平台级密钥文件** `<数据目录>/.keys/platform.key`（32 字节随机，权限 0600，
 *   首次使用时生成）。与用户口令派生的密钥（P2 的 SQLCipher）分属两条链路，
 *   避免「改登录密码要重加密所有 LLM key」。
 *
 * 威胁模型（必须写清楚，否则容易被误解为「万能保险」）：
 * - 防的是：**数据库文件被单独拷走**（备份包、误传、同机其它进程只拿到 sd.db）。
 *   拷走 sd.db 拿不到明文，因为密钥不在库里。
 * - 不防的是：**本机已被攻破**（攻击者能读 `.keys/platform.key` 就等价于拿到明文）。
 *   单机产品的密钥保护上限止于此，进一步需要 OS 钥匙串/TPM，不在本轮范围。
 * - 明文永不落库、不进日志、不进错误消息，只在主进程内存里短暂存在。
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const HINT_LENGTH = 8

export interface EncryptedSecret {
  enc: Buffer
  iv: Buffer
  tag: Buffer
  /** 明文前 8 位，仅供 UI 显示「已配置 sk-abc123…」，不可用于鉴权 */
  hint: string
}

export class KeyVault {
  private key: Buffer | null = null

  constructor(private keyPath: string) {}

  private loadKey(): Buffer {
    if (this.key) return this.key
    try {
      const raw = fs.readFileSync(this.keyPath)
      if (raw.length === KEY_BYTES) {
        this.key = raw
        return raw
      }
    } catch {
      // 首次运行（文件不存在）或密钥文件损坏 → 落到下面重新生成
    }
    const key = randomBytes(KEY_BYTES)
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true })
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 })
    try {
      // Windows 上 chmod 语义有限（只影响只读位），失败不阻断——权限收敛是尽力而为
      fs.chmodSync(this.keyPath, 0o600)
    } catch { /* 忽略 */ }
    this.key = key
    return key
  }

  encrypt(plaintext: string): EncryptedSecret {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.loadKey(), iv)
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return { enc, iv, tag: cipher.getAuthTag(), hint: plaintext.slice(0, HINT_LENGTH) }
  }

  /** 解密失败（密钥文件被换、密文损坏）会抛错，调用方应转成可读提示让用户重新填写密钥 */
  decrypt(enc: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = createDecipheriv(ALGORITHM, this.loadKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  }
}

/** `sk-…abcd` 形式的展示掩码：只有前缀（库里只存前 8 位），绝不含完整明文 */
export function maskHint(hint: string | null | undefined): string {
  if (!hint) return ''
  return `${hint}…`
}
