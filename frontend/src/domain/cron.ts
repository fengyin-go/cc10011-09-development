/**
 * 轻量 5 段 cron 解析与时间窗展开（纯函数，不碰持久化）。
 * 段顺序：分 时 日 月 周，支持星号、步长（星号斜杠 n）、枚举 a,b,c、区间 a-b 及区间步长。
 * 周段 0 与 7 都表示周日；日月同时受限（非星号）时按标准 cron 语义取并集。
 */

export type CronExpr = {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

type FieldRange = [number, number]

const RANGES: Record<'minute' | 'hour' | 'dom' | 'month' | 'dow', FieldRange> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7],
}

function parseToken(token: string, min: number, max: number): number[] {
  const stepMatch = token.match(/^(.+)\/(\d+)$/)
  let base = stepMatch ? stepMatch[1] : token
  const step = stepMatch ? Number(stepMatch[2]) : 1
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`cron 步长非法：${token}`)
  }
  let start = min
  let end = max
  if (base !== '' && base !== '*') {
    if (base.includes('-')) {
      const [fromText, toText] = base.split('-')
      start = Number(fromText)
      end = Number(toText)
    } else {
      start = Number(base)
      end = stepMatch ? max : start
    }
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
    throw new Error(`cron 取值越界：${token}`)
  }
  const values: number[] = []
  for (let value = start; value <= end; value += step) {
    values.push(value)
  }
  return values
}

export function parseField(raw: string, field: keyof typeof RANGES): number[] {
  const [min, max] = RANGES[field]
  const values = new Set<number>()
  for (const token of raw.split(',')) {
    for (const value of parseToken(token.trim(), min, max)) {
      // 周段 7 归一化为 0（周日）
      values.add(field === 'dow' && value === 7 ? 0 : value)
    }
  }
  if (values.size === 0) {
    throw new Error(`cron 字段 ${field} 没有可匹配值：${raw}`)
  }
  return [...values].sort((a, b) => a - b)
}

export function parseCron(expression: string): CronExpr {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`调度表达式必须是 5 段 cron：${expression}`)
  }
  const [minuteText, hourText, domText, monthText, dowText] = parts
  return {
    minute: parseField(minuteText, 'minute'),
    hour: parseField(hourText, 'hour'),
    dom: parseField(domText, 'dom'),
    month: parseField(monthText, 'month'),
    dow: parseField(dowText, 'dow'),
    domRestricted: domText !== '*',
    dowRestricted: dowText !== '*',
  }
}

export function isCronValid(expression: string): boolean {
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}

function dayMatches(cron: CronExpr, date: Date): boolean {
  const domOk = !cron.domRestricted || cron.dom.includes(date.getDate())
  const dowOk = !cron.dowRestricted || cron.dow.includes(date.getDay())
  if (cron.domRestricted && cron.dowRestricted) {
    return domOk || dowOk
  }
  return domOk && dowOk
}

/** 展开 [start, end) 内全部应触发时刻，按时间升序，封顶防止异常表达式跑飞。 */
export function expandWindows(start: Date, end: Date, cron: CronExpr, cap = 5000): Date[] {
  const fired: Date[] = []
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  while (cursor.getTime() <= lastDay.getTime() && fired.length < cap) {
    if (cron.month.includes(cursor.getMonth() + 1) && dayMatches(cron, cursor)) {
      for (const hour of cron.hour) {
        for (const minute of cron.minute) {
          const hit = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hour, minute, 0, 0)
          if (hit.getTime() >= start.getTime() && hit.getTime() < end.getTime()) {
            fired.push(hit)
            if (fired.length >= cap) {
              break
            }
          }
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return fired.sort((a, b) => a.getTime() - b.getTime())
}

/** 生效时段解析：支持 "YYYY-MM-DD~YYYY-MM-DD"、"YYYY-MM-DD 至 YYYY-MM-DD" 与单日 "YYYY-MM-DD"。 */
export function parseEffectivePeriod(text: string): { from: Date; toExclusive: Date } {
  const matched = text.trim().match(/(\d{4}-\d{2}-\d{2})(?:\s*(?:~|至|到|-)\s*(\d{4}-\d{2}-\d{2}))?/)
  if (!matched) {
    throw new Error(`生效时段无法识别：${text}`)
  }
  const from = parseDateOnly(matched[1])
  const to = matched[2] ? parseDateOnly(matched[2]) : new Date(from.getTime())
  return { from, toExclusive: new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) }
}

export function parseDateOnly(text: string): Date {
  const matched = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!matched) {
    throw new Error(`日期格式应为 YYYY-MM-DD：${text}`)
  }
  return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
}

/** 解析时间窗起点输入，兼容 "YYYY-MM-DDTHH:mm"、"YYYY-MM-DD HH:mm" 与本地 ISO。 */
export function parseWindowStart(text: string): Date {
  const normalized = text.trim().replace(' ', 'T')
  const matched = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!matched) {
    throw new Error(`时间窗起点格式应为 YYYY-MM-DDTHH:mm：${text}`)
  }
  return new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    matched[6] ? Number(matched[6]) : 0,
    0,
  )
}

export function toLocalISO(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}
