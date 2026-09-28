/**
 * The terminal's screen model: raw shell output → text a `<pre>` can draw.
 *
 * A shell on a pipe is *not* a terminal. It still emits carriage returns (every
 * progress bar), backspaces, tabs and — from tools that always colorize — ANSI
 * escape sequences. Dumping those bytes straight into the panel produces lines
 * that look like `\x1b[32mok\x1b[0m` and progress bars that pile up instead of
 * overwriting themselves.
 *
 * So output is folded into a tiny screen: finished `lines` plus the `partial`
 * line still being written, with a `cursor` column that gives `\r` and `\b`
 * their real meaning (write over what is there). Cursor *addressing* — moving up
 * or sideways between lines — is intentionally not modelled: the panel is a
 * scrollback, not a TUI, and that is also why the shell is started with
 * `TERM=dumb` (see `electron/terminal.js`).
 */
export interface TerminalScreen {
  lines: string[]
  partial: string
  cursor: number
}

export const EMPTY_SCREEN: TerminalScreen = { lines: [], partial: '', cursor: 0 }

/** Scrollback cap: ~4000 lines is plenty and keeps re-renders cheap. */
export const MAX_SCROLLBACK_LINES = 4000

const TAB_WIDTH = 4

export interface AppendOptions {
  maxLines?: number
}

/** Fold one chunk of shell output into the screen. Pure: returns a new screen. */
export function appendOutput(
  screen: TerminalScreen,
  chunk: string,
  options: AppendOptions = {},
): TerminalScreen {
  const maxLines = options.maxLines ?? MAX_SCROLLBACK_LINES
  const lines = screen.lines.slice()
  let partial = screen.partial
  let cursor = screen.cursor
  let dirty = false

  const write = (char: string) => {
    if (cursor < partial.length) partial = partial.slice(0, cursor) + char + partial.slice(cursor + 1)
    else partial = partial + ' '.repeat(cursor - partial.length) + char
    cursor += 1
  }

  for (let i = 0; i < chunk.length; i += 1) {
    const char = chunk[i]
    if (char === '\x1b') {
      i = skipEscape(chunk, i)
      dirty = true
      continue
    }
    switch (char) {
      case '\n':
        lines.push(partial)
        partial = ''
        cursor = 0
        break
      case '\r':
        cursor = 0
        break
      case '\b':
        cursor = Math.max(0, cursor - 1)
        break
      case '\t': {
        const width = TAB_WIDTH - (cursor % TAB_WIDTH)
        for (let n = 0; n < width; n += 1) write(' ')
        break
      }
      default: {
        const code = char.charCodeAt(0)
        // 其余 C0 控制字符（响铃、换页、垂直制表…）在滚动回看里没有意义，丢掉。
        if (code < 0x20 || code === 0x7f) {
          dirty = true
          break
        }
        write(char)
      }
    }
    dirty = true
  }

  if (!dirty) return screen
  const capped = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
  return { lines: capped, partial, cursor }
}

/**
 * Length of the escape sequence starting at `start` (which holds `\x1b`),
 * returned as the index of its last byte so the caller can `i = result`.
 */
function skipEscape(chunk: string, start: number): number {
  const next = chunk[start + 1]
  if (next === undefined) return start
  if (next === '[') {
    // CSI: parameters then a final byte in @-~.
    let i = start + 2
    while (i < chunk.length) {
      const code = chunk.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i
      i += 1
    }
    return chunk.length - 1
  }
  if (next === ']') {
    // OSC: terminated by BEL or ST (ESC \).
    let i = start + 2
    while (i < chunk.length) {
      if (chunk[i] === '\x07') return i
      if (chunk[i] === '\x1b' && chunk[i + 1] === '\\') return i + 1
      i += 1
    }
    return chunk.length - 1
  }
  // Two-byte escape (ESC ( B, ESC =, …).
  return start + 1
}

/** Flatten the screen for rendering. */
export function screenText(screen: TerminalScreen): string {
  if (!screen.lines.length) return screen.partial
  return `${screen.lines.join('\n')}\n${screen.partial}`
}

/** How many characters the panel is holding (used to trim on clear/restart). */
export function screenLength(screen: TerminalScreen): number {
  return screen.lines.reduce((total, line) => total + line.length + 1, screen.partial.length)
}
