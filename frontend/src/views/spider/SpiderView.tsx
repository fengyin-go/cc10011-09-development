import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = [
  '作业编号',
  '目标站点',
  '抽取模板',
  '起始地址',
  '并发线程数',
  '请求间隔秒',
  '每日上限条数',
  '超时秒数',
  '作业来源',
  '来源规则编号',
  '时间窗起点',
  '来源负责人',
]
const actions = ['提交执行', '启动采集', '终止采集', '归档结果']
const statuses = ['草稿', '待执行', '运行中', '已完成', '已失败']

export default function SpiderView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => ['作业编号', '目标站点', '作业来源'], [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务编排列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  const stats = useMemo(
    () => [
      { label: '采集作业总数', value: rows.length },
      { label: '运行中作业', value: rows.filter((row) => String(row.status) === '运行中').length },
      { label: '补偿补跑作业', value: rows.filter((row) => String(row['作业来源']) !== '普通调度').length },
      { label: '已完成作业', value: rows.filter((row) => String(row.status) === '已完成').length },
    ],
    [rows],
  )

  return (
    <section className="page" data-module="spider">
      <header className="page-head">
        <div>
          <h2>任务编排管理</h2>
          <p className="page-desc">
            漏触发补偿与人工补采的补跑作业统一回到待执行队列，不重复创建普通调度作业；作业来源与来源负责人保留可解释归属。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('采集作业登记入口尚未接入审批流')}>
            登记采集作业
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出任务编排清单
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
            const source = String(row['作业来源'] ?? '普通调度')
            const isCompensation = source !== '普通调度'
            return (
              <tr key={String(row.id)} className={isCompensation ? 'row-compensation' : ''}>
                {columns.map((column) => {
                  if (column === '作业来源') {
                    return (
                      <td key={column}>
                        <span className={`tag tag-${isCompensation ? 'info' : 'plain'}`}>{source}</span>
                      </td>
                    )
                  }
                  return <td key={column}>{row[column] !== '' && row[column] !== undefined ? String(row[column]) : '—'}</td>
                })}
                <td><span className={`status-pill status-${String(row.status)}`}>{row.status}</span></td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无任务编排数据，可先登记采集作业</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条任务编排记录；标记行来自漏触发补偿或人工补采，可按来源规则编号与时间窗起点追溯</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
