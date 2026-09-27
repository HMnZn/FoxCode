/**
 * UsagePage — 用量与花费统计。
 *
 * 所有数字都来自 `useSession().timeline`：累计值读 `totals`，逐轮明细读
 * `blocks` 中 `kind === 'assistant'` 的块携带的 `usage`。本页不自行累加、
 * 也不估算美元金额之外的任何量。
 */
import { useMemo, type ReactNode } from 'react'
import { Coins, Gauge, Info, Layers } from 'lucide-react'
import { Chip, EmptyState, ProgressBar, TokenBar } from '@/components/ui'
import { FoxMascot } from '@/components/brand/Fox'
import { useSession } from '@/store/sessionStore'
import { assistantUsageTotal, type AssistantBlock } from '@/store/timeline'
import { formatCost, formatTokens } from '@/lib/format'
import type { Usage } from '@/types/protocol'

const WARN_PRESSURE = 0.7

export function UsagePage() {
  const totals = useSession((state) => state.timeline.totals)
  const blocks = useSession((state) => state.timeline.blocks)
  const host = useSession((state) => state.host)

  /** 只保留真正带用量或已结束的助手轮次，并记录原始顺序以便显示编号。 */
  const turns = useMemo(() => {
    const out: { index: number; block: AssistantBlock; usage: Usage | undefined }[] = []
    blocks.forEach((block, index) => {
      if (block.kind !== 'assistant') return
      out.push({ index, block, usage: assistantUsageTotal(block) })
    })
    return out
  }, [blocks])

  const history = useMemo(() => [...turns].reverse(), [turns])

  const sums = useMemo(
    () => ({
      input: totals.input ?? 0,
      output: totals.output ?? 0,
      cacheRead: totals.cacheRead ?? 0,
      cacheWrite: totals.cacheWrite ?? 0,
      reasoning: totals.reasoning ?? 0,
      total: totals.totalTokens ?? 0,
    }),
    [totals],
  )

  const contextWindow = host?.model.contextWindow
  // The per-request `max_tokens`: thinking shares it on deepseek-style thinking
  // formats, which is why a long thinking turn can truncate the answer.
  const outputLimit = host?.model.outputLimit ?? host?.model.maxTokens
  const pressure =
    contextWindow != null && contextWindow > 0
      ? Math.min((sums.input + sums.output) / contextWindow, 1)
      : null

  const hasData = sums.total > 0 || turns.length > 0

  if (!hasData) {
    return (
      <div className="scroll-quiet flex h-full flex-col overflow-y-auto bg-canvas">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 p-6">
          <header className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] leading-[28px] font-medium text-fg">用量</h1>
            <Chip size="sm">0 轮</Chip>
            <span className="ml-auto text-2xs text-fg-subtle">
              模型 <span className="font-mono text-fg-muted">{host?.model.displayName ?? '—'}</span>
            </span>
          </header>
          <EmptyState
            mascot={<FoxMascot size={92} />}
            title="还没有用量数据"
            description="发送第一条消息后，这里会显示宿主返回的输入 / 输出 tokens、缓存命中与花费明细。"
          />
          {outputLimit != null && (
            <p className="text-center text-2xs leading-relaxed text-fg-subtle">
              当前模型单次回复上限{' '}
              <span className="font-mono tabular-nums text-fg-muted">
                {formatTokens(outputLimit)}
              </span>{' '}
              token（思考与正文共享），来自{' '}
              <span className="font-mono">settings.json</span> 的{' '}
              <span className="font-mono">stream_options.max_tokens</span>。
            </p>
          )}
        </div>
      </div>
    )
  }

  const segments = [
    { label: '输入', value: sums.input, className: 'bg-info' },
    { label: '缓存读取', value: sums.cacheRead, className: 'bg-success' },
    { label: '输出', value: sums.output, className: 'bg-accent' },
    { label: '推理', value: sums.reasoning, className: 'bg-think' },
  ]

  return (
    <div className="scroll-quiet flex h-full flex-col overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 p-6">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="text-[20px] leading-[28px] font-medium text-fg">用量</h1>
          <Chip size="sm" mono>
            {totals.turns} 轮
          </Chip>
          <Chip size="sm">{totals.toolCalls} 次工具调用</Chip>
          <span className="ml-auto text-2xs text-fg-subtle">
            模型 <span className="font-mono text-fg-muted">{host?.model.displayName ?? '—'}</span>
          </span>
        </header>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={<Layers size={13} />}
            label="总 tokens"
            value={formatTokens(sums.total)}
            caption={`输入 + 输出 + 缓存读写，共 ${totals.turns} 轮对话`}
          />
          <StatCard
            icon={<Gauge size={13} />}
            label="输入 / 输出"
            value={`${formatTokens(sums.input)} / ${formatTokens(sums.output)}`}
            caption="输入含系统提示与历史上下文，输出为模型生成内容"
          />
          <StatCard
            icon={<Coins size={13} />}
            label="缓存命中"
            value={formatTokens(sums.cacheRead)}
            caption={`缓存读取的输入 tokens，写入 ${formatTokens(sums.cacheWrite)}`}
          />
          <StatCard
            icon={<Coins size={13} />}
            label="累计花费"
            value={formatCost(totals.cost)}
            caption="按宿主回报的每条 assistant 消息累加；缓存读取通常按折扣价计费"
          />
        </div>

        <section className="surface-card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-medium text-fg-muted">token 构成</h2>
            <span className="ml-auto font-mono text-2xs tabular-nums text-fg-subtle">
              {formatTokens(sums.total)} total
            </span>
          </div>
          <TokenBar segments={segments} total={sums.total} height={8} legend />
        </section>

        <section className="surface-card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-medium text-fg-muted">上下文占用</h2>
            {host?.model && (
              <Chip size="xs" mono>
                {host.model.provider}
              </Chip>
            )}
            <span className="ml-auto font-mono text-2xs tabular-nums text-fg-subtle">
              {contextWindow != null ? `${formatTokens(contextWindow)} 窗口` : '宿主未报告上下文窗口'}
            </span>
          </div>
          {pressure == null ? (
            <p className="text-2xs leading-relaxed text-fg-subtle">
              宿主未提供 <span className="font-mono">contextWindow</span>，无法估算压力；仍可在会话中执行压缩以释放上下文。
            </p>
          ) : (
            <>
              <ProgressBar
                value={pressure}
                size="md"
                tone={pressure >= WARN_PRESSURE ? 'warn' : 'accent'}
                showValue
                label="已使用上下文"
              />
              <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-subtle">
                <span>
                  估算占用{' '}
                  <span className="font-mono tabular-nums text-fg-muted">
                    {formatTokens(sums.input + sums.output)}
                  </span>{' '}
                  / {formatTokens(contextWindow)}
                </span>
                {pressure >= WARN_PRESSURE && (
                  <Chip size="xs" tone="warn">
                    超过 70%，建议压缩上下文
                  </Chip>
                )}
              </div>
              {outputLimit != null && (
                <p className="text-2xs leading-relaxed text-fg-subtle">
                  单次回复上限{' '}
                  <span className="font-mono tabular-nums text-fg-muted">
                    {formatTokens(outputLimit)}
                  </span>{' '}
                  token（思考与正文共享），来自{' '}
                  <span className="font-mono">settings.json</span> 的{' '}
                  <span className="font-mono">stream_options.max_tokens</span>；回答被截断时先调大它。
                </p>
              )}
            </>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-medium text-fg-muted">逐轮明细</h2>
            <Chip size="xs">{turns.length}</Chip>
            <span className="ml-auto text-2xs text-fg-subtle">最新一轮在最上方</span>
          </div>
          <div className="surface-card overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-line text-2xs text-fg-subtle">
                  <th className="w-[70px] px-3 py-2 text-left font-medium">轮次</th>
                  <th className="w-[220px] px-3 py-2 text-left font-medium">模型</th>
                  <th className="w-[100px] px-3 py-2 text-right font-medium">输入</th>
                  <th className="w-[100px] px-3 py-2 text-right font-medium">输出</th>
                  <th className="w-[110px] px-3 py-2 text-right font-medium">花费</th>
                  <th className="w-[140px] px-3 py-2 text-left font-medium">结束原因</th>
                </tr>
              </thead>
              <tbody>
                {history.map(({ block, index, usage }) => {
                  const total = usage?.totalTokens ?? (usage ? usage.input + usage.output : 0)
                  return (
                    <tr key={block.id} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-2 align-top font-mono tabular-nums text-fg-subtle">#{index}</td>
                      <td className="truncate px-3 py-2 align-top font-mono text-fg-muted" title={block.model ?? ''}>
                        {block.model ?? host?.model.id ?? '—'}
                      </td>
                      <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-info">
                        {formatTokens(usage?.input ?? 0)}
                      </td>
                      <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-accent">
                        {formatTokens(usage?.output ?? 0)}
                      </td>
                      <td className="px-3 py-2 align-top text-right font-mono tabular-nums text-fg-muted">
                        {usage ? formatCost(usage.cost.total) : '—'}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className="flex items-center gap-1.5">
                          <Chip size="xs" tone={stopTone(block.stopReason)}>
                            {stopLabel(block.stopReason)}
                          </Chip>
                          {usage && usage.totalTokens !== total && (
                            <span className="font-mono text-2xs tabular-nums text-fg-subtle">
                              {formatTokens(total)}
                            </span>
                          )}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-3 text-2xs text-fg-subtle">
          <Info size={13} className="mt-px shrink-0 text-info" aria-hidden="true" />
          <span>
            用量与花费由宿主在每条 assistant 消息上回报；未收到回报的历史轮次显示为 0，压缩上下文不会重置这里的累计值。
          </span>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  caption,
}: {
  icon: ReactNode
  label: string
  value: string
  caption: string
}) {
  return (
    <div className="surface-card flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-1.5 text-2xs text-fg-subtle">
        <span className="text-fg-subtle" aria-hidden="true">
          {icon}
        </span>
        {label}
      </div>
      <div className="font-mono text-[15px] font-medium tabular-nums text-fg">{value}</div>
      <p className="text-2xs leading-relaxed text-fg-subtle">{caption}</p>
    </div>
  )
}

function stopLabel(reason: string | undefined): string {
  switch (reason) {
    case 'stop':
      return '正常结束'
    case 'length':
      return '达到长度上限'
    case 'toolUse':
      return '工具调用'
    case 'error':
      return '出错'
    case 'aborted':
      return '已中断'
    case 'pending':
      return '进行中'
    default:
      return reason ?? '未标注'
  }
}

function stopTone(reason: string | undefined): 'neutral' | 'success' | 'warn' | 'danger' | 'info' {
  switch (reason) {
    case 'stop':
      return 'success'
    case 'length':
      return 'warn'
    case 'error':
      return 'danger'
    case 'toolUse':
      return 'info'
    default:
      return 'neutral'
  }
}
