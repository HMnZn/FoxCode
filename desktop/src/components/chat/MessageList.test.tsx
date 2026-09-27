import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { ToolCallState, ToolsBlock } from '@/store/timeline'

function call(name: string, id: string, status: ToolCallState['status'] = 'success'): ToolCallState {
  return { id, name, args: { path: 'packages/fox_agent_core/README.md' }, status, startedAt: 0, updates: [] }
}

function toolsBlock(calls: ToolCallState[]): ToolsBlock {
  return { kind: 'tools', id: 't1', ts: 0, calls }
}

function renderBlocks(blocks: ToolsBlock[]) {
  return render(<MessageList blocks={blocks} status="idle" />)
}

describe('MessageList tool group', () => {
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

  it('opens itself while a call waits for approval, and flags failures', () => {
    renderBlocks([toolsBlock([call('bash', 'c1', 'awaiting-approval')])])

    // The row that explains what is asking for permission must not stay folded.
    expect(screen.getByText('收起')).toBeTruthy()
    expect(screen.getByText('1 运行中')).toBeTruthy()

    renderBlocks([toolsBlock([call('edit', 'c2', 'error')])])
    expect(screen.getAllByText('1 失败').length).toBeGreaterThan(0)
  })
})
