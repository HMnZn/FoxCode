import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '@/App'
import { getBridge } from '@/bridge'
import { useSession } from '@/store/sessionStore'
import { useUi } from '@/store/uiStore'
import { useWorkspace } from '@/store/workspaceStore'

const IDLE_COMPOSER = '描述任务，/ 唤起命令，Shift + Enter 换行'
/** The shell refuses to start without a workspace: tests seed the demo host's. */
const WORKSPACE = 'C:\\Users\\Qin\\Desktop\\coding_agent\\FoxCode'

/**
 * Mounts the real shell against the built-in demo host.
 *
 * The Electron runtime itself cannot start inside a tool sandbox, so these
 * tests are the automated stand-in: they prove the whole component tree renders,
 * the keyboard layer works, and a prompt round-trips through the bridge into the
 * timeline.
 */
describe('FoxCode Studio shell', () => {
  beforeEach(() => {
    useUi.setState({ view: 'chat', paletteOpen: false, inspectorOpen: true, chatView: 'chat' })
    useSession.getState().clearTimeline()
    // A workspace always exists once the user has chosen one; the gate itself is
    // covered by the "asks for a workspace" case below.
    useWorkspace.setState({ current: WORKSPACE, recent: [WORKSPACE], applying: null, syncedFor: null })
  })

  afterEach(() => {
    useSession.getState().abort()
    useWorkspace.setState({ current: null, recent: [], applying: null, syncedFor: null })
  })

  it('falls back to the in-renderer demo host', () => {
    expect(getBridge().kind).toBe('mock')
  })

  it('renders the workbench: window strip, sidebar, chat', async () => {
    render(<App />)

    // DSH parity: the brand lives in the sidebar, the strip carries the window
    // chrome (sidebar toggle +当前会话).
    expect(screen.getByRole('button', { name: '切换侧栏' })).toBeTruthy()
    expect(screen.getByText('灵狐')).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建会话' })).toBeTruthy()
    expect(screen.getByPlaceholderText(IDLE_COMPOSER)).toBeTruthy()

    // The host info round-trip populates the session file shown in the title bar.
    await waitFor(() => {
      expect(useSession.getState().host).not.toBeNull()
    })
  })

  it('asks for a workspace before anything else can happen', async () => {
    useWorkspace.setState({ current: null, recent: [WORKSPACE], applying: null, syncedFor: null })

    render(<App />)

    // The gate replaces the workbench entirely: no sidebar, no composer.
    expect(screen.getByRole('heading', { name: '选择一个工作区' })).toBeTruthy()
    expect(screen.queryByPlaceholderText(IDLE_COMPOSER)).toBeNull()
    expect(screen.queryByRole('button', { name: '新建会话' })).toBeNull()

    // Keyboard shortcuts stay inert while the gate is up.
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(document.querySelector('[aria-label="命令面板"]')).toBeNull()

    // A remembered folder is one click away, and choosing it opens the shell.
    fireEvent.click(screen.getByRole('button', { name: WORKSPACE }))
    await waitFor(() => {
      expect(screen.getByPlaceholderText(IDLE_COMPOSER)).toBeTruthy()
    })
    expect(screen.queryByRole('heading', { name: '选择一个工作区' })).toBeNull()
  })

  it('carries the 灵狐 brand into the sidebar and the empty state', () => {
    render(<App />)

    // Sidebar brand row: wordmark + the Chinese brand suffix.
    expect(screen.getAllByText('FoxCode').length).toBeGreaterThan(0)
    expect(screen.getByText('灵狐')).toBeTruthy()

    // The welcome mascot is announced as an image; the marks that sit next to
    // real text stay decorative (`aria-hidden`) so they are not read out twice.
    expect(screen.getAllByRole('img', { name: 'FoxCode 灵狐' }).length).toBeGreaterThan(0)
    expect(document.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThan(0)
  })

  it('toggles the command palette with the keyboard', async () => {
    render(<App />)

    expect(document.querySelector('[aria-label="命令面板"]')).toBeNull()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true })

    await waitFor(() => {
      expect(document.querySelector('[aria-label="命令面板"]')).not.toBeNull()
    })

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    await waitFor(() => {
      expect(document.querySelector('[aria-label="命令面板"]')).toBeNull()
    })
  })

  it('streams a prompt from the composer into the timeline', async () => {
    render(<App />)

    const composer = screen.getByPlaceholderText(IDLE_COMPOSER)
    fireEvent.change(composer, { target: { value: '为 timeline reducer 补一个测试' } })
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })

    // MockHost echoes the user message immediately, then streams the script.
    await waitFor(() => {
      expect(useSession.getState().timeline.blocks[0]?.kind).toBe('user')
    })

    const [first] = useSession.getState().timeline.blocks
    expect(first.kind === 'user' && first.text).toBe('为 timeline reducer 补一个测试')
    expect(useSession.getState().timeline.status).toBe('streaming')
  })

  it('switches views without losing the session store', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => {
      expect(useUi.getState().view).toBe('settings')
    })

    // 设置页的分节导航里也有一个「会话」，所以要把查询限定在侧栏主导航。
    const sidebar = screen.getByRole('navigation', { name: '主导航' })
    fireEvent.click(within(sidebar).getByRole('button', { name: '会话' }))
    await waitFor(() => {
      expect(useUi.getState().view).toBe('chat')
    })
    expect(useSession.getState().host).not.toBeNull()
  })

  it('keeps a run flowing while another view is on screen', async () => {
    render(<App />)

    const composer = screen.getByPlaceholderText(IDLE_COMPOSER)
    fireEvent.change(composer, { target: { value: '写一段较长的事件流说明' } })
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })

    // 「切到别的功能会话就暂停了」：ChatPage 卸载了，但帧必须继续进 store。
    fireEvent.click(screen.getByRole('button', { name: '用量' }))
    await waitFor(() => {
      expect(useUi.getState().view).toBe('usage')
    })

    const streamedLength = () =>
      useSession
        .getState()
        .timeline.blocks.flatMap((block) =>
          block.kind === 'assistant' ? [block.text.length + block.thinking.length] : [],
        )
        .reduce((total, length) => total + length, 0)

    // 演示脚本先流思考再流正文；耐心等它开始吐字（默认 1s 不够）。
    const before = await waitFor(
      () => {
        const length = streamedLength()
        expect(length).toBeGreaterThan(0)
        return length
      },
      { timeout: 5_000 },
    )

    // 人在「用量」页，正文仍然在长 —— 这才是「没有暂停」的证据。
    await waitFor(
      () => {
        expect(streamedLength()).toBeGreaterThan(before)
      },
      { timeout: 5_000 },
    )

    const sidebar = screen.getByRole('navigation', { name: '主导航' })
    fireEvent.click(within(sidebar).getByRole('button', { name: '会话' }))
    await waitFor(() => {
      expect(useUi.getState().view).toBe('chat')
    })
    expect(streamedLength()).toBeGreaterThanOrEqual(before)
  })

  it('switches the chat page between 会话 and 轨迹', async () => {
    render(<App />)

    // 会话视角：欢迎区在，轨迹摘要不在。
    await waitFor(() => {
      expect(screen.getByText('开始一段新会话')).toBeTruthy()
    })
    expect(screen.queryByText('执行轨迹')).toBeNull()

    // 「轨迹」段与侧栏的「会话」同名，查询要限定在分段控件内。
    const switcher = screen.getByRole('group', { name: '会话与轨迹切换' })

    fireEvent.click(within(switcher).getByRole('button', { name: '轨迹' }))
    await waitFor(() => {
      expect(useUi.getState().chatView).toBe('trace')
    })
    expect(screen.getByText('执行轨迹')).toBeTruthy()
    expect(screen.getByText('还没有工具调用')).toBeTruthy()

    fireEvent.click(within(switcher).getByRole('button', { name: '会话' }))
    await waitFor(() => {
      expect(useUi.getState().chatView).toBe('chat')
    })
    expect(screen.getByText('开始一段新会话')).toBeTruthy()
  })

  it('refreshes the context usage after a manual compact', async () => {
    render(<App />)
    await waitFor(() => {
      expect(useSession.getState().host).not.toBeNull()
    })

    // 模拟一次已经跑满上下文的状态，然后压缩：MockHost 回 74,312 → 19,880。
    useSession.setState((state) => ({
      timeline: {
        ...state.timeline,
        context: {
          used: 74_312,
          input: 70_000,
          cacheRead: 4_000,
          cacheWrite: 0,
          output: 312,
          limit: 262_100,
          source: 'usage',
        },
      },
    }))
    await useSession.getState().compact()

    await waitFor(() => {
      expect(useSession.getState().timeline.context.used).toBe(19_880)
    })
    expect(useSession.getState().timeline.context.source).toBe('compaction')
    expect(useSession.getState().timeline.context.used).toBeLessThan(74_312)
    // 压缩事件同样落成时间线里的一条通知。
    await waitFor(() => {
      expect(screen.getByText(/移除 42 条/)).toBeTruthy()
    })
  })

  it('deletes a session through the confirmation dialog', async () => {
    render(<App />)

    await waitFor(() => {
      expect(useSession.getState().sessions.length).toBeGreaterThan(1)
    })
    const before = useSession.getState().sessions.length

    // 当前活动会话的删除按钮是禁用的，这里挑一个可删除的历史会话。
    const buttons = await waitFor(() => {
      const found = screen
        .getAllByRole('button', { name: /^删除会话 / })
        .filter((node) => !(node as HTMLButtonElement).disabled)
      expect(found.length).toBeGreaterThan(0)
      return found
    })

    fireEvent.click(buttons[0])
    await waitFor(() => {
      expect(screen.getByText('删除这个会话？')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(useSession.getState().sessions.length).toBe(before - 1)
    })
    expect(useSession.getState().sessions.length).toBeLessThan(before)
  })
})
