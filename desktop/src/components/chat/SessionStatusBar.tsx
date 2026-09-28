import { CircleGauge, Database, Wrench } from 'lucide-react'
import { formatCost, formatTokens } from '@/lib/format'
import { useSession } from '@/store/sessionStore'

export function SessionStatusBar() {
  const host = useSession((state) => state.host)
  const timeline = useSession((state) => state.timeline)
  const used = Math.max(0, timeline.context.used + (timeline.context.live ?? 0))
  const limit = timeline.context.limit || host?.model?.contextWindow || 0
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const running = ['streaming', 'awaiting-approval', 'compacting'].includes(timeline.status)

  return (
    <footer className="flex h-7 shrink-0 items-center justify-center gap-4 border-t border-line bg-canvas px-4 text-[10.5px] text-fg-caption">
      <span className="inline-flex items-center gap-1.5">
        <CircleGauge size={12} className={running ? 'text-info' : undefined} />
        {timeline.totals.turns} 回合 · {timeline.totals.toolCalls} 工具
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Database size={12} />
        上下文已用 {formatTokens(used)} / {limit ? formatTokens(limit) : '—'}
        <span className="text-fg-subtle">({percent}%)</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Wrench size={12} />
        输入 {formatTokens(timeline.totals.input)} · 输出 {formatTokens(timeline.totals.output)}
      </span>
      <span className="font-mono tabular-nums">{formatCost(timeline.totals.cost)}</span>
      <span className="max-w-[180px] truncate">{host?.model?.displayName ?? '未选择模型'}</span>
    </footer>
  )
}
