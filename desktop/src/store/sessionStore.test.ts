import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyFrame, EMPTY_TIMELINE } from '@/store/timeline'
import { useSession } from '@/store/sessionStore'
import type { HostInfo, SessionSummary } from '@/types/protocol'

/**
 * 这一组用例盯的都是「界面卡住之后怎么自己回来」的行为 —— 也就是 m05802 报的那几件事：
 * 生成中不再有后续（结束帧丢了）、插话回不来、切页面像暂停、删会话不删文件。
 *
 * 演示宿主（`getBridge()` 在 jsdom 里给的就是 MockHost）与真实 `fox serve` 的语义在这几
 * 条路径上是刻意对齐的：`busy` 标志、插话被拒的中文文案，所以这里用同一个 store 测。
 */
const bridge = useSession.getState().bridge

async function hostInfo(overrides: Partial<HostInfo> = {}): Promise<HostInfo> {
  return { ...(await bridge.info()), ...overrides }
}

const session = (id: string, live = false): SessionSummary => ({
  id,
  file: `${id}.jsonl`,
  title: id,
  cwd: 'C:/work',
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
  totalTokens: 0,
  cost: 0,
  live,
})

beforeEach(async () => {
  // 模块级的 strike 计数要归零，否则上一个用例留下的状态会让下一个用例提前解锁。
  useSession.setState({ timeline: { ...EMPTY_TIMELINE }, queue: [], sessions: [] })
  await useSession.getState().reconcile()
})

describe('sessionStore recovery', () => {
  it('strips the leading slash from host command names', async () => {
    // 真实 `fox serve` 的命令名是 `/new`，而界面各处（补全、命令面板、技能页）都自己补斜杠：
    // 不归一化就会显示成 `//new`，手敲的 `/new` 也会匹配不上命令表。
    const base = await hostInfo()
    const info = vi.spyOn(bridge, 'info').mockResolvedValue({
      ...base,
      commands: [
        { name: '/new', description: '新建会话' },
        { name: '/permission', description: '切换权限档位', argumentHint: 'MODE' },
      ],
    })

    await useSession.getState().refreshHost()

    expect(useSession.getState().host?.commands.map((command) => command.name)).toEqual([
      'new',
      'permission',
    ])
    info.mockRestore()
  })

  it('keeps a busy send in the local queue instead of touching the host', async () => {
    const send = vi.spyOn(bridge, 'send')
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', activity: '模型生成中' },
    })

    await useSession.getState().prompt('顺便改一下注释')

    // 排队只落在输入框上方那些小框里（要能改、能删），所以一个请求都不该发。
    expect(send).not.toHaveBeenCalled()
    expect(useSession.getState().queue.map((item) => item.text)).toEqual(['顺便改一下注释'])
    expect(useSession.getState().timeline.blocks.filter((b) => b.kind === 'user')).toHaveLength(0)
  })

  it('edits and drops queued messages', async () => {
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', activity: '模型生成中' },
    })
    await useSession.getState().followUp('先改注释')
    await useSession.getState().followUp('再跑一遍测试')

    const [first, second] = useSession.getState().queue
    useSession.getState().updateQueued(first.id, '先改注释（补一句）')
    expect(useSession.getState().queue[0].text).toBe('先改注释（补一句）')

    // 空的改写不算改写，否则小框会被清成一条看不见的消息。
    useSession.getState().updateQueued(first.id, '   ')
    expect(useSession.getState().queue[0].text).toBe('先改注释（补一句）')

    useSession.getState().dropQueued(first.id)
    expect(useSession.getState().queue.map((item) => item.id)).toEqual([second.id])
  })

  it('drains the queue one message per finished turn', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    const base = await hostInfo()
    const info = vi.spyOn(bridge, 'info').mockResolvedValue({
      ...base,
      busy: false,
      commands: [{ name: '/compact', description: '压缩当前会话上下文' }],
    })
    await useSession.getState().followUp('第一条')
    await useSession.getState().followUp('第二条')
    useSession.setState({ timeline: { ...EMPTY_TIMELINE, status: 'idle' } })

    await useSession.getState().drainQueue()

    // 一次只放一条：多条一起发会被宿主当成同一轮里的同一句话。
    expect(send.mock.calls.map(([command]) => command.method)).toEqual(['prompt'])
    expect(useSession.getState().queue.map((item) => item.text)).toEqual(['第二条'])
    expect(useSession.getState().timeline.status).toBe('streaming')
    // The host refresh performed by queue draining must not put the wire-level
    // leading slash back, or `/压缩` stops matching immediately after queuing.
    expect(useSession.getState().host?.commands[0].name).toBe('compact')
    info.mockRestore()
  })

  it('asks the host before draining: a busy host keeps the queue local', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    vi.spyOn(bridge, 'info').mockResolvedValue(await hostInfo({ busy: true }))
    await useSession.getState().followUp('等宿主真空闲')
    useSession.setState({ timeline: { ...EMPTY_TIMELINE, status: 'idle' } })

    await useSession.getState().drainQueue()

    // 真机上就是这里发早过：宿主回 `RuntimeError: Harness is already processing. Use
    // steer() or follow_up(...)`，而请求本身是成功的（错误是**帧**不是请求异常），
    // 那条消息于是既没被执行、也从队列里消失了。宿主说忙就一个字都别发。
    expect(send).not.toHaveBeenCalled()
    expect(useSession.getState().queue.map((item) => item.text)).toEqual(['等宿主真空闲'])
  })

  it('leaves the queue alone while a turn is still running', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    await useSession.getState().followUp('等一会儿')
    useSession.setState({ timeline: { ...EMPTY_TIMELINE, status: 'streaming' } })

    await useSession.getState().drainQueue()

    expect(send).not.toHaveBeenCalled()
    expect(useSession.getState().queue).toHaveLength(1)
  })

  it('steers a queued message out of turn and drops it from the queue', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', activity: '模型生成中' },
    })
    await useSession.getState().followUp('先做这个')

    await useSession.getState().steerQueued(useSession.getState().queue[0].id)

    expect(send).toHaveBeenCalledWith({
      method: 'steer',
      params: { message: '先做这个', promoteFollowUps: true, interrupt: true },
    })
    expect(useSession.getState().queue).toHaveLength(0)
    const users = useSession.getState().timeline.blocks.filter((block) => block.kind === 'user')
    expect(users.every((block) => block.kind === 'user' && block.queued === 'steer')).toBe(true)
  })

  it('marks an explicitly steered message as inserted', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming' },
    })

    await useSession.getState().steer('现在就处理', true)

    expect(send).toHaveBeenCalledWith({
      method: 'steer',
      params: { message: '现在就处理', promoteFollowUps: true, interrupt: true },
    })
    const users = useSession.getState().timeline.blocks.filter((block) => block.kind === 'user')
    expect(users.every((block) => block.kind === 'user' && block.queued === 'steer')).toBe(true)
  })

  it('needs the host to insist twice before unlocking a stuck run', async () => {
    const info = vi
      .spyOn(bridge, 'info')
      .mockResolvedValue(await hostInfo({ busy: false, lastFrameAt: Date.now() - 30_000 }))
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', lastFrameAt: Date.now() - 10_000 },
    })

    await useSession.getState().reconcile()
    // 只对账一次还不够：刚回车的那一瞬间宿主也可能还没开始跑。
    expect(useSession.getState().timeline.status).toBe('streaming')

    await useSession.getState().reconcile()
    const timeline = useSession.getState().timeline
    expect(timeline.status).toBe('idle')
    expect(timeline.blocks.some((block) => block.kind === 'notice' && block.title === '已自动解锁')).toBe(true)

    info.mockRestore()
  })

  it('waits for the host to fall silent before trusting an idle report', async () => {
    // 「这一轮抛错后紧跟重试」的窗口里 `busy` 会短暂变回 false，而它还在跑。
    vi.spyOn(bridge, 'info').mockResolvedValue(
      await hostInfo({ busy: false, lastFrameAt: Date.now() - 500 }),
    )
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', lastFrameAt: Date.now() - 60_000 },
    })

    await useSession.getState().reconcile()
    await useSession.getState().reconcile()
    await useSession.getState().reconcile()

    expect(useSession.getState().timeline.status).toBe('streaming')
  })

  it('leaves a live run alone while the host says it is busy', async () => {
    vi.spyOn(bridge, 'info').mockResolvedValue(await hostInfo({ busy: true }))
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', lastFrameAt: Date.now() - 60_000 },
    })

    await useSession.getState().reconcile()
    await useSession.getState().reconcile()

    expect(useSession.getState().timeline.status).toBe('streaming')
  })

  it('marks a silent run as possibly stuck', async () => {
    vi.spyOn(bridge, 'info').mockResolvedValue(await hostInfo({ busy: true }))
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', lastFrameAt: Date.now() - 60_000 },
    })

    await useSession.getState().reconcile()

    const timeline = useSession.getState().timeline
    expect(timeline.stalled).toBe(true)
    expect(timeline.activity).toContain('没有新输出')
  })

  it('shows stop feedback before the host acknowledges abort', async () => {
    let acknowledge!: () => void
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    const send = vi.spyOn(bridge, 'send').mockImplementation(async (command) => {
      if (command.method === 'abort') await pending
      return null
    })
    useSession.setState({
      timeline: { ...EMPTY_TIMELINE, status: 'streaming', activity: '模型生成中' },
    })

    const stopping = useSession.getState().abort()
    expect(useSession.getState().timeline.activity).toBe('正在中止…')
    expect(send.mock.calls.map(([command]) => command.method)).toEqual(['abort'])

    acknowledge()
    await stopping
  })

  it('clears the streaming lock when the prompt never reached the host', async () => {
    // 桥断了的时候对账也叫不醒界面（同一座桥），所以发送失败必须自己收尾。
    const send = vi.spyOn(bridge, 'send').mockRejectedValue(new Error('sidecar 已退出'))
    useSession.setState({ timeline: { ...EMPTY_TIMELINE } })

    await useSession.getState().startRun('在吗')

    const timeline = useSession.getState().timeline
    expect(send.mock.calls.map(([command]) => command.method)).toEqual(['prompt'])
    expect(timeline.status).toBe('idle')
    expect(timeline.activity).toBe('空闲')
    // 用户那条消息仍然留着：发送失败不等于用户没说话。
    expect(timeline.blocks.filter((block) => block.kind === 'user')).toHaveLength(1)
  })

  it('keeps the run going when frames prove the host got the prompt', async () => {
    // 宿主其实收了（帧都来了），只是响应回执失败 —— 不能把正在跑的一轮判成没发出去。
    vi.spyOn(bridge, 'send').mockImplementation(async (command) => {
      if (command.method === 'prompt') {
        useSession.setState((state) => ({
          timeline: applyFrame(state.timeline, {
            type: 'agent_start',
            seq: 1,
            ts: Date.now(),
            v: 1,
          }),
        }))
        throw new Error('写入超时')
      }
      return null
    })
    useSession.setState({ timeline: { ...EMPTY_TIMELINE } })

    await useSession.getState().startRun('继续')

    expect(useSession.getState().timeline.status).toBe('streaming')
  })

  it('opens a new session before deleting the live one', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    useSession.setState({ sessions: [session('live', true)] })

    await useSession.getState().deleteSession('live')

    // 宿主拒绝删除「正在使用的会话」，所以必须先切走 —— 否则用户看到的是
    // 「删了但 json 文件还在」。
    expect(send.mock.calls.map(([command]) => command.method)).toEqual([
      'sessions.new',
      'sessions.delete',
    ])
  })

  it('deletes a finished session without switching away', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    useSession.setState({ sessions: [session('old', false)] })

    await useSession.getState().deleteSession('old')

    expect(send.mock.calls.map(([command]) => command.method)).toEqual(['sessions.delete'])
  })

  it('does not reopen or interrupt the live session', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    useSession.setState({
      host: await hostInfo({ sessionFile: 'C:\\work\\live.jsonl', busy: true }),
      sessions: [{ ...session('live', true), file: 'C:/work/live.jsonl' }],
      timeline: { ...EMPTY_TIMELINE, status: 'streaming' },
    })

    await useSession.getState().openSession('live')

    expect(send).not.toHaveBeenCalled()
    expect(useSession.getState().timeline.status).toBe('streaming')
  })
})
