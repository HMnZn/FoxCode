/**
 * composer 里的命令目录。
 *
 * 这一组盯两件事：
 * 1. `/` 目录**刻意只有两项** —— 把工作区文件加进这条消息、压缩上下文。其余命令
 *    （权限、模型、导出、技能…）在 Ctrl+K 面板与各自的页面里都有，堆在输入框上只会挡路；
 *    但手敲真名（`/compact`、`/permission`…）仍然要照旧执行。
 * 2. 「把文件加进这条消息」要真的能选出文件并把 `@路径` 接进草稿。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@/components/chat/Composer'
import { useSession } from '@/store/sessionStore'
import { EMPTY_TIMELINE } from '@/store/timeline'
import { useUi } from '@/store/uiStore'
import { useWorkspace } from '@/store/workspaceStore'
import type { PromptImage } from '@/types/protocol'

const bridge = useSession.getState().bridge

describe('Composer · 命令目录', () => {
  beforeEach(async () => {
    useSession.setState({ host: await bridge.info(), timeline: { ...EMPTY_TIMELINE }, queue: [] })
    useUi.setState({ selectedSkills: {} })
    useWorkspace.setState({ current: null, applying: null })
  })

  it('offers exactly the two commands worth having in the composer', () => {
    const hostCommands = useSession.getState().host?.commands ?? []
    expect(hostCommands.length).toBeGreaterThan(8) // 宿主那边命令很多，但不在 `/` 目录里铺开
    useUi.setState({ drafts: { main: '/' } })
    render(<Composer draftKey="main" />)

    expect(screen.getByText('/文件')).toBeTruthy()
    expect(screen.getByText('/压缩')).toBeTruthy()
    expect(screen.getByText('2 条')).toBeTruthy()
    for (const gone of ['/permission', '/model', '/export', '/thinking']) {
      expect(screen.queryByText(gone)).toBeNull()
    }

    // 列表本身仍然能滚：固定最大高度 + overflow-y-auto。
    const list = screen.getByText('/文件').closest('[class*="overflow-y-auto"]')
    expect(list?.className).toContain('max-h-[min(46vh,320px)]')
  })

  it('runs 压缩 as the host compact command', async () => {
    const send = vi.spyOn(bridge, 'send')
    useUi.setState({ drafts: { main: '/压缩' } })
    render(<Composer draftKey="main" />)

    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    // 第一次回车是「补全」（列表开着时回车不发送），第二次回车才真的执行。
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('/压缩 ')

    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        method: 'run_command',
        params: { name: 'compact', arguments: '' },
      }),
    )
    expect(box.value).toBe('')
  })

  it('still runs a host command typed by its real name', async () => {
    const send = vi.spyOn(bridge, 'send')
    // `/new` 不再出现在目录里，但手敲仍然要能用（目录只是不再宣传它们）。
    useUi.setState({ drafts: { main: '/new' } })
    render(<Composer draftKey="main" />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        method: 'run_command',
        params: { name: 'new', arguments: '' },
      }),
    )
  })

  it('picks a workspace file and puts its @path into the draft', async () => {
    useUi.setState({ drafts: { main: '/' } })
    render(<Composer draftKey="main" />)

    fireEvent.click(screen.getByText('/文件'))

    const list = await screen.findByLabelText('工作区文件')
    const file = await within(list).findByText('preview.png')
    fireEvent.click(file)

    // 选中的文件变成一个 `@路径` 引用：模型能拿它去 read，用户还能接着往下写。
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('@preview.png '),
    )
  })

  it('accepts a path typed next to /文件 without opening the picker', async () => {
    const send = vi.spyOn(bridge, 'send')
    useUi.setState({ drafts: { main: '/文件 desktop/package.json' } })
    render(<Composer draftKey="main" />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        '@desktop/package.json ',
      ),
    )
    expect(send.mock.calls.some(([command]) => command.method === 'files.list')).toBe(false)
  })

  it('sends selected images as native prompt attachments', async () => {
    const prompt = vi.fn(async (_text: string, _attachments?: PromptImage[]) => undefined)
    useSession.setState({ prompt })
    useUi.setState({ drafts: { main: '分析这张截图' } })
    const { container } = render(<Composer draftKey="main" />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [file] } })
    await screen.findByAltText('screen.png')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    const [text, attachments] = prompt.mock.calls[0]
    expect(text).toBe('分析这张截图')
    expect(attachments?.[0]).toMatchObject({ name: 'screen.png', mimeType: 'image/png', size: 3 })
    expect(attachments?.[0].data).toBeTruthy()
  })

  it('keeps the toolbar compact and leaves workspace switching to global navigation', () => {
    useUi.setState({ drafts: { main: '' } })
    const { container } = render(<Composer draftKey="main" />)

    expect(screen.queryByRole('button', { name: '工作区' })).toBeNull()
    expect(screen.queryByText('demo_project')).toBeNull()
    const toolbar = container.querySelector('.flex-nowrap')
    expect(toolbar).toBeTruthy()
    expect(toolbar?.className).not.toContain('flex-wrap')
  })

  it('keeps a draft while the host is still switching to the remembered workspace', () => {
    const prompt = vi.fn(async () => undefined)
    useSession.setState({ prompt })
    useWorkspace.setState({ current: '/next/project', applying: '/next/project' })
    useUi.setState({ drafts: { main: '不要丢掉这条任务' } })
    render(<Composer draftKey="main" />)

    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(box.value).toBe('不要丢掉这条任务')
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(prompt).not.toHaveBeenCalled()
    expect(box.value).toBe('不要丢掉这条任务')
  })

  it('lets the user select sandbox execution from the compact settings menu', async () => {
    const setExecutionMode = vi.fn(async () => undefined)
    useSession.setState({ setExecutionMode })
    useUi.setState({ drafts: { main: '' } })
    render(<Composer draftKey="main" />)

    fireEvent.click(screen.getByRole('button', { name: '对话设置' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /沙盒执行/ }))

    expect(setExecutionMode).toHaveBeenCalledWith('sandbox')
  })

  it('selects a skill by name and waits for the actual task before invoking it', async () => {
    const invokeSkill = vi.fn(async () => undefined)
    useSession.setState({ invokeSkill })
    useUi.setState({ drafts: { main: '' }, selectedSkills: {} })
    render(<Composer draftKey="main" />)

    fireEvent.click(screen.getByRole('button', { name: '调用技能' }))
    const skill = useSession.getState().host?.skills[0]
    expect(skill).toBeTruthy()
    fireEvent.click(await screen.findByRole('menuitem', { name: skill!.name }))

    expect(invokeSkill).not.toHaveBeenCalled()
    expect(screen.getByText(skill!.name)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '检查这个 API 流程' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(invokeSkill).toHaveBeenCalledWith(skill!.name, '检查这个 API 流程'))
    expect(screen.queryByText(skill!.name)).toBeNull()
  })
})
