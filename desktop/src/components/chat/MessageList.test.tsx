import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { Block, PlanBlock, ToolCallState, ToolsBlock } from '@/store/timeline'
import { useSession } from '@/store/sessionStore'
import { useFiles } from '@/store/filesStore'

function call(name: string, id: string, status: ToolCallState['status'] = 'success'): ToolCallState {
  return { id, name, args: { path: 'packages/fox_agent_core/README.md' }, status, startedAt: 0, updates: [] }
}

function toolsBlock(calls: ToolCallState[]): ToolsBlock {
  return { kind: 'tools', id: 't1', ts: 0, calls }
}

function renderBlocks(blocks: Block[]) {
  return render(<MessageList blocks={blocks} status="idle" />)
}

describe('MessageList tool group', () => {
  beforeEach(() => {
    useFiles.setState({ changes: null, loading: false, error: null, fetchedAt: null, previews: {} })
  })

  it('lists the called tool names in one collapsed row', () => {
    renderBlocks([toolsBlock([call('read_file', 'c1'), call('grep', 'c2'), call('grep', 'c3')])])

    expect(screen.getByText('3 项工具调用')).toBeTruthy()
    // Unique names in call order, repeats counted — the whole point of the row.
    expect(screen.getByText('read_file · grep ×2')).toBeTruthy()
    expect(screen.getByText('展开')).toBeTruthy()
    // Collapsed by default: the per-call cards only exist after expanding.
    expect(screen.queryByText('packages/fox_agent_core/README.md')).toBeNull()
  })

  it('expands and collapses on click', () => {
    renderBlocks([toolsBlock([call('read_file', 'c1')])])

    fireEvent.click(screen.getByText('1 项工具调用').closest('button') as HTMLButtonElement)
    expect(screen.getByText('收起')).toBeTruthy()
    expect(screen.getAllByText(/packages\/fox_agent_core\/README\.md/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('1 项工具调用').closest('button') as HTMLButtonElement)
    expect(screen.getByText('展开')).toBeTruthy()
    expect(screen.queryByText(/packages\/fox_agent_core\/README\.md/)).toBeNull()
  })

  it('shows a one-line ls result even while the tool group is collapsed', () => {
    const ls = call('ls', 'c1')
    ls.result = '.foxcode/\nmain.py'
    renderBlocks([toolsBlock([ls])])

    expect(screen.getByText('1 项工具调用').closest('button')?.textContent).toContain(
      'ls · .foxcode/',
    )
    expect(screen.getByText('展开')).toBeTruthy()
  })

  it('opens itself while a call waits for approval, and flags failures', () => {
    renderBlocks([toolsBlock([call('bash', 'c1', 'awaiting-approval')])])

    // The row that explains what is asking for permission must not stay folded.
    expect(screen.getByText('收起')).toBeTruthy()
    expect(screen.getByText('1 运行中')).toBeTruthy()

    renderBlocks([toolsBlock([call('edit', 'c2', 'error')])])
    expect(screen.getAllByText('1 失败').length).toBeGreaterThan(0)
  })

  it('renders a plan confirmation card and sends an explicit answer', () => {
    const answerPlan = vi.fn(async () => undefined)
    useSession.setState({ answerPlan })
    const plan: PlanBlock = {
      kind: 'plan', id: 'p1', ts: 0, toolCallId: 'call-plan',
      plan: {
        summary: '实现原生图片输入',
        steps: ['接通协议', '补齐界面'],
        files: ['fox_serve/host.py'],
        risks: ['控制消息大小'],
        verification: ['运行完整测试'],
      },
    }
    renderBlocks([plan])

    expect(screen.getByText('实现原生图片输入')).toBeTruthy()
    expect(screen.getByText('控制消息大小')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /开始实施/ }))
    expect(answerPlan).toHaveBeenCalledWith('call-plan', 'accept')
  })

  it('shows the actual edited-file summary after a completed run', () => {
    useFiles.setState({
      changes: {
        cwd: 'C:/work', repo: false, files: [], total: 0, truncated: false,
        sessionFiles: [{
          path: 'page.html', display: 'page.html', status: 'modified', additions: 5,
          deletions: 2, binary: false, staged: false, untracked: false,
        }],
      },
    })
    renderBlocks([{ kind: 'user', id: 'u1', ts: 0, text: '修改页面' }])

    expect(screen.getByText('已编辑 1 个文件')).toBeTruthy()
    expect(screen.getByText('page.html')).toBeTruthy()
    expect(screen.getAllByText('+5')).toHaveLength(2)
    expect(screen.getAllByText('−2')).toHaveLength(2)
  })

  it('collapses a legacy raw skill payload to the skill name', () => {
    renderBlocks([{
      kind: 'user', id: 'legacy-skill', ts: 0,
      text: '<skill name="api-request-planner" location="x">\nsecret body\n</skill>',
    }])
    expect(screen.getByText('使用技能 · api-request-planner')).toBeTruthy()
    expect(screen.queryByText(/secret body/)).toBeNull()
  })
})
