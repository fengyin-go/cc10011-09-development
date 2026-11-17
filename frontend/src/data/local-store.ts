import { SEED_ROWS } from './seed'
import { SEED_SCHEDULE_STATE } from './seed-schedule-state'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'scraper-strategy-studio:entries'
// 调度规则的停用/恢复事件与停用区间，独立于业务条目表保存。
const SCHEDULE_STATE_KEY = 'scraper-strategy-studio:schedule-state'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

type ScheduleState = {
  lifecycleEvents: import('./seed-schedule-state').ScheduleLifecycleEvent[]
}

export function readScheduleState(): ScheduleState {
  const fallback = clone(SEED_SCHEDULE_STATE)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(SCHEDULE_STATE_KEY)
  if (!raw) {
    window.localStorage.setItem(SCHEDULE_STATE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScheduleState>
    return { lifecycleEvents: parsed.lifecycleEvents ?? clone(fallback.lifecycleEvents) }
  } catch {
    window.localStorage.setItem(SCHEDULE_STATE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function writeScheduleState(state: ScheduleState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SCHEDULE_STATE_KEY, JSON.stringify(state))
  }
}

export function resetScheduleState(): ScheduleState {
  const fallback = clone(SEED_SCHEDULE_STATE)
  writeScheduleState(fallback)
  return fallback
}

export function scheduleStateKey(): string {
  return SCHEDULE_STATE_KEY
}
