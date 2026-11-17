import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import {
  archiveCompensationBatch,
  downloadEntries,
  enqueueCompensationBatch,
  listEntries,
  moduleMeta,
  registerManualCatchup,
  resolveConflictByManualTakeover,
  resolveConflictByRuleTakeover,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compensation')
const columns = [
  '补偿批次编号',
  '规则编号',
  '关联站点',
  '调度编排',
  '时间窗起点',
  '时间窗终点',
  '停用区间',
  '批次来源',
  '来源负责人',
  '冲突处理',
  '关联作业编号',
  '复核依据',
  '数据凭据',
]
const statuses = ['缺失', '待执行', '已归档', '已结束']

const verdictTag: Record<string, { label: string; tone: string }> = {
  无冲突: { label: '无冲突', tone: 'plain' },
  待判定: { label: '冲突待判定', tone: 'warn' },
  规则恢复接管: { label: '规则恢复接管', tone: 'info' },
  人工补采接管: { label: '人工补采接管', tone: 'info' },
}

export default function CompensationView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [ruleCode, setRuleCode] = useState('SCHE-0002')
  const [windowStart, setWindowStart] = useState('')
  const [detail, setDetail] = useState<EntryRow | null>(null)
  const filterFields = useMemo(() => ['规则编号', '批次来源', '冲突处理', '补偿批次编号'], [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '漏触发补偿批次读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function call(action: () => { ok: boolean; message: string }) {
    setMessage('')
    setErrorMessage('')
    const result = action()
    if (result.ok) {
      setMessage(result.message)
      reload()
    } else {
      setErrorMessage(result.message)
    }
  }

  const stats = useMemo(
    () => [
      { label: '补偿批次总数', value: rows.length },
      { label: '缺失待补批次', value: rows.filter((row) => String(row.status) === '缺失').length },
      { label: '待执行批次', value: rows.filter((row) => String(row.status) === '待执行').length },
      { label: '冲突待判定', value: rows.filter((row) => String(row['冲突处理']) === '待判定').length },
    ],
    [rows],
  )

  function submitManual(event: FormEvent) {
    event.preventDefault()
    call(() => registerManualCatchup(ruleCode.trim(), windowStart.trim()))
  }

  return (
    <section className="page" data-module="compensation">
      <header className="page-head">
        <div>
          <h2>漏触发补偿采集批次</h2>
          <p className="page-desc">
            比对调度停用区间错过的时间窗，同一时间窗只保留一个补偿批次；批次沿缺失 → 待执行 → 归档流转，来源、负责人与冲突归属全程留证。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出补偿批次清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

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

      <form className="inline-form" onSubmit={submitManual}>
        <label className="filter-item">
          <span>人工补采规则编号</span>
          <input value={ruleCode} onChange={(event) => setRuleCode(event.target.value)} placeholder="如 SCHE-0002" />
        </label>
        <label className="filter-item">
          <span>补采时间窗起点</span>
          <input
            value={windowStart}
            onChange={(event) => setWindowStart(event.target.value)}
            placeholder="2026-11-16T20:00"
          />
        </label>
        <button className="btn primary" type="submit">登记人工补采</button>
        <span className="form-hint">与规则恢复命中同一窗口时，只登记一个批次并进入冲突判定。</span>
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
          {rows.map((row) => {
            const conflict = String(row['冲突处理']) === '待判定'
            return (
              <tr key={String(row.id)} className={conflict ? 'row-conflict' : ''}>
                {columns.map((column) => {
                  if (column === '冲突处理') {
                    const tag = verdictTag[String(row[column])] ?? { label: String(row[column] ?? '—'), tone: 'plain' }
                    return (
                      <td key={column}>
                        <span className={`tag tag-${tag.tone}`}>{tag.label}</span>
                      </td>
                    )
                  }
                  return <td key={column}>{row[column] !== '' && row[column] !== undefined ? String(row[column]) : '—'}</td>
                })}
                <td><span className={`status-pill status-${String(row.status)}`}>{row.status}</span></td>
                <td className="row-actions">
                  {(String(row.status) === '缺失' || String(row.status) === '待执行') &&
                    String(row['冲突处理']) !== '待判定' && (
                    <button className="link" type="button" onClick={() => call(() => enqueueCompensationBatch(Number(row.id)))}>
                      补跑入队
                    </button>
                  )}
                  {String(row.status) === '待执行' && (
                    <button className="link" type="button" onClick={() => call(() => archiveCompensationBatch(Number(row.id)))}>
                      归档批次
                    </button>
                  )}
                  {conflict && (
                    <>
                      <button
                        className="link"
                        type="button"
                        onClick={() => call(() => resolveConflictByRuleTakeover(Number(row.id)))}
                      >
                        规则恢复接管
                      </button>
                      <button
                        className="link"
                        type="button"
                        onClick={() => call(() => resolveConflictByManualTakeover(Number(row.id)))}
                      >
                        人工补采接管
                      </button>
                    </>
                  )}
                  <button className="link" type="button" onClick={() => setDetail(row)}>变更证据</button>
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无漏触发补偿批次，可在调度编排恢复规则后自动生成，或登记人工补采</td>
            </tr>
          )}
        </tbody>
      </table>

      {detail && (
        <div className="drawer-mask" role="presentation" onClick={() => setDetail(null)}>
          <aside className="drawer" role="dialog" aria-label="补偿批次变更证据" onClick={(event) => event.stopPropagation()}>
            <header className="drawer-head">
              <h3>{String(detail['补偿批次编号'])} · 变更证据</h3>
              <button className="btn ghost" type="button" onClick={() => setDetail(null)}>关闭</button>
            </header>
            <dl className="evidence-list">
              <dt>规则 / 调度编排</dt>
              <dd>{String(detail['规则编号'])}（{String(detail['调度编排'])}）</dd>
              <dt>时间窗</dt>
              <dd>{String(detail['时间窗起点'])} ~ {String(detail['时间窗终点'])}</dd>
              <dt>停用区间</dt>
              <dd>{String(detail['停用区间'])}</dd>
              <dt>来源与负责人</dt>
              <dd>{String(detail['批次来源'])} / {String(detail['来源负责人'])}</dd>
              <dt>复核依据</dt>
              <dd>{String(detail['复核依据'])}</dd>
              <dt>数据凭据</dt>
              <dd>{String(detail['数据凭据'] || '补跑入队后留存')}</dd>
              <dt>变更证据链</dt>
              <dd><pre className="evidence-pre">{String(detail['变更证据'])}</pre></dd>
            </dl>
          </aside>
        </div>
      )}

      <footer className="page-foot">
        <span>共 {total} 条漏触发补偿批次，同一规则同一时间窗只生成一个补偿批次</span>
        {message && <span className="ok-text">{message}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
