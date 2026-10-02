import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SessionStatusBar } from '@/components/chat/SessionStatusBar'
import { useSession } from '@/store/sessionStore'
import { EMPTY_TIMELINE } from '@/store/timeline'

describe('SessionStatusBar', () => {
  beforeEach(() => {
    useSession.getState().clearTimeline()
  })

  it('keeps a single line and marks optional metrics for narrow containers', () => {
    render(<SessionStatusBar />)

    const status = screen.getByRole('contentinfo', { name: '会话状态' })
    expect(status.className).toContain('flex-nowrap')
    expect(status.className).toContain('whitespace-nowrap')
    expect(status.className).toContain('overflow-hidden')
    expect(status.querySelector('.session-status-io')).toBeTruthy()
    expect(status.querySelector('.session-status-cache')).toBeTruthy()
    expect(status.querySelector('.session-status-cost')).toBeTruthy()
    expect(status.querySelector('.session-status-context-short')).toBeTruthy()
  })

  it('shows cache reads and hit rate for the current parent turn', () => {
    useSession.setState({
      timeline: {
        ...EMPTY_TIMELINE,
        context: {
          ...EMPTY_TIMELINE.context,
          input: 3_000,
          cacheRead: 1_000,
          used: 4_000,
        },
      },
    })

    render(<SessionStatusBar />)
    expect(screen.getByText('缓存命中 1.00K (25%)')).toBeTruthy()
  })
})
