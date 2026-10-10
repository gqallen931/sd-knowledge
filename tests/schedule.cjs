/**
 * S2-02 日程管理（提醒）：集成测试
 * 覆盖：create 校验（标题/时间/任务关联/重复规则回落）、claimDue 到点领取
 * 与重复规则顺延、dismiss / remove 及对不存在条目的返回值。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now() + '-schedule')
  fs.mkdirSync(root, { recursive: true })
  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })

  // 关联任务：先造分组与任务
  const groupId = Number(r.db.prepare("INSERT INTO task_groups (name) VALUES ('测试分组')").run().lastInsertRowid)
  r.db.prepare("INSERT INTO tasks (code, group_id, name) VALUES ('T-1001', ?, '示例任务')").run(groupId)

  // —— create 校验 ——
  assert.throws(() => r.reminders.create({ title: '  ', remindAt: new Date().toISOString() }), /提醒标题不能为空/)
  assert.throws(() => r.reminders.create({ title: 'x'.repeat(121), remindAt: new Date().toISOString() }), /提醒标题不能超过120个字符/)
  assert.throws(() => r.reminders.create({ title: '合法', remindAt: 'not-a-date' }), /提醒时间无效/)
  assert.throws(() => r.reminders.create({ title: '合法', remindAt: new Date().toISOString(), taskCode: 'T-NOPE' }), /任务不存在/)
  assert.throws(() => r.reminders.create({ title: '合法', remindAt: new Date().toISOString(), taskCode: 'x'.repeat(41) }), /任务编号不能超过40个字符/)

  // —— 创建：非法重复规则回落 none；任务关联成功 ——
  const oneOff = r.reminders.create({ title: '一次性提醒', remindAt: new Date(Date.now() - 3600_000).toISOString(), repeatRule: 'monthly' })
  assert.equal(oneOff.repeatRule, 'none', '白名单外的重复规则应回落 none')
  assert.equal(oneOff.status, 'pending')
  const linked = r.reminders.create({ title: '任务提醒', remindAt: new Date(Date.now() - 60_000).toISOString(), repeatRule: 'daily', taskCode: 'T-1001' })
  assert.equal(linked.taskCode, 'T-1001')

  assert.equal(r.reminders.list().length, 2)

  // —— claimDue：到期领取 → 一次性转 notified；重复规则顺延回 pending ——
  const now = new Date()
  const fired = r.reminders.claimDue(now)
  assert.equal(fired.length, 2)
  const after = Object.fromEntries(r.reminders.list().map(x => [x.id, x]))
  assert.equal(after[oneOff.id].status, 'notified')
  assert.ok(after[oneOff.id].notifiedAt)
  assert.equal(after[linked.id].status, 'pending', 'daily 提醒领取后应顺延到下一天')
  assert.ok(new Date(after[linked.id].remindAt).getTime() > now.getTime())

  // 未到点不重复触发
  assert.equal(r.reminders.claimDue(new Date(now.getTime() + 60_000)).length, 0)

  // —— dismiss / remove ——
  assert.equal(r.reminders.dismiss(oneOff.id), true)
  assert.equal(r.reminders.list().find(x => x.id === oneOff.id).status, 'dismissed')
  assert.equal(r.reminders.dismiss(99999), false)
  assert.equal(r.reminders.remove(linked.id), true)
  assert.equal(r.reminders.remove(99999), false)
  assert.equal(r.reminders.list().length, 1)

  console.log('schedule 集成测试通过')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
