/**
 * 本机账户认证流程：邮箱 / 手机号注册、登录熔断、找回密码、验证码防刷、会话吊销、发送通道。
 *
 * 时钟与验证码发送器全部可注入：冷却、过期、熔断用假时钟推进，不依赖真实等待。
 * webhook 通道用本机 HTTP 服务真实投递一次。数据落 .verification 临时目录，不触碰 Data/ 下的真实库。
 */
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')
const {
  AuthService,
  normalizeContact,
  maskContact,
  createContactSenderFromEnv,
} = require('../dist-electron/services/workbench/authService')

const SEC = 1000
const MIN = 60 * SEC

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'auth-flow-' + Date.now())
  const r = await createRuntime(path.join(root, 'Data'))
  const db = r.db

  let clock = Date.parse('2026-10-09T10:00:00Z')
  const now = () => clock
  const outbox = []
  let failNextSend = null
  const sender = {
    send: async (delivery) => {
      if (failNextSend) {
        const error = failNextSend
        failNextSend = null
        throw error
      }
      outbox.push(delivery)
    },
  }
  const auth = new AuthService(db, { sender, now })
  const lastCode = () => outbox[outbox.length - 1].code
  /** 必定不同于原码的错误码 */
  const wrongCode = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0')
  const sentTo = (contact) => outbox.filter((delivery) => delivery.contact === contact).length

  let passed = 0
  async function check(name, fn) {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  }

  await check('联系方式归一化与掩码', () => {
    assert.deepEqual(normalizeContact(' Alice.Li@Example.COM '), { type: 'email', value: 'alice.li@example.com' })
    assert.deepEqual(normalizeContact('+86 138-0013-8000'), { type: 'phone', value: '13800138000' })
    assert.deepEqual(normalizeContact('8613800138000'), { type: 'phone', value: '13800138000' })
    for (const bad of ['', 'abc', '12345', '10800138000', '23800138000', 'a@b', 'a@b.c', `${'x'.repeat(250)}@a.com`]) {
      assert.throws(() => normalizeContact(bad), /邮箱|手机号/, `应拒绝 ${bad}`)
    }
    assert.equal(maskContact('email', 'alice@example.com'), 'al***@example.com')
    assert.equal(maskContact('phone', '13800138000'), '138****8000')
  })

  await check('邮箱注册：验证码发送、错码计数、正确注册即登录（首个账户为所有者）', async () => {
    const receipt = await auth.requestCode({ purpose: 'register', contact: 'alice@example.com' })
    assert.deepEqual(receipt, { accepted: true, cooldownSeconds: 60, expiresInSeconds: 600 })
    assert.equal(outbox.length, 1)
    assert.match(lastCode(), /^\d{6}$/)
    assert.throws(() => auth.register('c1', { contact: 'alice@example.com', code: wrongCode(lastCode()), password: 'alice2026' }), /还可尝试 4 次/)
    const user = auth.register('c1', { contact: 'alice@example.com', code: lastCode(), password: 'alice2026', displayName: '  爱丽丝 ' })
    assert.equal(user.role, 'owner')
    assert.equal(user.displayName, '爱丽丝')
    assert.equal(user.contactType, 'email')
    assert.equal(user.maskedContact, 'al***@example.com')
    assert.equal(auth.status('c1').authenticated, true)
  })

  await check('手机号注册：+86 与分隔符归一，后续可用任意写法登录，后注册者为成员', async () => {
    await auth.requestCode({ purpose: 'register', contact: '+86 138-0013-8001' })
    const user = auth.register('c2', { contact: '13800138001', code: lastCode(), password: 'phone2026' })
    assert.equal(user.role, 'member')
    assert.equal(user.maskedContact, '138****8001')
    assert.equal(auth.login('c3', { account: '+86 138 0013 8001', password: 'phone2026' }).id, user.id)
  })

  await check('密码规则：长度、字母数字、空白、不得与联系方式相同（失败不消耗验证码）', async () => {
    await auth.requestCode({ purpose: 'register', contact: 'ab1cd2@mail.com' })
    const attempts = () => db.prepare("SELECT attempts FROM verification_codes WHERE contact = 'ab1cd2@mail.com' ORDER BY id DESC LIMIT 1").get().attempts
    for (const bad of ['short1', 'allletters', '12345678', 'has space1']) {
      assert.throws(() => auth.register('h1', { contact: 'ab1cd2@mail.com', code: lastCode(), password: bad }), /密码/)
    }
    assert.throws(() => auth.register('h1', { contact: 'ab1cd2@mail.com', code: lastCode(), password: 'AB1CD2@MAIL.COM' }), /不能与邮箱或手机号相同/)
    assert.equal(attempts(), 0)
    assert.equal(auth.register('h1', { contact: 'ab1cd2@mail.com', code: lastCode(), password: 'okpass123' }).contactType, 'email')
  })

  await check('入参校验：用途、联系方式、验证码格式', async () => {
    await assert.rejects(auth.requestCode({ purpose: 'admin', contact: 'alice@example.com' }), /不支持的验证用途/)
    await assert.rejects(auth.requestCode({ purpose: 'register', contact: 'not-an-email' }), /请输入正确的邮箱或 11 位/)
    assert.throws(() => auth.resetPassword({ contact: 'alice@example.com', code: '12345', newPassword: 'newpass123', confirmPassword: 'newpass123' }), /6 位数字/)
  })

  await check('已注册的联系方式不可再次注册（注册场景明确告知）', async () => {
    await assert.rejects(auth.requestCode({ purpose: 'register', contact: 'alice@example.com' }), /已注册/)
    assert.throws(() => auth.register('x9', { contact: 'alice@example.com', code: '000000', password: 'alice2026' }), /已注册/)
  })

  await check('发送冷却：60 秒内重复申请被拒，满 60 秒后可再次获取', async () => {
    await auth.requestCode({ purpose: 'register', contact: 'bob@example.com' })
    await assert.rejects(auth.requestCode({ purpose: 'register', contact: 'bob@example.com' }), /请 \d+ 秒后再试/)
    clock += 61 * SEC
    await auth.requestCode({ purpose: 'register', contact: 'bob@example.com' })
    assert.equal(sentTo('bob@example.com'), 2)
  })

  await check('每日上限：同一联系方式 24 小时内最多 10 次，跨日恢复', async () => {
    const carol = 'carol@example.com'
    for (let i = 0; i < 10; i += 1) {
      clock += 61 * SEC
      await auth.requestCode({ purpose: 'register', contact: carol })
    }
    clock += 61 * SEC
    await assert.rejects(auth.requestCode({ purpose: 'register', contact: carol }), /今日.*上限/)
    clock += 24 * 60 * MIN
    await auth.requestCode({ purpose: 'register', contact: carol })
    assert.equal(sentTo(carol), 11)
  })

  await check('新码使旧码失效；验证码 10 分钟后过期；过期后可重新获取', async () => {
    const dave = 'dave@example.com'
    await auth.requestCode({ purpose: 'register', contact: dave })
    const oldCode = lastCode()
    clock += 61 * SEC
    await auth.requestCode({ purpose: 'register', contact: dave })
    const newCode = lastCode()
    if (newCode === oldCode) throw new Error('验证码碰撞（概率约 1e-6），重跑即可')
    assert.throws(() => auth.register('d1', { contact: dave, code: oldCode, password: 'dave2026' }), /还可尝试 4 次/)
    clock += 11 * MIN
    assert.throws(() => auth.register('d1', { contact: dave, code: newCode, password: 'dave2026' }), /已过期/)
    clock += 61 * SEC
    await auth.requestCode({ purpose: 'register', contact: dave })
    assert.equal(auth.register('d1', { contact: dave, code: lastCode(), password: 'dave2026' }).contactType, 'email')
  })

  await check('错码熔断：1 小时内累计错误 15 次后暂停发送与校验，窗口滚出后恢复', async () => {
    const eve = 'eve@example.com'
    for (let round = 0; round < 3; round += 1) {
      clock += 61 * SEC
      await auth.requestCode({ purpose: 'register', contact: eve })
      for (let i = 0; i < 5; i += 1) {
        assert.throws(() => auth.register('e1', { contact: eve, code: wrongCode(lastCode()), password: 'eve20261' }), /验证码错误/)
      }
    }
    clock += 61 * SEC
    await assert.rejects(auth.requestCode({ purpose: 'register', contact: eve }), /1 小时后再试/)
    assert.throws(() => auth.register('e1', { contact: eve, code: lastCode(), password: 'eve20261' }), /1 小时后再试/)
    clock += 61 * MIN
    await auth.requestCode({ purpose: 'register', contact: eve })
  })

  await check('找回密码：不存在的账户同样受理但不发送；错误不一致不消耗验证码；成功后旧码作废、会话吊销', async () => {
    const ghost = await auth.requestCode({ purpose: 'reset', contact: 'nobody@example.com' })
    assert.deepEqual(ghost, { accepted: true, cooldownSeconds: 60, expiresInSeconds: 600 })
    assert.equal(sentTo('nobody@example.com'), 0)
    assert.throws(() => auth.resetPassword({ contact: 'nobody@example.com', code: '123456', newPassword: 'newpass123', confirmPassword: 'newpass123' }), /已过期或不存在/)

    auth.login('alice-other', { account: 'alice@example.com', password: 'alice2026' })
    await auth.requestCode({ purpose: 'reset', contact: 'alice@example.com' })
    const resetCode = lastCode()
    assert.throws(() => auth.resetPassword({ contact: 'alice@example.com', code: resetCode, newPassword: 'newpass123', confirmPassword: 'newpass124' }), /两次输入的新密码不一致/)
    assert.equal(auth.resetPassword({ contact: 'alice@example.com', code: resetCode, newPassword: 'newpass123', confirmPassword: 'newpass123' }), true)
    assert.throws(() => auth.requireSession('alice-other'), /AUTH_REQUIRED/)
    assert.throws(() => auth.login('x1', { account: 'alice@example.com', password: 'alice2026' }), /账号或密码错误/)
    assert.equal(auth.login('x1', { account: 'alice@example.com', password: 'newpass123' }).contactType, 'email')
    assert.throws(() => auth.resetPassword({ contact: 'alice@example.com', code: resetCode, newPassword: 'newpass999', confirmPassword: 'newpass999' }), /已过期或不存在/)
  })

  await check('登录熔断：连续 5 次错误锁定 5 分钟，锁定期内正确密码也拒绝，到期自动解除', () => {
    for (let i = 0; i < 5; i += 1) {
      assert.throws(() => auth.login('l1', { account: 'alice@example.com', password: 'wrong1234' }), /账号或密码错误/)
    }
    assert.throws(() => auth.login('l1', { account: 'alice@example.com', password: 'newpass123' }), /登录失败次数过多/)
    clock += 5 * MIN + SEC
    assert.equal(auth.login('l1', { account: 'alice@example.com', password: 'newpass123' }).contactType, 'email')
  })

  await check('修改密码：需当前密码；成功后其它设备会话失效，本设备保持登录', () => {
    auth.login('phone-a', { account: '13800138001', password: 'phone2026' })
    auth.login('phone-b', { account: '13800138001', password: 'phone2026' })
    assert.throws(() => auth.changePassword('phone-a', { currentPassword: 'bad', newPassword: 'phone2027' }), /当前密码错误/)
    assert.throws(() => auth.changePassword('phone-a', { currentPassword: 'phone2026', newPassword: 'phone2026' }), /不能与当前密码相同/)
    assert.equal(auth.changePassword('phone-a', { currentPassword: 'phone2026', newPassword: 'phone2027' }), true)
    assert.equal(auth.status('phone-a').authenticated, true)
    assert.equal(auth.status('phone-b').authenticated, false)
  })

  await check('发送失败：删除本次验证码且不占用冷却，立即重试可成功', async () => {
    failNextSend = new Error('验证码发送失败（网关返回 HTTP 503），请稍后重试')
    await assert.rejects(auth.requestCode({ purpose: 'register', contact: 'frank@example.com' }), /503/)
    await auth.requestCode({ purpose: 'register', contact: 'frank@example.com' })
    assert.equal(sentTo('frank@example.com'), 1)
    const rows = db.prepare("SELECT COUNT(*) AS n FROM verification_codes WHERE contact = 'frank@example.com'").get()
    assert.equal(Number(rows.n), 1)
  })

  await check('并发申请：同一联系方式的两个并发请求只有一个成功', async () => {
    const results = await Promise.allSettled([
      auth.requestCode({ purpose: 'register', contact: 'gina@example.com' }),
      auth.requestCode({ purpose: 'register', contact: 'gina@example.com' }),
    ])
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected'])
    assert.equal(sentTo('gina@example.com'), 1)
  })

  await check('发送通道：未配置明确失败；webhook 只接受 https 或本机 http', async () => {
    const message = { purpose: 'register', contactType: 'email', contact: 'a@b.com', code: '000000', expiresInMinutes: 10 }
    await assert.rejects(createContactSenderFromEnv({}).send(message), /验证码发送通道未配置/)
    const insecure = createContactSenderFromEnv({ SD_CODE_SENDER: 'webhook', SD_CODE_WEBHOOK_URL: 'http://api.example.com/send' })
    await assert.rejects(insecure.send(message), /必须是 https/)
    // 未配置 / 配置非法时注册入口给出可读错误，而不是静默假装已发送
    const unconfigured = new AuthService(db, { sender: createContactSenderFromEnv({}), now })
    await assert.rejects(unconfigured.requestCode({ purpose: 'register', contact: 'hal@example.com' }), /验证码发送通道未配置/)
  })

  await check('webhook 通道：投递 JSON 并携带 Bearer 令牌；网关 5xx 视为发送失败', async () => {
    const received = []
    let status = 200
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        received.push({ authorization: req.headers.authorization, body: JSON.parse(body) })
        res.writeHead(status).end()
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/send`
    const webhook = createContactSenderFromEnv({ SD_CODE_SENDER: 'webhook', SD_CODE_WEBHOOK_URL: url, SD_CODE_WEBHOOK_TOKEN: 't0ken' })
    const message = { purpose: 'reset', contactType: 'phone', contact: '13800138000', code: '123456', expiresInMinutes: 10 }
    try {
      await webhook.send(message)
      assert.deepEqual(received[0], { authorization: 'Bearer t0ken', body: message })
      status = 503
      await assert.rejects(webhook.send(message), /HTTP 503/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  await check('审计：注册 / 重置写入 audit_logs，且审计中不出现明文联系方式', () => {
    const rows = db.prepare("SELECT action, actor_name, details FROM audit_logs WHERE actor_type = 'user' AND action IN ('register', 'reset_password')").all()
    assert.ok(rows.some((row) => row.action === 'register'))
    assert.ok(rows.some((row) => row.action === 'reset_password'))
    assert.ok(rows.every((row) => !/alice@example\.com/.test(`${row.actor_name} ${row.details}`)))
  })

  console.log(`PASS: auth-flow（${passed} 项：邮箱/手机号注册、防刷冷却/每日上限/熔断/过期、找回密码与会话吊销、登录锁定、发送通道与 webhook、审计脱敏）`)
  process.exit(0)
}

main().catch((error) => {
  console.error('FAIL: auth-flow', error)
  process.exit(1)
})
