import { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, Pencil, Pin, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button, Chip, ConfirmDialog, Dialog, EmptyState, FieldLabel, Select, Switch, TextArea, TextInput } from '@/components/ui'
import { Markdown } from '@/components/content/Markdown'
import { shortPath } from '@/lib/format'
import { useSession } from '@/store/sessionStore'
import type { MemoryEntry, MemoryList, MemorySave } from '@/types/protocol'

const TYPES = [
  { value: 'user', label: '用户偏好' },
  { value: 'feedback', label: '反馈纠正' },
  { value: 'project', label: '项目决策' },
  { value: 'reference', label: '参考资料' },
] as const
const STATUS = { active: '有效', superseded: '已被替代', expired: '已过期' }
const blank = { name: '', description: '', type: 'project' as MemoryEntry['type'], content: '', pinned: false }

export function MemoryManager() {
  const host = useSession((state) => state.host)
  const enabled = host?.extensions.some((item) => item.enabled && item.services?.includes('memory.store'))
  return (
    <section className="surface-card flex flex-col gap-4 p-5" aria-label="记忆管理">
      <div className="flex items-center gap-2">
        <Brain size={16} className="text-accent" />
        <h2 className="text-sm font-medium text-fg">项目记忆</h2>
        <Chip size="xs" tone={host?.transport === 'mock' ? 'warn' : 'success'}>
          {host?.transport === 'mock' ? '演示数据' : '本地存储'}
        </Chip>
      </div>
      <p className="text-xs leading-relaxed text-fg-subtle">管理当前工作区的长期偏好、反馈与项目决策。置顶记忆会优先进入会话上下文。</p>
      {!enabled ? <p className="text-xs text-fg-muted">启用 memory 扩展后，即可查看和管理记忆。</p>
        : host?.projectTrusted === false ? <p className="text-xs text-warn">信任当前项目后，即可访问项目记忆。</p>
        : <MemoryRecords key={host?.cwd} />}
    </section>
  )
}

function MemoryRecords() {
  const send = useSession((state) => state.send)
  const [data, setData] = useState<MemoryList>({ entries: [], directory: '' })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<MemoryEntry | 'new' | null>(null)
  const [draft, setDraft] = useState(blank)
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null)
  const [viewing, setViewing] = useState<MemoryEntry | null>(null)
  const request = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current++ }
  }, [])

  const refresh = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    setError('')
    try {
      const result = await send({ method: 'memory.list', params: { query } }, { silent: true }) as MemoryList
      if (mounted.current && id === request.current) setData(result)
    } catch (cause) {
      if (mounted.current && id === request.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current && id === request.current) setLoading(false)
    }
  }, [send, query])

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 200)
    return () => { clearTimeout(timer); request.current++ }
  }, [refresh])

  const mutate = async (command: { method: 'memory.save'; params: MemorySave } | { method: 'memory.delete'; params: { filename: string } }) => {
    setPending(true)
    setError('')
    try {
      await send(command, { silent: true })
      if (!mounted.current) return
      setEditor(null)
      setDeleting(null)
      await refresh()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setPending(false)
    }
  }
  const edit = (entry: MemoryEntry | 'new') => {
    setError('')
    setDraft(entry === 'new' ? { ...blank } : { name: entry.name, description: entry.description, type: entry.type, content: entry.content, pinned: entry.pinned })
    setEditor(entry)
  }
  const entries = data.entries.filter((entry) => filter === 'all' || entry.type === filter)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
  const formValid = [draft.name, draft.description, draft.content].every((value) => value.trim())
  const errorBanner = error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-xs text-danger">{error}</p>

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[180px] flex-1"><TextInput aria-label="搜索记忆" placeholder="搜索名称、内容或标签…" value={query} onChange={(event) => setQuery(event.target.value)} iconLeft={<Search size={13} />} /></div>
        <Select className="w-[140px] shrink-0" aria-label="记忆类型筛选" value={filter} onChange={setFilter} options={[{ value: 'all', label: '所有类型' }, ...TYPES]} />
        <Button variant="ghost" size="sm" aria-label="刷新记忆" onClick={() => void refresh()} disabled={loading || pending}><RefreshCw size={13} /></Button>
        <Button size="sm" iconLeft={<Plus size={13} />} onClick={() => edit('new')} disabled={pending}>新增记忆</Button>
      </div>
      {!editor && !deleting && errorBanner}
      <div className="flex items-center justify-between text-2xs text-fg-subtle">
        <span>{loading ? '正在读取记忆…' : `${entries.length} 条记忆`}</span>
        <span className="max-w-[70%] truncate font-mono" title={data.directory}>{shortPath(data.directory, 3)}</span>
      </div>
      {!loading && !entries.length && !error && <EmptyState title={query ? '没有匹配的记忆' : '还没有项目记忆'} description="保存稳定的偏好或决策，让后续会话继续沿用。" />}
      <div className="flex max-h-[440px] flex-col gap-2 overflow-y-auto">
        {entries.map((entry) => {
          const expired = entry.expires_at && new Date(entry.expires_at).getTime() <= Date.now()
          const status = expired && entry.status === 'active' ? 'expired' : entry.status
          return (
            <div key={entry.filename} className="rounded-lg border border-line bg-surface-2 p-3" data-testid="memory-record">
              <div className="flex flex-wrap items-center gap-2">
                <button className="min-w-0 flex-1 truncate text-left text-xs font-medium text-fg hover:text-accent" onClick={() => setViewing(entry)}>{entry.name}</button>
                <Chip size="xs">{TYPES.find((type) => type.value === entry.type)?.label}</Chip>
                <Chip size="xs" tone={status === 'active' ? 'success' : 'neutral'}>{STATUS[status]}</Chip>
                <Button size="xs" variant={entry.pinned ? 'subtle' : 'ghost'} aria-label={`${entry.pinned ? '取消置顶' : '置顶'} ${entry.name}`} disabled={pending} onClick={() => void mutate({ method: 'memory.save', params: { filename: entry.filename, pinned: !entry.pinned } })}><Pin size={12} /></Button>
                <Button size="xs" variant="ghost" aria-label={`编辑 ${entry.name}`} disabled={pending} onClick={() => edit(entry)}><Pencil size={12} /></Button>
                <Button size="xs" variant="ghost" aria-label={`删除 ${entry.name}`} disabled={pending} onClick={() => { setError(''); setDeleting(entry) }}><Trash2 size={12} /></Button>
              </div>
              <p className="mt-1 text-2xs leading-relaxed text-fg-muted">{entry.description}</p>
              <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs leading-relaxed text-fg-subtle">{entry.content}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-2xs text-fg-subtle"><span>更新于 {new Date(entry.updated_at).toLocaleString('zh-CN')}</span>{entry.pinned && <span className="text-accent">已置顶</span>}</div>
            </div>
          )
        })}
      </div>
      <Dialog open={Boolean(viewing)} title={viewing?.name ?? '记忆详情'} size="lg" onClose={() => setViewing(null)} description={viewing?.description}>
        {viewing && <><div className="text-2xs text-fg-subtle">{viewing.filename} · {viewing.topic}</div><Markdown content={viewing.content} /></>}
      </Dialog>
      <Dialog open={Boolean(editor)} title={editor === 'new' ? '新增记忆' : '编辑记忆'} size="lg" onClose={() => { if (!pending) setEditor(null) }} footer={<><Button variant="ghost" disabled={pending} onClick={() => setEditor(null)}>取消</Button><Button loading={pending} disabled={!formValid} onClick={() => void mutate({ method: 'memory.save', params: editor === 'new' ? draft : { filename: (editor as MemoryEntry).filename, description: draft.description, content: draft.content, pinned: draft.pinned } })}>保存记忆</Button></>}>
        <form className="flex flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
          <div className="grid grid-cols-2 gap-3"><div><FieldLabel htmlFor="memory-name" required>名称</FieldLabel><TextInput id="memory-name" value={draft.name} maxLength={100} disabled={pending || editor !== 'new'} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div><div><FieldLabel>类型</FieldLabel><Select aria-label="记忆类型" value={draft.type} options={TYPES} disabled={pending || editor !== 'new'} onChange={(type) => setDraft({ ...draft, type })} /></div></div>
          <div><FieldLabel htmlFor="memory-description" required>描述</FieldLabel><TextInput id="memory-description" value={draft.description} maxLength={500} disabled={pending} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></div>
          <div><FieldLabel htmlFor="memory-content" required hint="支持 Markdown">内容</FieldLabel><TextArea id="memory-content" value={draft.content} maxLength={20000} minRows={6} disabled={pending} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></div>
          <Switch checked={draft.pinned} disabled={pending} onChange={(pinned) => setDraft({ ...draft, pinned })} label="置顶，优先用于后续会话" />
          {errorBanner}
        </form>
      </Dialog>
      <ConfirmDialog open={Boolean(deleting)} title="删除记忆" description={`删除「${deleting?.name ?? ''}」后无法恢复。`} confirmLabel={pending ? '删除中…' : '删除记忆'} tone="danger" cancelLabel="取消" onCancel={() => { if (!pending) setDeleting(null) }} onConfirm={() => { if (deleting && !pending) void mutate({ method: 'memory.delete', params: { filename: deleting.filename } }) }}>{errorBanner}</ConfirmDialog>
    </>
  )
}
