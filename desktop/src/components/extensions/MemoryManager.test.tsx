import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { getBridge } from '@/bridge'
import { MockHost } from '@/bridge/mock/mockHost'
import { MemoryManager } from './MemoryManager'
import { useSession } from '@/store/sessionStore'

const bridge = getBridge() as MockHost
beforeEach(async () => {
  bridge.resetExtensions()
  await bridge.send({ method: 'trust.set', params: { trusted: true } })
  await bridge.send({ method: 'cwd.change', params: { cwd: `memory-test-${Math.random()}` } })
  useSession.setState({ host: await bridge.info() })
})
async function create() {
  await bridge.send({ method: 'memory.save', params: { name: '项目测试约定', description: '验证修改后运行测试', type: 'project', content: '修改前端后运行 npm test。' } })
}

describe('MemoryManager', () => {
  it('creates, edits, pins, searches, and deletes through host commands', async () => {
    render(<MemoryManager />)
    await screen.findByText('还没有项目记忆')
    fireEvent.click(screen.getByText('新增记忆'))
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: '项目测试约定' } })
    fireEvent.change(screen.getByLabelText(/^描述/), { target: { value: '验证修改后运行测试' } })
    fireEvent.change(screen.getByLabelText(/^内容/), { target: { value: '修改前端后运行 npm test。' } })
    fireEvent.click(screen.getByText('保存记忆'))
    await screen.findByText('项目测试约定')
    fireEvent.click(screen.getByLabelText('置顶 项目测试约定'))
    await screen.findByLabelText('取消置顶 项目测试约定')
    await waitFor(() => expect((screen.getByLabelText('编辑 项目测试约定') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByLabelText('编辑 项目测试约定'))
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^内容/), { target: { value: '修改前端后运行 npm run build。' } })
    fireEvent.click(screen.getByText('保存记忆'))
    await screen.findByText('修改前端后运行 npm run build。')
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'not-found' } })
    await screen.findByText('没有匹配的记忆')
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: '' } })
    await screen.findByLabelText('删除 项目测试约定')
    fireEvent.click(screen.getByLabelText('删除 项目测试约定'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除记忆' }))
    await screen.findByText('还没有项目记忆')
    expect((await bridge.send({ method: 'memory.list' }) as { entries: unknown[] }).entries).toEqual([])
  })

  it('shows full Markdown and cancels deletion without a host write', async () => {
    await create()
    render(<MemoryManager />)
    fireEvent.click(await screen.findByText('项目测试约定'))
    expect(within(screen.getByRole('dialog')).getByText('修改前端后运行 npm test。')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('关闭对话框'))
    fireEvent.click(screen.getByLabelText('删除 项目测试约定'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect((await bridge.send({ method: 'memory.list' }) as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('requires an enabled extension and project trust', async () => {
    const host = await bridge.info()
    useSession.setState({ host: { ...host, extensions: [] } })
    const result = render(<MemoryManager />)
    expect(screen.getByText(/启用 memory/)).toBeTruthy()
    useSession.setState({ host: { ...host, projectTrusted: false } })
    result.rerender(<MemoryManager />)
    expect(screen.getByText(/信任当前项目后/)).toBeTruthy()
    expect(screen.queryByText('新增记忆')).toBeNull()
  })

  it('surfaces host errors and keeps an unsuccessful edit open', async () => {
    await create()
    render(<MemoryManager />)
    fireEvent.click(await screen.findByLabelText('编辑 项目测试约定'))
    await bridge.send({ method: 'trust.set', params: { trusted: false } })
    fireEvent.click(screen.getByText('保存记忆'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('信任'))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
