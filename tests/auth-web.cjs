/**
 * 账户认证的 Web 出口端到端：真实启动 dist-electron/webEntry.js（发送通道 = console），
 * 经 /local/rpc 完成「验证码 → 注册 → 冷却 → 登录 → 找回密码 → 新密码登录」全链路。
 * 验证码从子进程日志读取（console 发送器的输出），数据落 .verification 临时目录。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const WEB_PORT = 19030
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`

function startWebServer(dataDir) {
  const child = spawn(process.execPath, [path.join('dist-electron', 'webEntry.js')], {
    cwd: ROOT,
    env: { ...process.env, SD_DATA_PATH: dataDir, SD_WEB_PORT: String(WEB_PORT), SD_CODE_SENDER: 'console' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000
    const poll = async () => {
      try {
        const res = await fetch(`${WEB_BASE}/local/session`)
        if (res.ok) return resolve({ child, getLog: () => log })
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline) return reject(new Error('Web 后端启动超时：\n' + log))
      setTimeout(poll, 250)
    }
    poll()
  })
}

async function sessionToken() {
  const res = await fetch(`${WEB_BASE}/local/session`)
  return (await res.json()).token
}

/** 调用 RPC；业务错误（HTTP 400）统一抛出可读消息 */
async function rpc(token, method, ...args) {
  const res = await fetch(`${WEB_BASE}/local/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SD-Session': token },
    body: JSON.stringify({ method, args }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}

/**
 * 从子进程日志里取最新一条 console 发送器输出的验证码。
 * 子进程 stdout 经管道异步写入，RPC 返回时日志未必已落盘，因此轮询等待（最长 3 秒）。
 */
async function waitForCode(getLog, purpose, contact) {
  const pattern = new RegExp(`\\[verify\\] ${purpose} ${contact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g')
  const deadline = Date.now() + 3000
  for (;;) {
    const matches = [...getLog().matchAll(pattern)]
    if (matches.length > 0) return matches[matches.length - 1][1]
    if (Date.now() > deadline) throw new Error(`日志中找不到 ${purpose} ${contact} 的验证码`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'auth-web-' + Date.now())
  const dataDir = path.join(root, 'Data')
  fs.mkdirSync(dataDir, { recursive: true })
  const { child, getLog } = await startWebServer(dataDir)
  let passed = 0
  const check = async (name, fn) => {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  }

  try {
    const token = await sessionToken()

    await check('未登录：状态为未认证，且 needsSetup（库内无账户）', async () => {
      const status = await rpc(token, 'auth.status')
      assert.equal(status.authenticated, false)
      assert.equal(status.needsSetup, true)
    })

    await check('注册：邮箱 + 验证码 + 密码（未登录即可调用 requestCode）', async () => {
      const receipt = await rpc(token, 'auth.requestCode', { purpose: 'register', contact: 'web@example.com' })
      assert.deepEqual(receipt, { accepted: true, cooldownSeconds: 60, expiresInSeconds: 600 })
      const code = await waitForCode(getLog,'register', 'web@example.com')
      const user = await rpc(token, 'auth.register', { contact: 'web@example.com', code, password: 'web20261', displayName: '网页用户' })
      assert.equal(user.role, 'owner')
      assert.equal(user.maskedContact, 'we***@example.com')
      assert.equal((await rpc(token, 'auth.status')).authenticated, true)
    })

    await check('防刷：已注册邮箱不能再注册；同一联系方式 60 秒内重复申请被拒（HTTP 400 + 可读原因）', async () => {
      await assert.rejects(rpc(token, 'auth.requestCode', { purpose: 'register', contact: 'web@example.com' }), /已注册/)
      await rpc(token, 'auth.requestCode', { purpose: 'register', contact: 'fresh@example.com' })
      await assert.rejects(rpc(token, 'auth.requestCode', { purpose: 'register', contact: 'fresh@example.com' }), /请 \d+ 秒后再试/)
    })

    await check('手机号注册：+86 写法与分隔符归一，登录标识可用任意写法', async () => {
      await rpc(token, 'auth.requestCode', { purpose: 'register', contact: '+86 139-0013-9000' })
      const code = await waitForCode(getLog,'register', '13900139000')
      const user = await rpc(token, 'auth.register', { contact: '13900139000', code, password: 'phone20261' })
      assert.equal(user.role, 'member')
      assert.equal(user.maskedContact, '139****9000')
      await rpc(token, 'auth.logout')
      const again = await rpc(token, 'auth.login', { account: '+86 139 0013 9000', password: 'phone20261' })
      assert.equal(again.id, user.id)
    })

    await check('登录：错误密码给统一文案，正确密码返回用户', async () => {
      await assert.rejects(rpc(token, 'auth.login', { account: 'web@example.com', password: 'wrong20261' }), /账号或密码错误/)
      const user = await rpc(token, 'auth.login', { account: 'web@example.com', password: 'web20261' })
      assert.equal(user.contactType, 'email')
    })

    await check('找回密码：申请验证码 → 错误两次输入被拒 → 凭验证码重置 → 新密码可登录、旧密码失效', async () => {
      await rpc(token, 'auth.requestCode', { purpose: 'reset', contact: 'web@example.com' })
      const code = await waitForCode(getLog,'reset', 'web@example.com')
      await assert.rejects(rpc(token, 'auth.resetPassword', {
        contact: 'web@example.com', code, newPassword: 'reset20262', confirmPassword: 'reset20263',
      }), /两次输入的新密码不一致/)
      assert.equal(await rpc(token, 'auth.resetPassword', {
        contact: 'web@example.com', code, newPassword: 'reset20262', confirmPassword: 'reset20262',
      }), true)
      // 验证码一次性
      await assert.rejects(rpc(token, 'auth.resetPassword', {
        contact: 'web@example.com', code, newPassword: 'reset20264', confirmPassword: 'reset20264',
      }), /已过期或不存在/)
      await rpc(token, 'auth.logout')
      await assert.rejects(rpc(token, 'auth.login', { account: 'web@example.com', password: 'web20261' }), /账号或密码错误/)
      assert.equal((await rpc(token, 'auth.login', { account: 'web@example.com', password: 'reset20262' })).contactType, 'email')
    })

    await check('找回密码对未注册邮箱同样受理（不泄露账户是否存在），且不会真的发出验证码', async () => {
      const before = getLog().split('[verify]').length
      const receipt = await rpc(token, 'auth.requestCode', { purpose: 'reset', contact: 'ghost@example.com' })
      assert.equal(receipt.accepted, true)
      assert.equal(getLog().split('[verify]').length, before)
    })

  } finally {
    child.kill('SIGTERM')
  }
  console.log(`PASS: auth-web（${passed} 项：HTTP 出口的验证码注册、防刷、登录、找回密码全链路）`)
  process.exit(0)
}

main().catch((error) => {
  console.error('FAIL: auth-web', error)
  process.exit(1)
})
