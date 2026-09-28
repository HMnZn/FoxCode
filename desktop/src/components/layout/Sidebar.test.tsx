import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@/components/layout/Sidebar'
import { EMPTY_TIMELINE } from '@/store/timeline'
import { usePins } from '@/store/pinStore'
import { useSession } from '@/store/sessionStore'
import { useUi } from '@/store/uiStore'
import { useWorkspace } from '@/store/workspaceStore'
import type { SessionSummary } from '@/types/protocol'

const ROOT = 'C:\\work\\FoxCode'
const OTHER = 'C:\\work\\demo'

function session(id: string, cwd: string, title: string): SessionSummary {
  return {
    id,
    file: `${cwd}\\.foxcode\\${id}.jsonl`,
    title,
    cwd,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    totalTokens: 10,
    cost: 0,
    live: false,
  }
}

/** 会话行的 aria-label，按渲染顺序；只有展开的工作区会出现。 */
function sessionRows(): (string | null)[] {
  return screen
    .getAllByRole('button', { name: /^打开会话 / })
    .map((node) => node.getAttribute('aria-label'))
}

describe('Sidebar workspace tree', () => {
  const original = useSession.getState()

  beforeEach(() => {
    window.localStorage.clear()
    usePins.setState({ pinned: [] })
    useUi.setState({ sidebarCollapsed: false, view: 'chat' })
    useWorkspace.setState({
      current: ROOT,
      recent: [ROOT, OTHER],
      aliases: {},
      hidden: [],
      syncedFor: ROOT,
      applying: null,
      failedFor: null,
      failedHostCwd: null,
      lastError: null,
    })
    useSession.setState({
      host: { cwd: ROOT, sessionFile: `${ROOT}\\current.jsonl` } as never,
      sessions: [session('root-1', ROOT, '根目录会话'), session('other-1', OTHER, '其他工作区会话')],
      timeline: { ...EMPTY_TIMELINE },
      openSession: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      changeCwd: vi.fn(async () => {}),
      renameSession: vi.fn(async () => {}),
      forkSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
    })
  })

  afterEach(() => {
    useSession.setState({
      openSession: original.openSession,
      newSession: original.newSession,
      changeCwd: original.changeCwd,
      renameSession: original.renameSession,
      forkSession: original.forkSession,
      deleteSession: original.deleteSession,
      host: null,
      sessions: [],
      timeline: { ...EMPTY_TIMELINE },
    })
    useWorkspace.setState({ current: null, recent: [], aliases: {}, hidden: [], syncedFor: null })
    usePins.setState({ pinned: [] })
  })

  it('only expands and collapses a workspace folder', () => {
    render(<Sidebar />)

    expect(screen.queryByText('其他工作区会话')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开工作区 demo' }))
    expect(screen.getByText('其他工作区会话')).toBeTruthy()
    expect(useSession.getState().newSession).not.toHaveBeenCalled()
    expect(useSession.getState().openSession).not.toHaveBeenCalled()
    expect(useWorkspace.getState().current).toBe(ROOT)

    fireEvent.click(screen.getByRole('button', { name: '折叠工作区 demo' }))
    expect(screen.queryByText('其他工作区会话')).toBeNull()
  })

  it('creates a session only from the new-session button', () => {
    useSession.setState({
      timeline: {
        ...EMPTY_TIMELINE,
        blocks: [{ kind: 'user', id: 'u1', ts: 1, text: '已有内容' }],
      },
    })
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }))
    expect(useSession.getState().newSession).toHaveBeenCalledOnce()
  })

  it('opens a session from another workspace and adopts its cwd', async () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: '展开工作区 demo' }))
    fireEvent.click(screen.getByRole('button', { name: '打开会话 其他工作区会话' }))

    await vi.waitFor(() => {
      expect(useSession.getState().openSession).toHaveBeenCalledWith('other-1')
    })
    expect(useWorkspace.getState().current).toBe(OTHER)
    expect(useSession.getState().newSession).not.toHaveBeenCalled()
  })

  it('starts a conversation in the current workspace without moving cwd', () => {
    useSession.setState({
      timeline: {
        ...EMPTY_TIMELINE,
        blocks: [{ kind: 'user', id: 'u1', ts: 1, text: '已有内容' }],
      },
    })
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '在 FoxCode 新建对话' }))

    expect(useSession.getState().newSession).toHaveBeenCalledOnce()
    expect(useSession.getState().changeCwd).not.toHaveBeenCalled()
    expect(useWorkspace.getState().current).toBe(ROOT)
  })

  it('starts a conversation in another folder by switching workspace', async () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '在 demo 新建对话' }))

    // 宿主的 cwd.change 会在新目录下开一条会话，所以这里不需要 newSession。
    await vi.waitFor(() => {
      expect(useSession.getState().changeCwd).toHaveBeenCalledWith(OTHER)
    })
    expect(useSession.getState().newSession).not.toHaveBeenCalled()
  })

  it('renames a workspace by alias and restores the folder name when cleared', async () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '工作区操作 demo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByLabelText('工作区名称')
    fireEvent.change(input, { target: { value: '演示项目' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(screen.getByRole('button', { name: '展开工作区 演示项目' })).toBeTruthy()
    // 路径没变：别名只影响显示，切工作区仍然点的是这个文件夹。
    expect(useWorkspace.getState().current).toBe(ROOT)
    expect(useWorkspace.getState().recent).toEqual([ROOT, OTHER])

    fireEvent.click(screen.getByRole('button', { name: '工作区操作 演示项目' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const again = await screen.findByLabelText('工作区名称')
    fireEvent.change(again, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(screen.getByRole('button', { name: '展开工作区 demo' })).toBeTruthy()
  })

  it('removes a workspace from the list without deleting the folder', async () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '工作区操作 demo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '从列表移除' }))
    fireEvent.click(await screen.findByRole('button', { name: '移除' }))

    expect(useWorkspace.getState().hidden).toEqual([OTHER])
    // 会话的 cwd 仍然指向这个目录，但隐藏名单让它不再冒出来。
    expect(screen.queryByRole('button', { name: /工作区 demo$/ })).toBeNull()
  })

  it('refuses to remove the workspace the host is rooted in', () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '工作区操作 FoxCode' }))
    const item = screen.getByRole('menuitem', { name: /从列表移除/ })

    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: '折叠工作区 FoxCode' })).toBeTruthy()
  })

  it('pins a session to the top of its workspace', async () => {
    useSession.setState({
      sessions: [
        { ...session('root-1', ROOT, '根目录会话'), updatedAt: 9 },
        { ...session('root-2', ROOT, '更早的会话'), updatedAt: 2 },
      ],
    })
    render(<Sidebar />)

    expect(sessionRows()).toEqual(['打开会话 根目录会话', '打开会话 更早的会话'])

    fireEvent.click(screen.getByRole('button', { name: '会话操作 更早的会话' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶会话' }))

    await vi.waitFor(() => {
      expect(sessionRows()).toEqual(['打开会话 更早的会话', '打开会话 根目录会话'])
    })
    expect(usePins.getState().pinned).toEqual(['root-2'])
  })

  it('renames, forks and deletes a session from its menu', async () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '会话操作 根目录会话' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByLabelText('会话名称')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(useSession.getState().renameSession).toHaveBeenCalledWith('root-1', '新标题')
    })

    fireEvent.click(screen.getByRole('button', { name: '会话操作 根目录会话' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分叉会话' }))
    await vi.waitFor(() => {
      expect(useSession.getState().forkSession).toHaveBeenCalledWith('root-1')
    })

    fireEvent.click(screen.getByRole('button', { name: '会话操作 根目录会话' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '永久删除会话' }))
    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }))
    await vi.waitFor(() => {
      expect(useSession.getState().deleteSession).toHaveBeenCalledWith('root-1')
    })
  })
})
