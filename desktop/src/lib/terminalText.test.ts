import { describe, expect, it } from 'vitest'

import { EMPTY_SCREEN, appendOutput, screenLength, screenText } from './terminalText'

describe('appendOutput', () => {
  it('collects finished lines and keeps the partial one', () => {
    const screen = appendOutput(EMPTY_SCREEN, 'hello\nworld\n')
    expect(screen.lines).toEqual(['hello', 'world'])
    expect(screenText(screen)).toBe('hello\nworld\n')
  })

  it('does not finish a line until the newline arrives', () => {
    const screen = appendOutput(EMPTY_SCREEN, 'half a line')
    expect(screen.lines).toEqual([])
    expect(screenText(screen)).toBe('half a line')
  })

  it('lets a carriage return overwrite the line instead of piling up', () => {
    const screen = appendOutput(EMPTY_SCREEN, '10%\r 50%\r100%\n')
    expect(screen.lines).toEqual(['100%'])
  })

  it('gives backspace its meaning', () => {
    expect(screenText(appendOutput(EMPTY_SCREEN, 'abc\b\bX'))).toBe('aXc')
  })

  it('expands tabs to the next four-column stop', () => {
    expect(screenText(appendOutput(EMPTY_SCREEN, 'a\tb'))).toBe('a   b')
    expect(screenText(appendOutput(EMPTY_SCREEN, 'abcd\te'))).toBe('abcd    e')
  })

  it('drops colour escapes rather than printing them', () => {
    const screen = appendOutput(EMPTY_SCREEN, '\x1b[32mok\x1b[0m\n')
    expect(screen.lines).toEqual(['ok'])
  })

  it('drops window-title escapes (OSC) and their BEL', () => {
    expect(screenText(appendOutput(EMPTY_SCREEN, '\x1b]0;a title\x07done'))).toBe('done')
  })

  it('drops the remaining control characters', () => {
    expect(screenText(appendOutput(EMPTY_SCREEN, 'a\x07\x0cb'))).toBe('ab')
  })

  it('trims the scrollback to the cap', () => {
    const screen = appendOutput(EMPTY_SCREEN, 'a\nb\nc\n', { maxLines: 2 })
    expect(screen.lines).toEqual(['b', 'c'])
  })

  it('returns the same screen when there is nothing to fold', () => {
    const screen = appendOutput(EMPTY_SCREEN, 'line\n')
    expect(appendOutput(screen, '')).toBe(screen)
  })

  it('counts what the panel is holding', () => {
    expect(screenLength({ lines: ['ab', 'c'], partial: 'de', cursor: 2 })).toBe(7)
  })
})
