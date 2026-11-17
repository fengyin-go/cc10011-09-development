/**
 * 漏触发补偿全链路逻辑测试（node 直接运行，不走浏览器）。
 * 用内存对象模拟 localStorage，验证：cron 展开、窗口比对、恢复幂等、冲突两种判定、
 * 补跑入队/失败重试、归档生命周期、任务编排只回队不重复建单。
 */
import { rmSync } from 'node:fs'

const store = new Map<string, string>()
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
}

const { parseCron, expandWindows, parseEffectivePeriod, parseWindowStart, toLocalISO, isCronValid } = await import(
  '../src/domain/cron'
)
const { evaluateMissedWindows, buildDisabledIntervals } = await import('../src/domain/missed-window')
const service = await import('../src/api/local-service')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

const now = new Date(2026, 10, 17, 12, 0, 0) // 2026-11-17 12:00 本地时间

// --- 1. cron 解析与展开 -----------------------------------------------------
console.log('cron 解析与时间窗展开')
const cron = parseCron('0 8,14,20 * * *')
check('每天 3 个触发时刻', cron.hour.join(',') === '8,14,20')
const hits = expandWindows(new Date(2026, 10, 16), new Date(2026, 10, 17), cron)
check('单日展开 3 个窗口', hits.length === 3, `got ${hits.length}`)
check('窗口时刻正确', toLocalISO(hits[1]) === '2026-11-16T14:00:00')

const stepCron = parseCron('*/30 9-10 * * 1-5')
const stepHits = expandWindows(new Date(2026, 10, 16), new Date(2026, 10, 17), stepCron) // 2026-11-16 周一
check('步长+区间+周限定', stepHits.length === 4 && toLocalISO(stepHits[0]) === '2026-11-16T09:00:00', `got ${stepHits.length}`)
const sundayHits = expandWindows(new Date(2026, 10, 15), new Date(2026, 10, 16), stepCron) // 周日不触发
check('周日不命中工作日表达式', sundayHits.length === 0)

const dowCron = parseCron('0 0 15 * 1') // 日月与周同时受限，取并集
const dowHits = expandWindows(new Date(2026, 10, 1), new Date(2026, 10, 30), dowCron)
check('日月与周并集语义', dowHits.length >= 4, `got ${dowHits.length}`)

// --- 2. 生效时段与停用区间 ---------------------------------------------------
console.log('生效时段与停用区间')
const period = parseEffectivePeriod('2026-11-01~2026-11-30')
check('生效时段终点为次日零点', period.toExclusive.getDate() === 1 && period.toExclusive.getMonth() === 11)
const intervals = buildDisabledIntervals(
  [
    { ruleCode: 'R1', kind: 'disable', at: '2026-11-15T08:00:00', operator: 'a' },
    { ruleCode: 'R1', kind: 'enable', at: '2026-11-16T20:00:00', operator: 'a' },
  ],
  'R1',
  now,
)
check('停用区间配对', intervals.length === 1 && intervals[0].to?.getDate() === 16)
const openIntervals = buildDisabledIntervals(
  [{ ruleCode: 'R2', kind: 'disable', at: '2026-11-15T08:00:00', operator: 'a' }],
  'R2',
  now,
)
check('未恢复区间开放到 now', openIntervals.length === 1 && openIntervals[0].to?.getTime() === now.getTime())

// --- 3. 引擎窗口判定 ---------------------------------------------------------
console.log('漏触发窗口判定')
const rule = {
  ruleCode: 'SCHE-0002',
  site: '站点X',
  cronExpression: '0 8,14,20 * * *',
  effectivePeriod: '2026-11-01~2026-11-30',
  events: [{ ruleCode: 'SCHE-0002', kind: 'disable' as const, at: '2026-11-15T08:00:00', operator: '周岚' }],
  batches: [],
  spiderJobs: [],
  now,
}
const missed = evaluateMissedWindows(rule)
// 15日 08:00（停用时刻）、14:00、20:00；16日 08:00、14:00、20:00；17日 08:00（12:00 前）
check('停用开放区间识别 7 个漏窗', missed.length === 7, `got ${missed.length}: ${missed.map((w) => toLocalISO(w.windowStart)).join(',')}`)
check('全部判定为待补偿', missed.every((w) => w.verdict === 'compensation-needed'))

const covered = evaluateMissedWindows({
  ...rule,
  spiderJobs: [
    { id: 9, 作业编号: 'SPID-X', 来源规则编号: 'SCHE-0002', 时间窗起点: '2026-11-16T08:00:00', 作业来源: '普通调度' },
  ],
})
check('已有作业窗口判为 covered-spider', covered.some((w) => w.verdict === 'covered-spider' && w.spiderCode === 'SPID-X'))

const conflict = evaluateMissedWindows({
  ...rule,
  batches: [
    { id: 1, 补偿批次编号: 'COMP-X', 规则编号: 'SCHE-0002', 时间窗起点: '2026-11-16T08:00:00', 批次来源: '人工补采', status: '待执行' },
  ],
})
check('人工批次窗口判为冲突待判定', conflict.some((w) => w.verdict === 'batch-pending-conflict'))

const manualEnded = evaluateMissedWindows({
  ...rule,
  batches: [
    { id: 1, 补偿批次编号: 'COMP-X', 规则编号: 'SCHE-0002', 时间窗起点: '2026-11-16T08:00:00', 批次来源: '人工补采', status: '已结束' },
  ],
})
check('人工已结束窗口判为 covered-manual', manualEnded.some((w) => w.verdict === 'covered-manual'))

// --- 4. 服务层：恢复 + 幂等 ---------------------------------------------------
console.log('规则恢复与幂等写入')
// 恢复前先登记一个人工补采窗口：恢复时它与规则补偿命中同一窗口，进入冲突待判定
const preRecoveryManual = service.registerManualCatchup('SCHE-0002', '2026-11-15T14:00:00', '调度员-周岚')
check('恢复前登记人工补采成功', preRecoveryManual.ok, preRecoveryManual.message)
const first = service.recoverRule('SCHE-0002', '调度员-周岚')
check('恢复创建 5 个补偿批次（2 个人工窗口跳过）', first.createdBatches.length === 5, `got ${first.createdBatches.length}`)
check('恢复识别 2 个冲突窗口', first.conflicts.length === 2, `got ${first.conflicts.length}`)
check('恢复写入 enable 事件', service.listLifecycleEvents('SCHE-0002').filter((e) => e.kind === 'enable').length === 1)
check('新建补偿批次初始均为缺失态', service
  .listEntries('compensation').items
  .filter((r) => first.createdBatches.includes(String(r['补偿批次编号'])))
  .every((r) => String(r.status) === '缺失'))

const second = service.recoverRule('SCHE-0002', '调度员-周岚')
check('重复恢复不重复补同一窗口', second.createdBatches.length === 0, `got ${second.createdBatches.length}`)
check('重复恢复仍保留 2 个冲突提示', second.conflicts.length === 2)
// 经调度动作把规则置回已启用后，再核对不应再落恢复事件
const enableEventsBefore = service.listLifecycleEvents('SCHE-0002').filter((e) => e.kind === 'enable').length
const scheduleRow = service.listEntries('schedule').items.find((r) => String(r['规则编号']) === 'SCHE-0002')!
service.runAction('schedule', Number(scheduleRow.id), '启用调度')
service.recoverRule('SCHE-0002', '调度员-周岚')
const enableEventsAfter = service.listLifecycleEvents('SCHE-0002').filter((e) => e.kind === 'enable').length
check('规则已启用后核对不产生重复恢复事件', enableEventsAfter === enableEventsBefore)

const compRows = service.listEntries('compensation').items
check('同规则同窗口批次唯一', new Set(compRows.map((r) => String(r['时间窗起点']))).size === compRows.length)
check('复核依据固定', compRows.every((r) => String(r['复核依据']).length > 0))

// --- 5. 冲突判定两种做法 -----------------------------------------------------
console.log('冲突归属判定')
const manualBatch = compRows.find((r) => String(r['批次来源']) === '人工补采' && String(r['冲突处理']) === '待判定')!
check('种子人工批次处于待判定', !!manualBatch)
const blocked = service.enqueueCompensationBatch(Number(manualBatch.id))
check('冲突待判定批次禁止补跑入队', !blocked.ok && blocked.message.includes('冲突归属待判定'))

// 5a. 规则恢复接管
const takeoverRule = service.resolveConflictByRuleTakeover(Number(manualBatch.id), '调度员-周岚')
check('规则接管成功', takeoverRule.ok, takeoverRule.message)
const afterRule = service.listEntries('compensation').items
const endedManual = afterRule.find((r) => Number(r.id) === Number(manualBatch.id))!
check('人工批次结束并留证', String(endedManual.status) === '已结束' && String(endedManual['冲突处理']) === '规则恢复接管')
const newRuleBatch = afterRule.find((r) => String(r['冲突处理']) === '规则恢复接管' && String(r['批次来源']) === '规则恢复')!
check('同窗口生成新的规则恢复批次', !!newRuleBatch && String(newRuleBatch['时间窗起点']) === '2026-11-16T08:00:00')
check('同一窗口仍只有一个活动批次', afterRule.filter((r) => String(r['时间窗起点']) === '2026-11-16T08:00:00' && String(r.status) !== '已结束').length === 1)
const repeatRule = service.resolveConflictByRuleTakeover(Number(manualBatch.id))
check('冲突不可重复判定', !repeatRule.ok)

// 5b. 人工接管：使用恢复前登记、恢复后进入冲突待判定的人工批次
const regRow = service.listEntries('compensation').items.find((r) => String(r['时间窗起点']) === '2026-11-15T14:00:00' && String(r['批次来源']) === '人工补采')!
check('恢复前登记的人工批次进入冲突待判定', !!regRow && String(regRow['冲突处理']) === '待判定')
const takeoverManual = service.resolveConflictByManualTakeover(Number(regRow.id), '调度员-周岚')
check('人工接管成功', takeoverManual.ok, takeoverManual.message)
const afterManual = service.listEntries('compensation').items.find((r) => Number(r.id) === Number(regRow.id))!
check('人工批次保留且标记人工接管', String(afterManual['冲突处理']) === '人工补采接管')
check('人工接管后规则侧无同窗口新批次', service.listEntries('compensation').items.filter((r) => String(r['时间窗起点']) === '2026-11-15T14:00:00').length === 1)
const dupManual = service.registerManualCatchup('SCHE-0002', '2026-11-15T14:00:00', '调度员-周岚')
check('人工登记同窗口幂等拒绝', !dupManual.ok)

// --- 6. 补跑入队 + 失败重试 + 归档 -------------------------------------------
console.log('补跑入队、重试与生命周期')
const target = service.listEntries('compensation').items.find((r) => String(r.status) === '缺失')!
const enq = service.enqueueCompensationBatch(Number(target.id))
check('补跑入队成功', enq.ok, enq.message)
const queuedBatch = service.listEntries('compensation').items.find((r) => Number(r.id) === Number(target.id))!
check('批次进入待执行', String(queuedBatch.status) === '待执行')
check('数据凭据已留存', String(queuedBatch['数据凭据']).startsWith('凭据-EVID-'))
const spiderAfterEnq = service.listEntries('spider').items
const linked = spiderAfterEnq.find((r) => String(r['作业编号']) === String(queuedBatch['关联作业编号']))!
check('补跑作业进入待执行队列', !!linked && String(linked.status) === '待执行')
check('作业来源为规则恢复补跑', String(linked['作业来源']) === '规则恢复补跑')
check('作业带来源规则与时间窗', String(linked['来源规则编号']) === 'SCHE-0002' && String(linked['时间窗起点']) === String(queuedBatch['时间窗起点']))

// 模拟编排失败后重试
const beforeRetry = service.listEntries('spider').items.length
const retry = service.enqueueCompensationBatch(Number(target.id))
check('失败重试成功', retry.ok, retry.message)
check('重试不重复创建作业', service.listEntries('spider').items.length === beforeRetry)
const retriedJob = service.listEntries('spider').items.find((r) => Number(r.id) === Number(linked.id))!
check('重试作业回到待执行', String(retriedJob.status) === '待执行')
const evidenceText = String(service.listEntries('compensation').items.find((r) => Number(r.id) === Number(target.id))!['变更证据'])
check('证据链保留上一份确认记录', evidenceText.includes('由规则恢复生成唯一补偿批次') && evidenceText.includes('编排失败重试'))

const archive = service.archiveCompensationBatch(Number(target.id))
check('归档成功', archive.ok, archive.message)
const archived = service.listEntries('compensation').items.find((r) => Number(r.id) === Number(target.id))!
check('批次到达已归档末态', String(archived.status) === '已归档' && archived.pending === false)
const reEnqArchived = service.enqueueCompensationBatch(Number(target.id))
check('归档后不能再入队', !reEnqArchived.ok)

// --- 7. 调度动作联动 ---------------------------------------------------------
console.log('调度停用/恢复动作联动')
// 找一条已启用规则做停用
const enabledRule = service.listEntries('schedule').items.find((r) => String(r.status) === '已启用')!
const disable = service.runScheduleAction(Number(enabledRule.id), '停用调度', '调度员-周岚')
check('停用成功并记录事件', disable.ok && service.listLifecycleEvents(String(enabledRule['规则编号'])).some((e) => e.kind === 'disable'))
const disableAgain = service.runScheduleAction(Number(enabledRule.id), '停用调度')
check('非启用态停用被拒绝', !disableAgain.ok)
const recover = service.runScheduleAction(Number(enabledRule.id), '启用调度', '调度员-周岚')
check('恢复动作成功', recover.ok, recover.message)
const recoveredRule = service.listEntries('schedule').items.find((r) => Number(r.id) === Number(enabledRule.id))!
check('规则恢复后回到已启用', String(recoveredRule.status) === '已启用')

// --- 8. 任务编排普通动作不产生补偿作业 ---------------------------------------
console.log('普通调度动作隔离')
const normalJob = service.listEntries('spider').items.find((r) => String(r['作业来源']) === '普通调度')!
const beforeCount = service.listEntries('spider').items.length
service.runAction('spider', Number(normalJob.id), '提交执行')
check('普通动作不新增作业', service.listEntries('spider').items.length === beforeCount)
check('普通作业保持普通调度来源', String(service.listEntries('spider').items.find((r) => Number(r.id) === Number(normalJob.id))!['作业来源']) === '普通调度')

// --- 9. 人工补采与规则恢复同窗口的完整冲突流（规则恢复先建批次场景） ----------
console.log('规则补偿先行时人工登记被拒绝')
const ruleOnlyWindow = service
  .listEntries('compensation')
  .items.find((r) => String(r['批次来源']) === '规则恢复' && String(r.status) === '缺失')!
check('存在规则恢复待补批次', !!ruleOnlyWindow)
const manualAttempt = service.registerManualCatchup(String(ruleOnlyWindow['规则编号']), String(ruleOnlyWindow['时间窗起点']), '调度员-周岚')
check('规则补偿已承接窗口拒绝人工登记', !manualAttempt.ok && manualAttempt.message.includes('冲突判定'))

// --- 10. 输入校验 ------------------------------------------------------------
console.log('输入校验')
let threw = false
try {
  parseCron('0 9 * *')
} catch {
  threw = true
}
check('非 5 段表达式抛错', threw)
check('合法表达式探测', isCronValid('30 9 * * 1-5'))
check('非法表达式探测', !isCronValid('99 9 * * *'))
threw = false
try {
  parseWindowStart('not-a-date')
} catch {
  threw = true
}
check('时间窗起点格式校验', threw)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
rmSync('/tmp/tstest', { recursive: true, force: true })
if (failed > 0) {
  process.exit(1)
}
