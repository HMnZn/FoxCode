import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ExtensionsPage } from '@/pages/ExtensionsPage'
import { getBridge } from '@/bridge'
import { MockHost } from '@/bridge/mock/mockHost'
import { useSession } from '@/store/sessionStore'
import type { HostInfo } from '@/types/protocol'

/**
 * The extensions page is driven by `host.info` and by the `extensions.set`
 * command, so these tests run against the real demo host: enabling an extension
 * must move it between `availableExtensions` and `extensions` for real.
 */
async function mountWithHost(patch: Partial<HostInfo> = {}) {
  const info = { ...(await getBridge().info()), ...patch }
  useSession.setState({ host: info })
  render(<ExtensionsPage />)
  return info
}

/** Every extension renders as one <article>; find it by its monospace title. */
function cardFor(name: string): HTMLElement {
  const title = screen.getByTitle(name)
  const card = title.closest('article')
  if (!card) throw new Error(`extension card not found: ${name}`)
  return card
}

function switchIn(name: string): HTMLButtonElement {
  return within(cardFor(name)).getByRole('switch') as HTMLButtonElement
}

describe('ExtensionsPage', () => {
  beforeEach(() => {
    // The demo host is a singleton the store captured at module load, so reset
    // its extension lists in place instead of rebuilding the bridge.
    ;(getBridge() as MockHost).resetExtensions()
    useSession.setState({ host: null })
  })

  it('separates enabled extensions from the ones the host merely discovered', async () => {
    await mountWithHost()

    expect(switchIn('memory').getAttribute('aria-checked')).toBe('true')
    expect(switchIn('subagent').getAttribute('aria-checked')).toBe('true')
    // Discovered but not configured.
    expect(switchIn('mcp').getAttribute('aria-checked')).toBe('false')
    expect(switchIn('guard_shell').getAttribute('aria-checked')).toBe('false')

    // Contributions and the authoritative scope are surfaced, not just names.
    const memory = cardFor('memory')
    expect(within(memory).getByText('memory_recall')).toBeTruthy()
    expect(within(memory).getByText('memory.store')).toBeTruthy()
    expect(within(memory).getByText('上下文变换')).toBeTruthy()
    expect(screen.getByText('生效作用域')).toBeTruthy()
    expect(screen.getByText('项目级 .foxcode/settings.json')).toBeTruthy()

    // A file extension is never pre-executed, and the page says so.
    expect(within(cardFor('guard_shell')).getByText(/不会被宿主预先执行/)).toBeTruthy()
  })

  it('enables a discovered extension by reloading through the host', async () => {
    await mountWithHost()

    fireEvent.click(switchIn('mcp'))

    await waitFor(() => {
      expect(useSession.getState().host?.extensions.map((item) => item.name)).toContain('mcp')
    })

    expect(switchIn('mcp').getAttribute('aria-checked')).toBe('true')

    // The command really moved the spec out of the discoverable list.
    const info = await getBridge().info()
    const available = info.availableExtensions ?? []
    expect(info.extensions.map((item) => item.name)).toContain('mcp')
    expect(available.map((item) => item.name)).not.toContain('mcp')
    expect(available.map((item) => item.name)).toContain('guard_shell')
  })

  it('disables a discovered extension while the project is untrusted', async () => {
    await mountWithHost({ projectTrusted: false })

    expect(screen.getByText(/当前项目未受信任/)).toBeTruthy()
    const mcp = switchIn('mcp')
    expect(mcp.disabled).toBe(true)

    fireEvent.click(mcp)
    await Promise.resolve()
    const info = await getBridge().info()
    expect((info.availableExtensions ?? []).map((item) => item.name)).toContain('mcp')
  })
})
