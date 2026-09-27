import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ThinkingPart } from '@/components/content/ContentParts'

describe('ThinkingPart', () => {
  it('stays collapsed while reasoning streams', () => {
    render(<ThinkingPart text="先看锁，再看调度" streaming />)

    const toggle = screen.getByRole('button', { name: /思考过程/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // 折叠态只给一行预览与状态，不给正文。
    expect(screen.getByText('思考中…')).toBeTruthy()
    expect(screen.getByText('先看锁，再看调度')).toBeTruthy()
  })

  it('expands on click and keeps the user choice', () => {
    const { rerender } = render(<ThinkingPart text="先看锁" streaming />)

    fireEvent.click(screen.getByRole('button', { name: /思考过程/ }))
    expect(screen.getByRole('button', { name: /思考过程/ }).getAttribute('aria-expanded')).toBe(
      'true',
    )

    // 流式结束后不再自动抢控制权（用户手动展开过）。
    rerender(<ThinkingPart text="先看锁" streaming={false} />)
    expect(screen.getByRole('button', { name: /思考过程/ }).getAttribute('aria-expanded')).toBe(
      'true',
    )
  })
})
