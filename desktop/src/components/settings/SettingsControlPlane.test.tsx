import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SettingsControlPlane } from './SettingsControlPlane'
import { getBridge } from '@/bridge'
import { useSession } from '@/store/sessionStore'

describe('SettingsControlPlane', () => {
  beforeEach(async () => {
    useSession.setState({ host: await getBridge().info() })
  })

  it('shows runtime, provider, MCP and subagent controls without exposing secrets', async () => {
    render(<SettingsControlPlane />)

    expect(await screen.findByText('模型供应商')).toBeTruthy()
    expect(screen.getByText('MCP 服务器')).toBeTruthy()
    expect(screen.getByText('Subagents')).toBeTruthy()
    expect(screen.getByText('密钥已配置')).toBeTruthy()
    expect(document.body.textContent).not.toContain('super-secret')
  })

  it('opens validated editors for each configurable surface', async () => {
    render(<SettingsControlPlane />)
    await screen.findByText('模型供应商')

    fireEvent.click(screen.getByRole('button', { name: '添加供应商' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('API Key').getAttribute('type')).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '添加 MCP' }))
    expect(screen.getByLabelText('MCP 命令')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '创建 Subagent' }))
    expect(screen.getByLabelText('Subagent 提示词')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('requires confirmation before destructive configuration changes', async () => {
    render(<SettingsControlPlane />)
    await screen.findByText('模型供应商')

    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('删除配置？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('deepseek')).toBeTruthy()
  })
})
