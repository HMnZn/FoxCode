import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChatPage } from '@/pages/ChatPage'
import { useSession } from '@/store/sessionStore'
import {
  EMPTY_TIMELINE,
  type AssistantBlock,
  type ToolsBlock,
  type UserBlock,
} from '@/store/timeline'
import { useUi } from '@/store/uiStore'

const user: UserBlock = { kind: 'user', id: 'u1', ts: 1, text: '看看工具' }
const tools: ToolsBlock = {
  kind: 'tools',
  id: 't1',
  ts: 2,
  calls: [
    {
      id: 'c1',
      name: 'read',
      args: { path: 'zz-unique-arg.py' },
      status: 'success',
      startedAt: 1,
      endedAt: 900,
      updates: [],
      result: 'ok',
    },
  ],
}
const assistant: AssistantBlock = {
  kind: 'assistant',
  id: 'a1',
  ts: 3,
  text: '读完了',
  thinking: '内部推理',
  thinkingStreaming: false,
  textStreaming: false,
  startedAt: 1,
}

describe('ChatPage 会话 / 轨迹', () => {
  beforeEach(() => {
    useUi.setState({ chatView: 'chat' })
    useSession.setState({
      host: null,
      timeline: { ...EMPTY_TIMELINE, blocks: [user, tools, assistant] },
    })
  })

  it('folds tool calls into one row in 会话 and lists them in 轨迹', () => {
    render(<ChatPage />)

    expect(screen.getByText('读完了')).toBeTruthy()
    // 会话里工具是折叠的一行：工具名可见，参数不可见。
    expect(screen.getByText('1 项工具调用')).toBeTruthy()
    expect(screen.getByText('read')).toBeTruthy()
    expect(screen.queryByText(/zz-unique-arg/)).toBeNull()

    // 展开后才铺开参数与输出。
    fireEvent.click(screen.getByText('1 项工具调用').closest('button') as HTMLButtonElement)
    expect(screen.getByText(/zz-unique-arg/)).toBeTruthy()

    const switcher = screen.getByRole('group', { name: '会话与轨迹切换' })
    fireEvent.click(within(switcher).getByRole('button', { name: '轨迹' }))

    // 轨迹里同一批工具调用按时间再列一遍。
    expect(screen.getAllByText(/zz-unique-arg/).length).toBeGreaterThan(0)
    expect(screen.getByText('执行轨迹')).toBeTruthy()
  })
})
