import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  listEntries,
  listLifecycleEvents,
  moduleMeta,
  previewMissedWindows,
  runScheduleAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { toLocalISO } from '@/domain/cron'
import type { MissedWindow, WindowVerdict } from '@/domain/missed-window'

const meta = moduleMeta('schedule')
const columns = [
  '规则编号',
  '关联站点',
  '调度表达式',
  '最大并发',
  '优先级',
  '生效时段',
  '执行超时',
  '漏触发补偿',
]
const actions = ['提交校验', '启用调度', '停用调度']
const statuses = ['草稿', '待校验', '已启用', '已停用']

const verdictStyle: Record<WindowVerdict, { label: string; tone: string }> = {
  'compensation-needed': { label: '缺失待补', tone: 'warn' },
  'batch-pending-conflict': { label: '冲突待判定', tone: 'danger' },
  'covered-compensation': { label: '补偿已承接', tone: 'ok' },
  'covered-manual': { label: '人工已承接', tone: 'ok' },
  'covered-spider': { label: '作业已承接', tone: 'ok' },
}

export default function ScheduleView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selectedCode, setSelectedCode] = useState('SCHE-0002')
  const [windows, setWindows] = useState<MissedWindow[]>([])
  const [scanError, setScanError] = useState('')
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '调度编排列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const scanWindows = useCallback((ruleCode: string) => {
    setScanError('')
    try {
      setWindows(previewMissedWindows(ruleCode))
    } catch (error) {
      setWindows([])
      setScanError(error instanceof Error ? error.message : '时间窗核对失败')
    }
  }, [])

  useEffect(() => {
    scanWindows(selectedCode)
  }, [selectedCode, scanWindows])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = runScheduleAction(Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
    scanWindows(String(row['规则编号']))
  }

  const lifecycleEvents = useMemo(() => listLifecycleEvents(selectedCode), [selectedCode, rows])
  const selectedRule = rows.find((row) => String(row['规则编号']) === selectedCode)

  return (
    <section className="page" data-module="schedule">
      <header className="page-head">
        <div>
          <h2>调度编排管理</h2>
          <p className="page-desc">
            停用/恢复围绕规则编号记录调度编排事件；恢复时自动比对停用区间内错过的调度时间窗，由规则恢复生成唯一补偿批次。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('调度规则登记入口尚未接入审批流')}>
            登记调度规则
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出调度编排清单
          </button>
        </div>
      </header>

      <p className="status-legend">
        {statuses.map((status) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={String(row.id)}
              className={String(row['规则编号']) === selectedCode ? 'row-selected' : ''}
              onClick={() => setSelectedCode(String(row['规则编号']))}
            >
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td><span className={`status-pill status-${String(row.status)}`}>{row.status}</span></td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button
                    key={action}
                    className="link"
                    type="button"
                    onClick={(event) => { event.stopPropagation(); runAction(action, row) }}
                  >
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无调度编排数据，可先登记调度规则</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="panel">
        <header className="panel-head">
          <h3>漏触发时间窗核对 · {selectedCode}</h3>
          <button className="btn" type="button" onClick={() => scanWindows(selectedCode)}>重新核对</button>
        </header>
        <p className="panel-sub">
          {selectedRule
            ? `表达式「${String(selectedRule['调度表达式'])}」，生效时段「${String(selectedRule['生效时段'])}」，状态「${String(selectedRule.status)}」`
            : '请选择一条调度规则'}
        </p>
        {scanError && <p className="error-text">{scanError}</p>}
        <table className="data-table inner-table">
          <thead>
            <tr>
              <th>时间窗起点</th>
              <th>时间窗终点</th>
              <th>判定结论</th>
              <th>承接批次 / 作业</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {windows.map((window) => {
              const tag = verdictStyle[window.verdict]
              return (
                <tr key={toLocalISO(window.windowStart)}>
                  <td>{toLocalISO(window.windowStart)}</td>
                  <td>{toLocalISO(window.windowEnd)}</td>
                  <td><span className={`tag tag-${tag.tone}`}>{tag.label}</span></td>
                  <td>{window.batchCode ?? window.spiderCode ?? '—'}</td>
                  <td className="reason-cell">{window.reason}</td>
                </tr>
              )
            })}
            {windows.length === 0 && !scanError && (
              <tr>
                <td className="empty-state" colSpan={5}>停用区间内没有错过的调度时间窗，或该规则尚未发生停用</td>
              </tr>
            )}
          </tbody>
        </table>

        <h4 className="panel-sub-title">调度编排记录（停用区间可追溯）</h4>
        <table className="data-table inner-table">
          <thead>
            <tr><th>规则编号</th><th>事件</th><th>发生时间</th><th>操作人</th><th>备注</th></tr>
          </thead>
          <tbody>
            {lifecycleEvents.map((event, index) => (
              <tr key={`${event.at}-${index}`}>
                <td>{event.ruleCode}</td>
                <td>{event.kind === 'disable' ? '停用' : '恢复'}</td>
                <td>{event.at}</td>
                <td>{event.operator}</td>
                <td>{event.note ?? '—'}</td>
              </tr>
            ))}
            {lifecycleEvents.length === 0 && (
              <tr><td className="empty-state" colSpan={5}>该规则暂无停用/恢复记录</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="page-foot">
        <span>共 {total} 条调度编排记录；点击行可核对该规则的补偿时间窗</span>
        {notice && <span className="ok-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
