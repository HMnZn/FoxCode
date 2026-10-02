import { CircleGauge, Database, Gauge, Wrench } from 'lucide-react'
import { formatCost, formatTokens } from '@/lib/format'
import { useSession } from '@/store/sessionStore'

export function SessionStatusBar() {
  const host = useSession((state) => state.host)
  const timeline = useSession((state) => state.timeline)
  const used = Math.max(0, timeline.context.used)
  const limit = timeline.context.limit || host?.model?.contextWindow || 0
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const cacheRead = Math.max(0, timeline.context.cacheRead)
  const cacheBase = Math.max(0, timeline.context.input) + cacheRead
  const cachePercent = cacheBase > 0 ? Math.round((cacheRead / cacheBase) * 100) : 0
  const running = ['streaming', 'awaiting-approval', 'compacting'].includes(timeline.status)
  const contextLabel = `上下文已用 ${formatTokens(used)} / ${limit ? formatTokens(limit) : '—'}`

  return (
    <footer
      aria-label="会话状态"
      className="session-status-bar flex h-8 min-w-0 shrink-0 flex-nowrap items-center overflow-hidden whitespace-nowrap border-t border-line bg-canvas px-2 text-[10.5px] text-fg-caption"
    >
      <span className="session-status-activity inline-flex shrink-0 items-center gap-1.5 px-2">
        <CircleGauge size={12} className={running ? 'text-info' : undefined} />
        {timeline.totals.turns} 回合 · {timeline.totals.toolCalls} 工具
      </span>
      <span
        className="session-status-context inline-flex min-w-0 shrink-0 items-center gap-1.5 border-l border-line px-2"
        title={`${contextLabel} (${percent}%)`}
      >
        <Database size={12} />
        <span className="session-status-context-long">{contextLabel}</span>
        <span className="session-status-context-short" aria-hidden="true">
          {formatTokens(used)} / {limit ? formatTokens(limit) : '—'}
        </span>
        <span className="text-fg-subtle">({percent}%)</span>
      </span>
      <span
        className="session-status-cache inline-flex shrink-0 items-center gap-1.5 border-l border-line px-2"
        title={`本轮缓存读取 ${formatTokens(cacheRead)}，命中率 ${cachePercent}%`}
      >
        <Gauge size={12} />
        缓存命中 {formatTokens(cacheRead)} ({cachePercent}%)
      </span>
      <span className="session-status-io inline-flex shrink-0 items-center gap-1.5 border-l border-line px-2">
        <Wrench size={12} />
        输入 {formatTokens(timeline.totals.input)} · 输出 {formatTokens(timeline.totals.output)}
      </span>
      <span className="session-status-cost shrink-0 border-l border-line px-2 font-mono tabular-nums">
        {formatCost(timeline.totals.cost)}
      </span>
      <span
        className="session-status-model ml-auto min-w-0 max-w-[220px] truncate border-l border-line px-2 text-right text-fg-subtle"
        title={host?.model?.displayName ?? '未选择模型'}
      >
        {host?.model?.displayName ?? '未选择模型'}
      </span>
    </footer>
  )
}
