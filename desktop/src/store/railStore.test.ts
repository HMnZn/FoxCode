/**
 * 右侧工作台的标签模型：打开 / 去重 / 切换 / 关闭。
 *
 * 这里不碰 DOM：标签是纯状态，组件只把它画出来（真的有对话框的那套在
 * `components/layout/Inspector.test.tsx`）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { FILES_TAB, HOME_TAB, TERMINAL_TAB, fileTabId, useRail } from '@/store/railStore'
import { useFiles } from '@/store/filesStore'
import { useTerminal } from '@/store/terminalStore'
import { useUi } from '@/store/uiStore'
import { EMPTY_SCREEN } from '@/lib/terminalText'

describe('railStore', () => {
  beforeEach(() => {
    useRail.setState({ tabs: [HOME_TAB], activeId: HOME_TAB.id })
    useFiles.setState({ previews: {}, changes: null, loading: false, error: null, fetchedAt: null })
    useTerminal.setState({
      status: 'idle',
      id: null,
      shell: null,
      cwd: null,
      exitCode: null,
      error: null,
      screen: EMPTY_SCREEN,
      input: '',
      history: [],
      cursor: null,
    })
    useUi.setState({ inspectorOpen: false })
  })

  it('opens a file as its own tab and focuses it', () => {
    useRail.getState().openFile('src/main.ts')
    const state = useRail.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([HOME_TAB.id, fileTabId('src/main.ts')])
    expect(state.activeId).toBe(fileTabId('src/main.ts'))
    // 打开面板：标签在收起来的面板里没有意义。
    expect(useUi.getState().inspectorOpen).toBe(true)
  })

  it('never opens the same file twice', () => {
    useRail.getState().openFile('src/main.ts')
    useRail.getState().openFiles()
    useRail.getState().openFile('src/main.ts')
    const ids = useRail.getState().tabs.map((tab) => tab.id)
    expect(ids).toEqual([HOME_TAB.id, fileTabId('src/main.ts'), FILES_TAB.id])
    expect(useRail.getState().activeId).toBe(fileTabId('src/main.ts'))
  })

  it('keeps the mode the user picked when a file is reopened', async () => {
    useRail.getState().openFile('docs/readme.md', 'source')
    await Promise.resolve()
    useRail.getState().openFiles()
    useRail.getState().openFile('docs/readme.md', 'diff')
    expect(useFiles.getState().previews['docs/readme.md'].mode).toBe('source')
  })

  it('falls back to the tab on the left when the active one closes', () => {
    useRail.getState().openFiles()
    useRail.getState().openFile('a.ts')
    useRail.getState().close(fileTabId('a.ts'))
    expect(useRail.getState().activeId).toBe(FILES_TAB.id)
    expect(useRail.getState().tabs.map((tab) => tab.id)).toEqual([HOME_TAB.id, FILES_TAB.id])
    // 关掉文件标签同时丢掉它的预览内容。
    expect(useFiles.getState().previews['a.ts']).toBeUndefined()
  })

  it('keeps 开始 around when everything else is closed', () => {
    useRail.getState().openFiles()
    useRail.getState().close(FILES_TAB.id)
    expect(useRail.getState().tabs).toEqual([HOME_TAB])
    expect(useRail.getState().activeId).toBe(HOME_TAB.id)
    // 「开始」自己没有关闭按钮，直接调 close 也不该把它关掉。
    useRail.getState().close(HOME_TAB.id)
    expect(useRail.getState().tabs).toEqual([HOME_TAB])
  })

  it('toggles the terminal tab and kills its shell when it closes', () => {
    useTerminal.setState({ status: 'running', id: 'term-1', shell: 'cmd.exe', cwd: 'C:\\work' })
    useRail.getState().toggleTerminal()
    expect(useRail.getState().activeId).toBe(TERMINAL_TAB.id)
    expect(useUi.getState().inspectorOpen).toBe(true)
    // 再按一次 Ctrl+` 收起来：标签没了，shell 也不再是 running。
    useRail.getState().toggleTerminal()
    expect(useRail.getState().tabs.map((tab) => tab.id)).toEqual([HOME_TAB.id])
    expect(useTerminal.getState().status).toBe('exited')
    expect(useTerminal.getState().id).toBeNull()
  })
})
