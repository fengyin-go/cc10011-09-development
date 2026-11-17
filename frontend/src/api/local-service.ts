import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  readScheduleState,
  resetRows,
  resetScheduleState,
  saveRows,
  writeScheduleState,
} from '@/data/local-store'
import { evaluateMissedWindows } from '@/domain/missed-window'
import type { MissedWindow } from '@/domain/missed-window'
import { parseCron, parseEffectivePeriod, parseWindowStart, toLocalISO } from '@/domain/cron'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import type { ScheduleLifecycleEvent } from '@/data/seed-schedule-state'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const SCHEDULE_KEY = 'schedule'
const COMPENSATION_KEY = 'compensation'
const SPIDER_KEY = 'spider'
const RULE_RECOVERY_SOURCE = '规则恢复'
const MANUAL_SOURCE = '人工补采'
const RULE_RECOVERY_BASIS = '由规则恢复生成唯一补偿批次'
const DEFAULT_OPERATOR = '值班管理员'

export type RecoveryDetail = {
  ruleCode: string
  recovered: boolean
  createdBatches: string[]
  conflicts: string[]
  skippedWindows: string[]
  windows: MissedWindow[]
  ledgerAt: string
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === SCHEDULE_KEY) {
    resetScheduleState()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 漏触发补偿：调度生命周期、窗口比对、补偿批次写入与冲突归属
// ---------------------------------------------------------------------------

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextBatchCode(rows: EntryRow[]): string {
  return `COMP-${String(rows.length + 1).padStart(4, '0')}`
}

function nextSpiderCode(rows: EntryRow[]): string {
  return `SPID-${String(rows.length + 1).padStart(4, '0')}`
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function findRule(ruleCode: string): EntryRow {
  const rule = listRows(SCHEDULE_KEY).find((row) => String(row['规则编号']) === ruleCode)
  if (!rule) {
    throw new Error(`调度规则 ${ruleCode} 不存在`)
  }
  return rule
}

function appendEvidence(row: EntryRow, line: string): EntryRow {
  const previous = String(row['变更证据'] ?? '')
  return { ...row, 变更证据: previous ? `${previous}\n${line}` : line }
}

function formatInterval(events: ScheduleLifecycleEvent[], ruleCode: string, now: Date): string {
  const timeline = events
    .filter((event) => event.ruleCode === ruleCode)
    .sort((a, b) => a.at.localeCompare(b.at))
  let openFrom: string | null = null
  const segments: string[] = []
  for (const event of timeline) {
    if (event.kind === 'disable') {
      openFrom = event.at
    } else if (event.kind === 'enable' && openFrom) {
      segments.push(`${openFrom} ~ ${event.at}`)
      openFrom = null
    }
  }
  if (openFrom) {
    segments.push(`${openFrom} 起停用（恢复中）`)
  }
  return segments.length > 0 ? segments.join('；') : '无停用区间'
}

function buildMissingBatch(rule: EntryRow, window: MissedWindow, events: ScheduleLifecycleEvent[], now: Date): EntryRow {
  const batches = listRows(COMPENSATION_KEY)
  const stamp = toLocalISO(now)
  return {
    id: nextId(batches),
    status: '缺失',
    pending: true,
    abnormal: false,
    补偿批次编号: nextBatchCode(batches),
    规则编号: window.ruleCode,
    关联站点: window.site,
    调度编排: `编排记录-${window.ruleCode}`,
    时间窗起点: toLocalISO(window.windowStart),
    时间窗终点: toLocalISO(window.windowEnd),
    停用区间: formatInterval(events, window.ruleCode, now),
    批次来源: RULE_RECOVERY_SOURCE,
    来源负责人: '调度系统',
    冲突处理: '无冲突',
    关联作业编号: '',
    变更证据: `${stamp} 规则恢复：比对调度表达式「${String(rule['调度表达式'])}」与生效时段「${String(rule['生效时段'])}」，由规则恢复生成唯一补偿批次`,
    复核依据: RULE_RECOVERY_BASIS,
    数据凭据: '',
  }
}

function saveLifecycleEvents(events: ScheduleLifecycleEvent[]): void {
  writeScheduleState({ lifecycleEvents: events })
}

/** 调度停用/恢复动作：恢复时先核对窗口并写入唯一补偿批次，再把规则置回已启用。 */
export function runScheduleAction(id: number, action: string, operator: string = DEFAULT_OPERATOR): ActionResult & { detail?: RecoveryDetail } {
  const rows = listRows(SCHEDULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的调度规则` }
  }
  const rule = rows[index]
  const ruleCode = String(rule['规则编号'])
  const now = new Date()

  if (action === '停用调度') {
    if (String(rule.status) !== '已启用') {
      return { ok: false, message: `规则 ${ruleCode} 当前为「${rule.status}」，只有已启用规则可以停用` }
    }
    const state = readScheduleState()
    const events = [
      ...state.lifecycleEvents,
      { ruleCode, kind: 'disable' as const, at: toLocalISO(now), operator, note: '调度员手动停用' },
    ]
    saveLifecycleEvents(events)
    const updated: EntryRow = {
      ...rule,
      status: '已停用',
      pending: true,
      abnormal: true,
      漏触发补偿: '停用待补偿',
    }
    const next = [...rows]
    next[index] = updated
    saveRows(SCHEDULE_KEY, next)
    return { ok: true, message: `规则 ${ruleCode} 已停用，停用区间已记入调度编排记录，恢复时自动核对漏触发时间窗` }
  }

  if (action === '启用调度') {
    if (String(rule.status) !== '已停用') {
      return { ok: false, message: `规则 ${ruleCode} 当前为「${rule.status}」，只有已停用规则需要恢复` }
    }
    const summary = recoverRule(ruleCode, operator)
    const refreshed = listRows(SCHEDULE_KEY)
    const targetIndex = refreshed.findIndex((row) => Number(row.id) === id)
    const updated: EntryRow = {
      ...refreshed[targetIndex],
      status: '已启用',
      pending: false,
      abnormal: false,
      漏触发补偿: summary.conflicts.length > 0 ? `恢复完成，${summary.conflicts.length} 个窗口冲突待判定` : '恢复完成，无待补偿窗口',
    }
    const next = [...refreshed]
    next[targetIndex] = updated
    saveRows(SCHEDULE_KEY, next)
    return {
      ok: true,
      message: buildRecoveryMessage(summary),
      detail: summary,
    }
  }

  return runAction(SCHEDULE_KEY, id, action)
}

function buildRecoveryMessage(summary: RecoveryDetail): string {
  const parts: string[] = [
    `规则 ${summary.ruleCode} 已恢复，共核对 ${summary.windows.length} 个停用期时间窗`,
  ]
  if (summary.createdBatches.length > 0) {
    parts.push(`新建补偿批次 ${summary.createdBatches.length} 个（${summary.createdBatches.join('、')}）`)
  }
  if (summary.conflicts.length > 0) {
    parts.push(`冲突待判定 ${summary.conflicts.length} 个（${summary.conflicts.join('、')}）`)
  }
  if (summary.skippedWindows.length > 0) {
    parts.push(`已承接跳过 ${summary.skippedWindows.length} 个`)
  }
  return parts.join('，')
}

function scanRule(ruleCode: string, now: Date): { rule: EntryRow; events: ScheduleLifecycleEvent[]; windows: MissedWindow[] } {
  const rule = findRule(ruleCode)
  parseCron(String(rule['调度表达式']))
  parseEffectivePeriod(String(rule['生效时段']))
  const events = readScheduleState().lifecycleEvents
  const windows = evaluateMissedWindows({
    ruleCode,
    site: String(rule['关联站点'] ?? ''),
    cronExpression: String(rule['调度表达式']),
    effectivePeriod: String(rule['生效时段']),
    events,
    batches: listRows(COMPENSATION_KEY),
    spiderJobs: listRows(SPIDER_KEY),
    now,
  })
  return { rule, events, windows }
}

/** 规则恢复：窗口比对 + 幂等写入。同一规则+时间窗只生成一个补偿批次，重复恢复不会重复补。 */
export function recoverRule(ruleCode: string, operator: string = DEFAULT_OPERATOR): RecoveryDetail {
  const now = new Date()
  const { rule, events, windows } = scanRule(ruleCode, now)
  // 只有规则当前确为停用态时才落恢复事件；重复核对不写重复的调度编排记录。
  const ledgerEvents =
    String(rule.status) === '已停用'
      ? [
          ...events,
          { ruleCode, kind: 'enable' as const, at: toLocalISO(now), operator, note: '规则恢复，触发漏触发补偿核对' },
        ]
      : events
  if (ledgerEvents !== events) {
    saveLifecycleEvents(ledgerEvents)
  }

  const batches = [...listRows(COMPENSATION_KEY)]
  const createdBatches: string[] = []
  const conflicts: string[] = []
  const skippedWindows: string[] = []

  for (const window of windows) {
    const stamp = toLocalISO(window.windowStart)
    if (window.verdict === 'compensation-needed') {
      const batch = buildMissingBatch(rule, window, ledgerEvents, now)
      batches.push(batch)
      createdBatches.push(String(batch['补偿批次编号']))
      continue
    }
    if (window.verdict === 'batch-pending-conflict') {
      conflicts.push(stamp)
      continue
    }
    skippedWindows.push(stamp)
  }
  saveRows(COMPENSATION_KEY, batches)

  return {
    ruleCode,
    recovered: true,
    createdBatches,
    conflicts,
    skippedWindows,
    windows,
    ledgerAt: toLocalISO(now),
  }
}

/** 只核对不写入：调度员查看某条规则当前的漏触发时间窗与补偿承接情况。 */
export function previewMissedWindows(ruleCode: string): MissedWindow[] {
  return scanRule(ruleCode, new Date()).windows
}

export function listLifecycleEvents(ruleCode?: string): ScheduleLifecycleEvent[] {
  const events = readScheduleState().lifecycleEvents
  return ruleCode ? events.filter((event) => event.ruleCode === ruleCode) : events
}

/** 人工补采登记：同窗口同样幂等，若规则补偿已先行则登记被拒绝，归属留给冲突判定。 */
export function registerManualCatchup(
  ruleCode: string,
  windowStartText: string,
  operator: string = DEFAULT_OPERATOR,
): ActionResult {
  const now = new Date()
  const windowStart = parseWindowStart(windowStartText)
  const target = toLocalISO(windowStart)
  const rule = findRule(ruleCode)
  const batches = listRows(COMPENSATION_KEY)
  const existing = batches.find(
    (row) => String(row['规则编号']) === ruleCode && String(row['时间窗起点']) === target,
  )
  if (existing) {
    if (String(existing['批次来源']) === MANUAL_SOURCE && String(existing.status) !== '已结束') {
      return { ok: false, message: `窗口 ${target} 已存在人工补采批次 ${String(existing['补偿批次编号'])}，保留唯一批次不重复登记` }
    }
    return {
      ok: false,
      message: `窗口 ${target} 已由 ${String(existing['批次来源'])}批次 ${String(existing['补偿批次编号'])} 承接，人工补采需走冲突判定`,
    }
  }
  const stamp = toLocalISO(now)
  const batch: EntryRow = {
    id: nextId(batches),
    status: '待执行',
    pending: true,
    abnormal: true,
    补偿批次编号: nextBatchCode(batches),
    规则编号: ruleCode,
    关联站点: String(rule['关联站点'] ?? ''),
    调度编排: `编排记录-${ruleCode}`,
    时间窗起点: target,
    时间窗终点: target,
    停用区间: formatInterval(readScheduleState().lifecycleEvents, ruleCode, now),
    批次来源: MANUAL_SOURCE,
    来源负责人: operator,
    冲突处理: '待判定',
    关联作业编号: '',
    变更证据: `${stamp} ${operator} 登记人工补采，窗口 ${target} 保留唯一批次，等待规则恢复核对归属`,
    复核依据: '人工补采登记',
    数据凭据: `人工补采凭据-MANU-${target.replace(/[-T:]/g, '').slice(0, 12)}`,
  }
  saveRows(COMPENSATION_KEY, [...batches, batch])
  return { ok: true, message: `人工补采批次 ${String(batch['补偿批次编号'])} 已登记，窗口 ${target} 归属待规则恢复时判定` }
}

function findConflictBatch(id: number): EntryRow {
  const batch = findRow(listRows(COMPENSATION_KEY), id)
  if (!batch) {
    throw new Error(`没有找到编号为 ${id} 的漏触发补偿采集批次`)
  }
  if (String(batch['冲突处理']) !== '待判定') {
    throw new Error(`批次 ${String(batch['补偿批次编号'])} 冲突已判定为「${String(batch['冲突处理'])}」，不能重复处理`)
  }
  return batch
}

/** 冲突判定①：由规则恢复生成唯一补偿批次，接管该窗口；人工批次保留为已结束的归属证据。 */
export function resolveConflictByRuleTakeover(id: number, operator: string = DEFAULT_OPERATOR): ActionResult {
  let manual: EntryRow
  try {
    manual = findConflictBatch(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '冲突判定失败' }
  }
  const now = new Date()
  const stamp = toLocalISO(now)
  const batches = listRows(COMPENSATION_KEY)
  const index = batches.findIndex((row) => Number(row.id) === id)
  const ruleCode = String(manual['规则编号'])
  const target = String(manual['时间窗起点'])

  const endedManual = appendEvidence(
    {
      ...manual,
      status: '已结束',
      pending: false,
      abnormal: false,
      冲突处理: '规则恢复接管',
    },
    `${stamp} ${operator} 判定规则恢复接管：人工补采保留唯一批次记录并结束补偿，窗口移交规则恢复批次`,
  )

  const ruleBatch: EntryRow = {
    id: nextId(batches),
    status: '缺失',
    pending: true,
    abnormal: false,
    补偿批次编号: nextBatchCode(batches),
    规则编号: ruleCode,
    关联站点: String(manual['关联站点']),
    调度编排: `编排记录-${ruleCode}`,
    时间窗起点: target,
    时间窗终点: String(manual['时间窗终点']),
    停用区间: String(manual['停用区间']),
    批次来源: RULE_RECOVERY_SOURCE,
    来源负责人: '调度系统',
    冲突处理: '规则恢复接管',
    关联作业编号: '',
    变更证据: `${stamp} ${operator} 冲突判定：由规则恢复生成唯一补偿批次接管窗口 ${target}，人工批次 ${String(manual['补偿批次编号'])} 结束`,
    复核依据: RULE_RECOVERY_BASIS,
    数据凭据: '',
  }

  const next = [...batches]
  next[index] = endedManual
  next.push(ruleBatch)
  saveRows(COMPENSATION_KEY, next)
  return {
    ok: true,
    message: `窗口 ${target} 已由规则恢复批次 ${String(ruleBatch['补偿批次编号'])} 接管，人工批次 ${String(manual['补偿批次编号'])} 结束并保留归属`,
  }
}

/** 冲突判定②：人工补采保留唯一批次并结束补偿，规则侧不再为该窗口补单。 */
export function resolveConflictByManualTakeover(id: number, operator: string = DEFAULT_OPERATOR): ActionResult {
  let manual: EntryRow
  try {
    manual = findConflictBatch(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '冲突判定失败' }
  }
  const now = new Date()
  const stamp = toLocalISO(now)
  const batches = listRows(COMPENSATION_KEY)
  const index = batches.findIndex((row) => Number(row.id) === id)

  const updated = appendEvidence(
    {
      ...manual,
      冲突处理: '人工补采接管',
      复核依据: '人工补采保留唯一批次并结束补偿',
    },
    `${stamp} ${operator} 判定人工补采接管：保留唯一批次 ${String(manual['补偿批次编号'])}，规则恢复放弃该窗口补单`,
  )
  const next = [...batches]
  next[index] = updated
  saveRows(COMPENSATION_KEY, next)
  return {
    ok: true,
    message: `窗口 ${String(manual['时间窗起点'])} 由人工批次 ${String(manual['补偿批次编号'])} 接管，规则侧不再补同一窗口`,
  }
}

function ensureSpiderForBatch(batch: EntryRow, now: Date): { spider: EntryRow; created: boolean } {
  const jobs = listRows(SPIDER_KEY)
  const ruleCode = String(batch['规则编号'])
  const target = String(batch['时间窗起点'])
  const existing = jobs.find(
    (row) => String(row['来源规则编号']) === ruleCode && String(row['时间窗起点']) === target,
  )
  const stamp = toLocalISO(now)
  if (existing) {
    // 编排失败后重试：保留上一份确认记录，只把作业放回待执行队列，不重复创建普通调度作业。
    const requeued: EntryRow = {
      ...existing,
      status: '待执行',
      pending: true,
      abnormal: false,
    }
    const nextJobs = [...jobs]
    nextJobs[jobs.indexOf(existing)] = requeued
    saveRows(SPIDER_KEY, nextJobs)
    return { spider: requeued, created: false }
  }

  const isRule = String(batch['批次来源']) === RULE_RECOVERY_SOURCE
  const job: EntryRow = {
    id: nextId(jobs),
    status: '待执行',
    pending: true,
    abnormal: false,
    作业编号: nextSpiderCode(jobs),
    目标站点: String(batch['关联站点']),
    抽取模板: isRule ? '规则恢复补跑模板' : '人工补采模板',
    起始地址: String(batch['关联站点']),
    并发线程数: 2,
    请求间隔秒: 5,
    每日上限条数: 5000,
    超时秒数: 300,
    作业来源: isRule ? '规则恢复补跑' : MANUAL_SOURCE,
    来源规则编号: ruleCode,
    时间窗起点: target,
    来源负责人: String(batch['来源负责人']),
  }
  saveRows(SPIDER_KEY, [...jobs, job])
  return { spider: job, created: true }
}

/** 缺失 → 待执行：把补跑作业放回任务编排待执行队列，并在批次上沉淀确认记录与本日数据凭据。 */
export function enqueueCompensationBatch(id: number, operator: string = DEFAULT_OPERATOR): ActionResult {
  const now = new Date()
  const stamp = toLocalISO(now)
  const batches = listRows(COMPENSATION_KEY)
  const index = batches.findIndex((row) => Number(row.id) === id)
  const batch = batches[index]
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${id} 的漏触发补偿采集批次` }
  }
  if (!['缺失', '待执行'].includes(String(batch.status))) {
    return { ok: false, message: `批次 ${String(batch['补偿批次编号'])} 当前「${String(batch.status)}」，不能补跑入队` }
  }
  if (String(batch['冲突处理']) === '待判定') {
    return { ok: false, message: `批次 ${String(batch['补偿批次编号'])} 冲突归属待判定，请先完成冲突判定再补跑入队` }
  }

  const { spider, created } = ensureSpiderForBatch(batch, now)
  const evidenceLine = created
    ? `${stamp} ${operator} 补跑入队：作业 ${String(spider['作业编号'])} 回到待执行队列，本日数据凭据已留存`
    : `${stamp} ${operator} 编排失败重试：保留上一份确认记录，作业 ${String(spider['作业编号'])} 重新回到待执行队列`
  const updated = appendEvidence(
    {
      ...batch,
      status: '待执行',
      pending: true,
      abnormal: false,
      关联作业编号: String(spider['作业编号']),
      数据凭据: String(batch['数据凭据']) || `凭据-EVID-${String(batch['时间窗起点']).replace(/[-T:]/g, '').slice(0, 12)}`,
    },
    evidenceLine,
  )
  const next = [...batches]
  next[index] = updated
  saveRows(COMPENSATION_KEY, next)
  return {
    ok: true,
    message: created
      ? `批次 ${String(batch['补偿批次编号'])} 已补跑入队，作业 ${String(spider['作业编号'])} 进入待执行队列`
      : `批次 ${String(batch['补偿批次编号'])} 重试完成，作业 ${String(spider['作业编号'])} 已重新回到待执行队列`,
  }
}

/** 待执行 → 已归档：生命周期末态，保留全部变更证据。 */
export function archiveCompensationBatch(id: number, operator: string = DEFAULT_OPERATOR): ActionResult {
  const now = new Date()
  const stamp = toLocalISO(now)
  const batches = listRows(COMPENSATION_KEY)
  const index = batches.findIndex((row) => Number(row.id) === id)
  const batch = batches[index]
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${id} 的漏触发补偿采集批次` }
  }
  if (String(batch.status) !== '待执行') {
    return { ok: false, message: `批次 ${String(batch['补偿批次编号'])} 当前「${String(batch.status)}」，只有待执行批次可以归档` }
  }
  const updated = appendEvidence(
    {
      ...batch,
      status: '已归档',
      pending: false,
      abnormal: false,
      复核依据: String(batch['复核依据']) || RULE_RECOVERY_BASIS,
    },
    `${stamp} ${operator} 归档批次：补偿采集完成，生命周期结束并保留全部变更证据`,
  )
  const next = [...batches]
  next[index] = updated
  saveRows(COMPENSATION_KEY, next)
  return { ok: true, message: `批次 ${String(batch['补偿批次编号'])} 已归档，窗口补偿闭环` }
}
