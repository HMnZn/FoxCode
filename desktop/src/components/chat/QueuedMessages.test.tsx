import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueuedMessages } from './QueuedMessages'
import { EMPTY_TIMELINE } from '@/store/timeline'
import { useSession } from '@/store/sessionStore'

const bridge = useSession.getState().bridge

async function seed(...messages: string[]): Promise<void> {
  useSession.setState({
    timeline: { ...EMPTY_TIMELINE, status: 'streaming', activity: '模型生成中' },
  })
  for (const message of messages) await useSession.getState().followUp(message)
}

beforeEach(() => {
  useSession.setState({ timeline: { ...EMPTY_TIMELINE }, queue: [] })
  vi.restoreAllMocks()
})

describe('QueuedMessages', () => {
  it('renders nothing without a queue', () => {
    const { container } = render(<QueuedMessages />)
    expect(container.firstChild).toBeNull()
  })

  it('lists every queued message with a count', async () => {
    await seed('先改注释', '再跑一遍测试')
    render(<QueuedMessages />)

    expect(screen.getByText(/排队 2 条/)).toBeTruthy()
    expect(screen.getByText('先改注释')).toBeTruthy()
    expect(screen.getByText('再跑一遍测试')).toBeTruthy()
  })

  it('rewrites a queued message in place', async () => {
    await seed('先改注释')
    render(<QueuedMessages />)

    fireEvent.click(screen.getByText('先改注释'))
    const field = screen.getByLabelText('修改排队消息') as HTMLTextAreaElement
    expect(field.value).toBe('先改注释')

    fireEvent.change(field, { target: { value: '先改注释（补一句）' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(useSession.getState().queue[0].text).toBe('先改注释（补一句）')
    expect(screen.queryByLabelText('修改排队消息')).toBeNull()
  })

  it('interrupts the running turn when the lightning button is used', async () => {
    const send = vi.spyOn(bridge, 'send').mockResolvedValue(null)
    await seed('先做这个')
    render(<QueuedMessages />)

    fireEvent.click(screen.getAllByLabelText('立即插队')[0])

    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][0].method).toBe('steer')
    expect(useSession.getState().queue).toHaveLength(0)
  })

  it('drops a queued message', async () => {
    await seed('不要了')
    render(<QueuedMessages />)

    fireEvent.click(screen.getByLabelText('删除排队消息'))

    expect(useSession.getState().queue).toHaveLength(0)
    expect(screen.queryByText('不要了')).toBeNull()
  })
})
