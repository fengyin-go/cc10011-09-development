/**
 * 漏触发窗口比对引擎（纯函数）：读取调度表达式、生效时段、停用区间和已生成采集作业/补偿批次，
 * 比对应触发但实际没有承接的调度时间窗，输出每个窗口的判定结论。
 * 本文件不做任何写入，写入与幂等控制由 local-service 的补偿服务负责。
 */

import { expandWindows, parseCron, parseEffectivePeriod, toLocalISO } from './cron'

export type RuleLifecycleEvent = {
  ruleCode: string
  kind: 'disable' | 'enable'
  at: string
  operator: string
  note?: string
}

export type DisabledInterval = {
  ruleCode: string
  from: Date
  to: Date | null
}

export type WindowVerdict =
  | 'compensation-needed'
  | 'batch-pending-conflict'
  | 'covered-compensation'
  | 'covered-manual'
  | 'covered-spider'

export type MissedWindow = {
  ruleCode: string
  site: string
  windowStart: Date
  windowEnd: Date
  verdict: WindowVerdict
  batchId: number | null
  batchCode: string | null
  spiderId: number | null
  spiderCode: string | null
  reason: string
}

type JobLike = {
  id: number
  [field: string]: string | number | boolean
}

export type MissedScanInput = {
  ruleCode: string
  site: string
  cronExpression: string
  effectivePeriod: string
  events: RuleLifecycleEvent[]
  batches: JobLike[]
  spiderJobs: JobLike[]
  now?: Date
  lookbackDays?: number
}

/** 把同一规则的停用/恢复事件配对成停用区间；最后一次停用尚未恢复时区间开放到 now。 */
export function buildDisabledIntervals(events: RuleLifecycleEvent[], ruleCode: string, now: Date): DisabledInterval[] {
  const timeline = events
    .filter((event) => event.ruleCode === ruleCode)
    .map((event) => ({ kind: event.kind, at: new Date(event.at) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  const intervals: DisabledInterval[] = []
  let openFrom: Date | null = null
  for (const event of timeline) {
    if (event.kind === 'disable') {
      openFrom = event.at
    } else if (event.kind === 'enable' && openFrom) {
      intervals.push({ ruleCode, from: openFrom, to: event.at })
      openFrom = null
    }
  }
  if (openFrom) {
    intervals.push({ ruleCode, from: openFrom, to: now })
  }
  return intervals
}

function textOf(row: JobLike, field: string): string {
  return String(row[field] ?? '')
}

function findBatchForWindow(batches: JobLike[], ruleCode: string, windowStart: Date): JobLike | null {
  const target = toLocalISO(windowStart)
  return (
    batches.find(
      (row) => textOf(row, '规则编号') === ruleCode && textOf(row, '时间窗起点') === target,
    ) ?? null
  )
}

function findSpiderForWindow(spiderJobs: JobLike[], ruleCode: string, windowStart: Date): JobLike | null {
  const target = toLocalISO(windowStart)
  return (
    spiderJobs.find(
      (row) =>
        textOf(row, '来源规则编号') === ruleCode &&
        textOf(row, '时间窗起点') === target,
    ) ?? null
  )
}

function classifyBatch(batch: JobLike, windowStart: Date): Pick<MissedWindow, 'verdict' | 'reason' | 'batchId' | 'batchCode'> {
  const status = textOf(batch, 'status')
  const source = textOf(batch, '批次来源')
  const batchId = Number(batch.id)
  const batchCode = textOf(batch, '补偿批次编号')
  if (source === '人工补采') {
    if (status === '已结束') {
      return {
        batchId,
        batchCode,
        verdict: 'covered-manual',
        reason: `窗口已由人工补采批次 ${batchCode} 接管并结束，规则侧不再补单`,
      }
    }
    return {
      batchId,
      batchCode,
      verdict: 'batch-pending-conflict',
      reason: `人工补采批次 ${batchCode} 已承接该窗口，规则恢复补偿与其冲突，需判定唯一归属`,
    }
  }
  if (status === '已结束') {
    return {
      batchId,
      batchCode,
      verdict: 'covered-compensation',
      reason: `规则恢复补偿批次 ${batchCode} 已归档，窗口处理完成`,
    }
  }
  return {
    batchId,
    batchCode,
    verdict: 'covered-compensation',
    reason: `规则恢复已生成唯一补偿批次 ${batchCode}（当前「${status}」），重复核对不会再补同一窗口`,
  }
}

/**
 * 扫描一条规则在停用区间内错过的全部调度时间窗，并逐一给出判定。
 * 时间窗比较同时看补偿批次（compensation）与已生成采集作业（spider），保证结论完整。
 */
export function evaluateMissedWindows(input: MissedScanInput): MissedWindow[] {
  const now = input.now ?? new Date()
  const lookbackDays = input.lookbackDays ?? 30
  const horizonStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - lookbackDays)
  const cron = parseCron(input.cronExpression)
  const period = parseEffectivePeriod(input.effectivePeriod)
  const intervals = buildDisabledIntervals(input.events, input.ruleCode, now)

  const expected = new Map<string, Date>()
  for (const interval of intervals) {
    const start = interval.from < horizonStart ? horizonStart : interval.from
    const end = interval.to ?? now
    if (end.getTime() <= start.getTime()) {
      continue
    }
    for (const hit of expandWindows(start, end, cron)) {
      if (hit.getTime() >= period.from.getTime() && hit.getTime() < period.toExclusive.getTime()) {
        expected.set(toLocalISO(hit), hit)
      }
    }
  }

  const allHits = expandWindows(
    period.from < horizonStart ? horizonStart : period.from,
    now < period.toExclusive ? now : period.toExclusive,
    cron,
  )

  const results: MissedWindow[] = []
  for (const windowStart of [...expected.values()].sort((a, b) => a.getTime() - b.getTime())) {
    const index = allHits.findIndex((hit) => hit.getTime() === windowStart.getTime())
    const windowEnd = index >= 0 && index + 1 < allHits.length ? allHits[index + 1] : endOfDay(windowStart)

    const batch = findBatchForWindow(input.batches, input.ruleCode, windowStart)
    const spider = findSpiderForWindow(input.spiderJobs, input.ruleCode, windowStart)

    if (batch) {
      const classified = classifyBatch(batch, windowStart)
      results.push({
        ruleCode: input.ruleCode,
        site: input.site,
        windowStart,
        windowEnd,
        spiderId: spider ? Number(spider.id) : null,
        spiderCode: spider ? textOf(spider, '作业编号') : null,
        ...classified,
      })
      continue
    }
    if (spider) {
      results.push({
        ruleCode: input.ruleCode,
        site: input.site,
        windowStart,
        windowEnd,
        verdict: 'covered-spider',
        batchId: null,
        batchCode: null,
        spiderId: Number(spider.id),
        spiderCode: textOf(spider, '作业编号'),
        reason: `窗口已由采集作业 ${textOf(spider, '作业编号')}（${textOf(spider, '作业来源') || '调度'}）承接，无需补偿`,
      })
      continue
    }
    results.push({
      ruleCode: input.ruleCode,
      site: input.site,
      windowStart,
      windowEnd,
      verdict: 'compensation-needed',
      batchId: null,
      batchCode: null,
      spiderId: null,
      spiderCode: null,
      reason: '停用区间内该时间窗未触发，且没有补偿批次或采集作业承接，需要补生成采集批次',
    })
  }
  return results
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
}
