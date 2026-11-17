// 调度规则停用/恢复事件的示例数据：补偿引擎据此还原停用区间。
export type ScheduleLifecycleEvent = {
  ruleCode: string
  kind: 'disable' | 'enable'
  at: string
  operator: string
  note?: string
}

export const SEED_SCHEDULE_STATE: { lifecycleEvents: ScheduleLifecycleEvent[] } = {
  lifecycleEvents: [
    {
      ruleCode: 'SCHE-0002',
      kind: 'disable',
      // 相对当前日期（2026-11-17）前两天停用，恢复动作由调度员在页面触发。
      at: '2026-11-15T08:00:00',
      operator: '调度员-周岚',
      note: '编排服务升级，暂停每日三次采集调度',
    },
  ],
}
