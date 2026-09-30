export function formatTokens(n: number | undefined | null): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCost(usd: number | undefined | null): string {
  if (!usd) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  if (m < 60) return `${m}m ${rest}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = diff / 60_000
  if (min < 1) return '刚刚'
  if (min < 60) return `${Math.floor(min)} 分钟前`
  const hours = min / 60
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  const days = hours / 24
  if (days < 7) return `${Math.floor(days)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Shorten an absolute path for display, keeping the tail readable. */
export function shortPath(path: string, keep = 3): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= keep) return normalized
  return `…/${parts.slice(-keep).join('/')}`
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** Render legacy skill invocations without exposing the injected SKILL.md body. */
export function displayUserText(text: string): string {
  const match = /^\s*<skill\s+[^>]*name=(?:"([^"]+)"|'([^']+)')[^>]*>[\s\S]*?<\/skill>\s*([\s\S]*)$/i.exec(text)
  if (!match) return text
  const task = (match[3] ?? '').trim()
  return task || `使用技能 · ${match[1] ?? match[2]}`
}

export function pluralize(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many
}

/**
 * 分叉会话的标题：`标题-分支`，再分叉一次就是 `标题-分支2`。
 *
 * 与宿主 `fox_serve/sessions.py::branch_label` 同一套规则（演示宿主也要给出同样的
 * 结果，否则两种模式下列表看起来是两回事）。
 */
export function branchLabel(base: string, max = 120): string {
  const text = (base || '').trim().replace(/\s+/g, ' ') || '新会话'
  const match = /^(.*)-分支(\d*)$/.exec(text)
  if (match) {
    const root = match[1] || text
    const count = Number(match[2] || 1) + 1
    return `${root}-分支${count}`.slice(0, max)
  }
  return `${text}-分支`.slice(0, max)
}

/** Stable id generator — avoids crypto.randomUUID in non-secure contexts. */
let counter = 0
export function uid(prefix = 'id'): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Pretty-print JSON with a bounded size so huge payloads stay renderable. */
export function prettyJson(value: unknown, maxChars = 20_000): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text == null) return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… (已截断，共 ${text.length} 字符)`
}
