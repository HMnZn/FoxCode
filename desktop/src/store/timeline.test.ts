import { describe, expect, it } from 'vitest'
import {
  EMPTY_TIMELINE,
  applyFrame,
  applyHostContext,
  applyHostIdle,
  applyPermissionDecision,
  applyPermissionRequest,
  markStalled,
} from '@/store/timeline'
import type { AssistantBlock, Block, ToolCallState, TimelineState } from '@/store/timeline'
import { EMPTY_USAGE, PROTOCOL_VERSION } from '@/types/protocol'
import type { HostEvent, HostFrame, PermissionRequest } from '@/types/protocol'

let counter = 0

function frame(event: HostEvent): HostFrame {
  counter += 1
  return { ...event, seq: counter, ts: 1_700_000_000_000 + counter, v: PROTOCOL_VERSION }
}

function run(events: HostEvent[], start: TimelineState = EMPTY_TIMELINE): TimelineState {
  return events.reduce((state, event) => applyFrame(state, frame(event)), start)
}

function onlyAssistant(blocks: Block[]): AssistantBlock {
  const assistants = blocks.filter((block): block is AssistantBlock => block.kind === 'assistant')
  expect(assistants).toHaveLength(1)
  return assistants[0]
}

function toolCalls(blocks: Block[]): ToolCallState[] {
  return blocks.flatMap((block) => (block.kind === 'tools' ? block.calls : []))
}

const userMessage = (text: string): HostEvent => ({
  type: 'message_end',
  message: { role: 'user', content: [{ type: 'text', text }] },
})

const stream = (
  event: Extract<HostEvent, { type: 'message_update' }>['assistant_message_event'],
  context_usage?: Extract<HostEvent, { type: 'message_update' }>['context_usage'],
): HostEvent => ({
  type: 'message_update',
  assistant_message_event: event,
  context_usage,
})

describe('timeline reducer', () => {
  it('records the user turn and keeps the run streaming', () => {
    const state = run([
      { type: 'agent_start' },
      { type: 'turn_start' },
      userMessage('检查 runtime.py 的并发约束'),
    ])

    const [first] = state.blocks
    expect(first.kind).toBe('user')
    expect(first.kind === 'user' && first.text).toBe('检查 runtime.py 的并发约束')
    expect(state.status).toBe('streaming')
  })

  it('folds streamed deltas into a single assistant block', () => {
    const state = run([
      { type: 'turn_start' },
      stream({ type: 'start' }),
      stream({ type: 'text_start', content_index: 0 }),
      stream({ type: 'text_delta', content_index: 0, delta: 'Hel' }),
      stream({ type: 'text_delta', content_index: 0, delta: 'lo' }),
      stream({ type: 'text_end', content_index: 0, content: 'Hello' }),
    ])

    const assistant = onlyAssistant(state.blocks)
    expect(assistant.text).toBe('Hello')
    expect(assistant.textStreaming).toBe(false)
  })

  it('keeps thinking text separate from the answer', () => {
    const state = run([
      stream({ type: 'thinking_start', content_index: 0 }),
      stream({ type: 'thinking_delta', content_index: 0, delta: '先看锁' }),
      stream({ type: 'thinking_end', content_index: 0, content: '先看锁' }),
      stream({ type: 'text_start', content_index: 0 }),
      stream({ type: 'text_delta', content_index: 0, delta: '结论' }),
    ])

    const assistant = onlyAssistant(state.blocks)
    expect(assistant.thinking).toBe('先看锁')
    expect(assistant.text).toBe('结论')
    expect(assistant.thinkingStreaming).toBe(false)
    expect(assistant.textStreaming).toBe(true)
  })

  it('indexes interleaved parallel tool calls by tool_call_id', () => {
    const state = run([
      {
        type: 'tool_execution_start',
        tool_call_id: 'call-a',
        tool_name: 'bash',
        args: { command: 'pytest -q' },
      },
      {
        type: 'tool_execution_start',
        tool_call_id: 'call-b',
        tool_name: 'read',
        args: { path: 'README.md' },
      },
      { type: 'tool_execution_update', tool_call_id: 'call-b', partial_result: '50%' },
      {
        type: 'tool_execution_end',
        tool_call_id: 'call-a',
        tool_name: 'bash',
        result: '3 passed',
        is_error: false,
      },
    ])

    const calls = toolCalls(state.blocks)
    expect(calls).toHaveLength(2)

    const a = calls.find((call) => call.id === 'call-a')
    const b = calls.find((call) => call.id === 'call-b')
    expect(a?.status).toBe('success')
    expect(a?.result).toBe('3 passed')
    expect(b?.status).toBe('running')
    expect(b?.updates).toEqual(['50%'])
    expect(state.totals.toolCalls).toBe(1)
  })

  it('adds usage from the settled assistant message to the totals', () => {
    const state = run([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          model: 'deepseek-v4-flash',
          stopReason: 'stop',
          usage: { ...EMPTY_USAGE, input: 1200, output: 300, totalTokens: 1500 },
        },
      },
    ])

    expect(state.totals.input).toBe(1200)
    expect(state.totals.output).toBe(300)
    expect(state.totals.totalTokens).toBe(1500)
    const assistant = onlyAssistant(state.blocks)
    expect(assistant.model).toBe('deepseek-v4-flash')
    expect(assistant.stopReason).toBe('stop')
  })

  it('settles idempotently when a run ends twice', () => {
    const once = run([
      { type: 'turn_start' },
      stream({ type: 'text_start', content_index: 0 }),
      stream({ type: 'text_delta', content_index: 0, delta: 'hi' }),
      { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
    ])
    const twice = applyFrame(once, frame({ type: 'agent_end', messages: [] }))

    expect(once.status).toBe('idle')
    expect(twice.blocks).toHaveLength(once.blocks.length)
    expect(onlyAssistant(twice.blocks).textStreaming).toBe(false)
  })

  it('blocks the call it was told to deny', () => {
    const request: PermissionRequest = {
      id: 'perm-1',
      ts: 1,
      tool_call_id: 'call-x',
      tool_name: 'write',
      args: { path: 'C:/outside.txt' },
      required: 'workspace-modify',
      mode: 'workspace-modify',
      cwd: 'C:/repo',
      reason: 'outside-workspace',
      summary: 'write C:/outside.txt',
    }

    const asked = applyPermissionRequest(EMPTY_TIMELINE, request)
    expect(asked.status).toBe('awaiting-approval')
    expect(asked.permissions).toHaveLength(1)

    const denied = applyPermissionDecision(asked, 'perm-1', 'deny')
    expect(denied.permissions).toHaveLength(0)
    expect(denied.decisions['perm-1']).toBe('deny')
    expect(toolCalls(denied.blocks)[0].status).toBe('blocked')

    const granted = applyPermissionDecision(asked, 'perm-1', 'allow-once')
    expect(granted.decisions['perm-1']).toBe('allow-once')
    expect(toolCalls(granted.blocks)[0].status).toBe('approved')
  })

  it('keeps post-tool text in a new assistant block (no cross-turn merge)', () => {
    const state = run([
      userMessage('第一轮'),
      stream({ type: 'text_start', content_index: 0 }),
      stream({ type: 'text_delta', content_index: 0, delta: '先读文件' }),
      {
        type: 'tool_execution_start',
        tool_call_id: 'call-1',
        tool_name: 'read',
        args: { path: 'a.ts' },
      },
      {
        type: 'tool_execution_end',
        tool_call_id: 'call-1',
        tool_name: 'read',
        result: 'ok',
        is_error: false,
      },
      stream({ type: 'text_start', content_index: 0 }),
      stream({ type: 'text_delta', content_index: 0, delta: '读完了' }),
    ])

    const assistants = state.blocks.filter(
      (block): block is AssistantBlock => block.kind === 'assistant',
    )
    // 工具批次之后的文字必须落到新块里，否则会跑到工具卡上面（旧的跨轮合并 bug）。
    expect(assistants).toHaveLength(2)
    expect(assistants[0].text).toBe('先读文件')
    expect(assistants[1].text).toBe('读完了')
    const kinds = state.blocks.map((block) => block.kind)
    expect(kinds.indexOf('tools')).toBeLessThan(kinds.lastIndexOf('assistant'))
  })

  it('tracks context usage from the latest request and drops it after compaction', () => {
    const withUsage = run([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          usage: { ...EMPTY_USAGE, input: 70_000, cacheRead: 4_000, output: 312, totalTokens: 74_312 },
        },
      },
    ])

    expect(withUsage.context.used).toBe(74_312)
    expect(withUsage.context.source).toBe('usage')

    const compacted = applyFrame(
      withUsage,
      frame({
        type: 'compaction_end',
        automatic: true,
        preTokens: 74_312,
        postTokens: 19_880,
        removedCount: 42,
        retainedCount: 6,
        summary: '压缩摘要',
      }),
    )

    expect(compacted.context.used).toBe(19_880)
    expect(compacted.context.source).toBe('compaction')
    expect(compacted.context.used).toBeLessThan(withUsage.context.used)
    const notice = compacted.blocks.find((block) => block.kind === 'notice')
    expect(notice?.kind === 'notice' && notice.description).toContain('19.9K')
  })

  it('seeds context from the host estimate without clobbering a larger usage number', () => {
    const withUsage = run([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          usage: { ...EMPTY_USAGE, input: 70_000, output: 312, totalTokens: 74_312 },
        },
      },
    ])

    const seeded = applyHostContext(withUsage, 18_000, 1_000_000)
    expect(seeded.context.used).toBe(74_312)

    const fresh = applyHostContext(EMPTY_TIMELINE, 18_000, 1_000_000)
    expect(fresh.context.used).toBe(18_000)
    expect(fresh.context.source).toBe('host')
    expect(fresh.context.limit).toBe(1_000_000)

    // 只有宿主估算、但用量比它还小的会话：仍然以请求用量为准（宿主是粗估）。
    const small = run([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          usage: { ...EMPTY_USAGE, input: 5_000, output: 100, totalTokens: 5_100 },
        },
      },
    ])
    const kept = applyHostContext(small, 40_000, 262_100)
    expect(kept.context.used).toBe(5_100)
    expect(kept.context.source).toBe('usage')
    expect(kept.context.limit).toBe(262_100)
  })

  it('surfaces host errors without dropping the transcript', () => {
    const state = run([
      userMessage('你好'),
      { type: 'error', error: 'Runtime is closed' },
    ])

    expect(state.lastError).toBe('Runtime is closed')
    expect(state.status).toBe('error')
    // The transcript survives; the failure is announced as an extra notice block.
    expect(state.blocks[0].kind).toBe('user')
    expect(state.blocks.some((block) => block.kind === 'notice')).toBe(true)
  })

  it('shows progress and backend usage while file arguments are streaming', () => {
    const state = run([
      { type: 'agent_start' },
      stream({ type: 'toolcall_delta', content_index: 0, delta: '<svg' },
        { context_tokens: 3210, output_tokens: 120, estimated: true }),
    ])
    expect(state.activity).toBe('正在生成工具参数…')
    expect(state.context).toEqual(expect.objectContaining({ used: 3210 }))
    expect(state.stalled).toBe(false)
  })

  it('uses backend streaming token snapshots and settles them on final usage', () => {
    const streaming = run([
      { type: 'turn_start' },
      stream(
        { type: 'text_start', content_index: 0 },
        { context_tokens: 1_008, output_tokens: 0, estimated: true },
      ),
      stream(
        { type: 'text_delta', content_index: 0, delta: '正在写一段中文' },
        { context_tokens: 1_016, output_tokens: 8, estimated: true },
      ),
    ])

    expect(streaming.context.live).toBe(0)
    expect(streaming.context.used).toBe(1_016)
    expect(streaming.context.output).toBe(8)
    expect(streaming.context.source).toBe('host')

    const settled = applyFrame(streaming, frame({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '正在写一段中文' }],
        usage: { ...EMPTY_USAGE, input: 1_000, output: 200, totalTokens: 1_200 },
      },
    }))

    // 权威 usage 到手后 live 归零，避免 used + live 重复计算。
    expect(settled.context.live).toBe(0)
    expect(settled.context.used).toBe(1_200)
    expect(settled.context.source).toBe('usage')
  })

  it('stamps every frame as a heartbeat and clears the stalled hint', () => {
    const started = run([{ type: 'agent_start' }])
    expect(started.lastFrameAt).toBeGreaterThan(0)

    const stalled = markStalled(started, '已 60 秒没有新输出，本轮可能卡住')
    expect(stalled.stalled).toBe(true)

    const alive = applyFrame(stalled, frame({ type: 'turn_start' }))
    expect(alive.stalled).toBe(false)
    expect(alive.lastFrameAt).toBeGreaterThan(stalled.lastFrameAt ?? 0)
  })

  it('unlocks a frozen timeline when the host reports it is idle', () => {
    const streaming = run([
      { type: 'agent_start' },
      stream({ type: 'text_start', content_index: 0 }),
      stream({ type: 'text_delta', content_index: 0, delta: '写了一半' }),
    ])
    expect(streaming.status).toBe('streaming')

    const unlocked = applyHostIdle(streaming, '宿主已空闲，但界面还在等这一轮', 1_700_000_999_999)
    expect(unlocked.status).toBe('idle')
    expect(unlocked.streaming).toBeUndefined()
    expect(unlocked.stalled).toBe(false)
    // 用户必须能看到「为什么自己解锁了」，而不是状态偷偷变了。
    expect(unlocked.blocks.some((block) => block.kind === 'notice' && block.title === '已自动解锁')).toBe(true)
    // 已经流出来的文字不能丢。
    expect(onlyAssistant(unlocked.blocks).text).toBe('写了一半')
  })
})
