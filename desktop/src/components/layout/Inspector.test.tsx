/**
 * 右侧工作台：标签、文件列表、以及每个文件的预览。
 *
 * 走的是真实链路：组件拿 `MockHost` 当宿主（`files.changes` / `files.diff` /
 * `files.read` 三个命令都有演示数据），所以这里断言的是用户真会看到的文字。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Inspector } from '@/components/layout/Inspector'
import { useFiles } from '@/store/filesStore'
import { FILES_TAB, HOME_TAB, useRail } from '@/store/railStore'
import { useSession } from '@/store/sessionStore'
import { useUi } from '@/store/uiStore'
import { EMPTY_TIMELINE } from '@/store/timeline'

function touchedTimeline() {
  return {
    ...EMPTY_TIMELINE,
    blocks: [
      {
        kind: 'tools' as const,
        id: 'tools-1',
        ts: 1,
        calls: [
          {
            id: 'call-1',
            name: 'read_file',
            args: { path: 'packages/fox_coding_agent/src/core/runtime.py' },
            status: 'success' as const,
            startedAt: 1,
            endedAt: 2,
            updates: [],
          },
        ],
      },
    ],
  }
}

describe('Inspector · 文件标签', () => {
  // 行内路径被拆成「目录 + 文件名」两个 span（目录先截断、文件名永远完整），
  // getByText 只看直接文本子节点，所以按 textContent 全等匹配整行。
  const pathRow = (path: string) => (_content: string, element: Element | null) =>
    element?.textContent === path

  beforeEach(() => {
    // 面板宽度会被「给中列留 MAIN_MIN_WIDTH」夹住，所以给个够宽的窗口，
    // 不然断言的是夹过之后的 300px（jsdom 默认 1024）。
    Object.defineProperty(window, 'innerWidth', {
      value: 1600,
      configurable: true,
      writable: true,
    })
    useFiles.setState({
      changes: null,
      loading: false,
      error: null,
      fetchedAt: null,
      previews: {},
    })
    // 面板默认停在「开始」；这些用例关心的是文件列表与预览，所以直接开「文件」。
    useRail.setState({ tabs: [HOME_TAB, FILES_TAB], activeId: FILES_TAB.id })
    useSession.setState({ timeline: EMPTY_TIMELINE })
  })

  it('lists workspace changes with status letters and line counts', async () => {
    render(<Inspector />)
    expect(
      await screen.findByText(pathRow('desktop/src/components/layout/Inspector.tsx')),
    ).toBeTruthy()
    // 修改 / 新增 / 未跟踪 / 二进制 四种行都在
    expect(screen.getByText(pathRow('desktop/src/store/filesStore.ts'))).toBeTruthy()
    expect(screen.getByText(pathRow('fox_serve/workspace_files.py'))).toBeTruthy()
    expect(screen.getByText('+128')).toBeTruthy()
    expect(screen.getByText('−24')).toBeTruthy()
    // 两行二进制（图片 + PDF）各有一个「二进制」标记
    expect(screen.getAllByText('二进制').length).toBe(2)
    expect(screen.getByText('工作区改动')).toBeTruthy()
  })

  it('browses workspace directories and opens files by their kind', async () => {
    render(<Inspector />)
    fireEvent.click(await screen.findByRole('button', { name: 'desktop' }))
    expect(await screen.findByRole('button', { name: '返回上级目录' })).toBeTruthy()
    // package.json 有「渲染」这一面：点开先看渲染出来的样子，原文是一个页签。
    fireEvent.click(await screen.findByRole('button', { name: 'package.json' }))
    expect(await screen.findByRole('tab', { name: '渲染' })).toBeTruthy()
    // JSON 树把字符串值连引号一起画出来（JsonViewer 的既有风格）。
    expect(await screen.findByText('"foxcode-desktop"')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '原文' }))
    expect(useFiles.getState().previews['desktop/package.json']).toMatchObject({
      path: 'desktop/package.json',
      mode: 'source',
    })
    // 没有「渲染」这一面的文件（这里是 main.py）还是直接给原文。
    fireEvent.click(screen.getByLabelText('返回文件列表'))
    fireEvent.click(await screen.findByRole('button', { name: '返回上级目录' }))
    fireEvent.click(await screen.findByRole('button', { name: 'main.py' }))
    expect(useFiles.getState().previews['main.py']).toMatchObject({
      path: 'main.py',
      mode: 'source',
    })
    // 没有「渲染」这一面的文件（这里是 main.py）还是直接给原文。前面打开的
    // package.json 仍然挂在那里（只是藏起来了），所以断言要落在当前那个标签上。
    const panels = document.querySelectorAll('[role="tabpanel"]')
    const active = panels[panels.length - 1] as HTMLElement
    expect(within(active).queryByRole('tab', { name: '渲染' })).toBeNull()
  })

  it('opens a diff preview when a changed file is clicked', async () => {
    render(<Inspector />)
    const row = (await screen.findByText(
      pathRow('desktop/src/components/layout/Inspector.tsx'),
    )) as HTMLElement
    fireEvent.click(row)

    // 预览头部：路径 + 差异/原文 切换 + 统计
    expect(await screen.findByRole('tab', { name: '差异' })).toBeTruthy()
    expect(screen.getByText('+9')).toBeTruthy()
    // 差异正文按行渲染（上下文行 + 新增行）
    expect(
      await screen.findByText('const timeline = useSession((s) => s.timeline)'),
    ).toBeTruthy()
    expect(
      screen.getByText('// 打开页签、每次工具调用结束后都重新拉一次清单'),
    ).toBeTruthy()
    // 工作台在有文件打开时变宽（宽度走 inline style，拖拽会覆盖它）
    expect(screen.getByLabelText('工作区面板').style.width).toBe('520px')
  })

  it('switches to the raw file and back to the list', async () => {
    render(<Inspector />)
    fireEvent.click(
      (await screen.findByText(pathRow('desktop/src/store/filesStore.ts'))) as HTMLElement,
    )
    fireEvent.click(await screen.findByRole('tab', { name: '原文' }))
    expect(
      await screen.findByText(/演示宿主：真实内容由 fox_serve 的 files\.read 提供/),
    ).toBeTruthy()

    fireEvent.click(screen.getByLabelText('返回文件列表'))
    expect(screen.getByText(pathRow('fox_serve/workspace_files.py'))).toBeTruthy()
    expect(screen.getByLabelText('工作区面板').style.width).toBe('360px')
  })

  it('lists the files this session touched and previews them as source', async () => {
    useSession.setState({ timeline: touchedTimeline() })
    render(<Inspector />)
    const header = await screen.findByText('本轮涉及 1 个文件')
    expect(header).toBeTruthy()
    // 列表里显示的是缩短后的路径，用 title（完整路径）定位那一行。
    fireEvent.click(screen.getByTitle('packages/fox_coding_agent/src/core/runtime.py'))
    expect(await screen.findByRole('tab', { name: '原文' })).toBeTruthy()
    const panel = screen.getByLabelText('工作区面板')
    // 高亮会把一行拆成多个 token span，所以按 textContent 全等匹配那一行。
    expect(
      within(panel).getByText(
        (_content, element) => element?.textContent === "export const name = 'runtime.py'",
      ),
    ).toBeTruthy()
  })

  it('renders an image instead of reporting it as a binary blob', async () => {
    render(<Inspector />)
    fireEvent.click(
      (await screen.findByText(
        pathRow('desktop/artifacts/dsh-workbench-dark.png'),
      )) as HTMLElement,
    )
    // 图片直接画出来：宿主给的 base64 塞进 <img>，差异/原文这两个页签对图片没有意义。
    const image = await screen.findByRole('img', { name: 'desktop/artifacts/dsh-workbench-dark.png' })
    expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(screen.queryByRole('tab', { name: '差异' })).toBeNull()
    // 尺寸跟着演示图片走（1200×800 的示意图约 5 KB），所以这里只认形状不认具体数字。
    expect(screen.getByText(/^PNG · [\d.]+ KB$/)).toBeTruthy()
    // 大图要缩到看得全：默认「适应窗口」，双击才回到原始大小（6000×4000 的截图以前会溢出）。
    expect(image.className).toContain('max-h-full')
    expect(image.className).toContain('object-contain')
    fireEvent.doubleClick(image)
    const actual = screen.getByRole('img', {
      name: 'desktop/artifacts/dsh-workbench-dark.png',
    })
    expect(actual.className).toContain('max-w-none')
    expect(actual.className).not.toContain('max-h-full')
  })

  it('renders a non-image binary file as a fact instead of a preview', async () => {
    render(<Inspector />)
    fireEvent.click((await screen.findByText(pathRow('docs/handbook.pdf'))) as HTMLElement)
    expect(await screen.findByText('二进制文件，无法预览差异')).toBeTruthy()
    fireEvent.click(screen.getByText('看原文'))
    expect(await screen.findByText('二进制文件，不能当文本预览。')).toBeTruthy()
  })

  it('drags the panel width step by step and resets on double click', async () => {
    useUi.setState({ inspectorWidth: null, sidebarWidth: 320 })
    render(<Inspector />)
    const handle = screen.getByLabelText('调整工作区面板宽度')
    const panel = screen.getByLabelText('工作区面板')
    // 窗口 1600、还没拖过：文件列表标签是导航，按内容要 360。
    expect(panel.style.width).toBe('360px')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(panel.style.width).toBe('376px')
    // 回归点：以前第二次就把增量丢了（`stored ?? width - delta`），拖一下之后再也拖不动。
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(panel.style.width).toBe('392px')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(panel.style.width).toBe('376px')
    // 双击回到「跟着内容自动」
    fireEvent.doubleClick(handle)
    expect(panel.style.width).toBe('360px')
  })
})
