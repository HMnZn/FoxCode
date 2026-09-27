/**
 * 检查器「文件」页签：改动清单 → 差异 → 原文 → 返回。
 *
 * 走的是真实链路：组件拿 `MockHost` 当宿主（`files.changes` / `files.diff` /
 * `files.read` 三个命令都有演示数据），所以这里断言的是用户真会看到的文字。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Inspector } from '@/components/layout/Inspector'
import { useFiles } from '@/store/filesStore'
import { useUi } from '@/store/uiStore'
import { useSession } from '@/store/sessionStore'
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

describe('Inspector · 文件页签', () => {
  // 行内路径被拆成「目录 + 文件名」两个 span（目录先截断、文件名永远完整），
  // getByText 只看直接文本子节点，所以按 textContent 全等匹配整行。
  const pathRow = (path: string) => (_content: string, element: Element | null) =>
    element?.textContent === path

  beforeEach(() => {
    useFiles.setState({
      changes: null,
      loading: false,
      error: null,
      fetchedAt: null,
      preview: null,
    })
    useUi.setState({ inspectorTab: 'files' })
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
    expect(screen.getByText('二进制')).toBeTruthy()
    expect(screen.getByText('工作区改动')).toBeTruthy()
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
    // 检查器在预览时变宽
    expect(screen.getByLabelText('检查器').className).toContain('w-[420px]')
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
    expect(screen.getByLabelText('检查器').className).toContain('w-[300px]')
  })

  it('lists the files this session touched and previews them as source', async () => {
    useSession.setState({ timeline: touchedTimeline() })
    render(<Inspector />)
    const header = await screen.findByText('本轮涉及 1 个文件')
    expect(header).toBeTruthy()
    // 列表里显示的是缩短后的路径，用 title（完整路径）定位那一行。
    fireEvent.click(screen.getByTitle('packages/fox_coding_agent/src/core/runtime.py'))
    expect(await screen.findByRole('tab', { name: '原文' })).toBeTruthy()
    const panel = screen.getByLabelText('检查器')
    // 高亮会把一行拆成多个 token span，所以按 textContent 全等匹配那一行。
    expect(
      within(panel).getByText(
        (_content, element) => element?.textContent === "export const name = 'runtime.py'",
      ),
    ).toBeTruthy()
  })

  it('renders a binary file as a fact instead of a preview', async () => {
    render(<Inspector />)
    fireEvent.click(
      (await screen.findByText(
        pathRow('desktop/artifacts/dsh-workbench-dark.png'),
      )) as HTMLElement,
    )
    expect(await screen.findByText('二进制文件，无法预览差异')).toBeTruthy()
    expect(screen.getByText('看原文')).toBeTruthy()
  })
})
