import { useEffect, useState, type ReactNode } from 'react'
import { Bot, KeyRound, Plus, ServerCog, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button, Chip, ConfirmDialog, Dialog, FieldLabel, Select, Switch, TextArea, TextInput, toast } from '@/components/ui'
import { useSession } from '@/store/sessionStore'
import type {
  ConfigScope,
  HostCommand,
  McpServerSettings,
  ProductConfiguration,
  ProviderConfig,
  SubagentSettings,
} from '@/types/protocol'

type Editor = 'provider' | 'mcp' | 'subagent' | null
type Mutate = (command: HostCommand) => Promise<void>
type PendingDelete = { kind: 'provider' | 'credential' | 'mcp' | 'subagent'; id: string; scope?: ConfigScope } | null

const SCOPE_OPTIONS = [
  { value: 'user', label: '用户级', hint: '所有工作区可用' },
  { value: 'project', label: '项目级', hint: '只对当前可信项目生效' },
]

export function SettingsControlPlane({ surface = 'all' }: { surface?: 'settings' | 'extensions' | 'all' }) {
  const bridge = useSession((state) => state.bridge)
  const refreshHost = useSession((state) => state.refreshHost)
  const [config, setConfig] = useState<ProductConfiguration | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<Editor>(null)
  const [editing, setEditing] = useState<ProviderConfig | McpServerSettings | SubagentSettings | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)

  const load = async () => {
    setLoading(true)
    try {
      setConfig((await bridge.send({ method: 'config.get' })) as ProductConfiguration)
    } catch (error) {
      toast.danger({ title: '读取产品配置失败', description: message(error) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [bridge])

  const mutate = async (command: Parameters<typeof bridge.send>[0]) => {
    setSaving(true)
    try {
      const next = (await bridge.send(command)) as ProductConfiguration
      setConfig(next)
      setEditor(null)
      setEditing(null)
      await refreshHost()
      toast.success({ title: '配置已保存并重新加载' })
    } catch (error) {
      toast.danger({ title: '保存配置失败', description: message(error), duration: 0 })
      throw error
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    const item = pendingDelete
    setPendingDelete(null)
    if (item.kind === 'provider') void mutate({ method: 'config.provider.delete', params: { id: item.id } })
    if (item.kind === 'credential') void mutate({ method: 'config.credential.delete', params: { providerId: item.id } })
    if (item.kind === 'mcp') void mutate({ method: 'config.mcp.delete', params: { name: item.id, scope: item.scope } })
    if (item.kind === 'subagent') void mutate({ method: 'config.subagent.delete', params: { name: item.id, scope: item.scope } })
  }

  if (loading && !config) {
    return <div className="surface-card p-4 text-xs text-fg-subtle">正在读取产品配置…</div>
  }
  if (!config) {
    return <div className="surface-card p-4 text-xs text-danger">产品配置不可用，请确认 fox serve 已启动。</div>
  }

  return (
    <>
      {surface !== 'extensions' ? <>
        <SettingsSection id="runtime-defaults" title="运行默认值" hint="持久化到 settings.json；新会话与重新加载后生效" icon={<SlidersHorizontal size={14} />}>
          <RuntimeDefaults config={config} saving={saving} onSave={mutate} />
        </SettingsSection>

        <SettingsSection id="providers" title="模型供应商" hint="模型目录与凭据分离保存，密钥不会回显" icon={<KeyRound size={14} />}>
        <SectionToolbar text={`${config.providers.length} 个供应商`} onAdd={() => { setEditing(null); setEditor('provider') }} addLabel="添加供应商" />
        {config.providers.length === 0 ? <Empty text="还没有模型供应商。添加后即可在会话中选择模型。" /> : (
          <div className="grid gap-2">
            {config.providers.map((provider) => (
              <div key={provider.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-fg">
                    <span className="font-medium">{provider.id}</span>
                    <Chip size="xs" tone={provider.credentialConfigured ? 'success' : 'warn'}>
                      {provider.credentialConfigured ? '密钥已配置' : '缺少密钥'}
                    </Chip>
                  </div>
                  <div className="mt-1 truncate font-mono text-2xs text-fg-subtle">{provider.api} · {provider.baseUrl}</div>
                  <div className="mt-1 text-2xs text-fg-muted">{provider.models.length} 个模型：{provider.models.map((item) => String(item.name ?? item.id ?? '')).join('、')}</div>
                </div>
                <Button size="xs" variant="outline" onClick={() => { setEditing(provider); setEditor('provider') }}>编辑</Button>
                {provider.credentialConfigured ? <Button size="xs" variant="ghost" onClick={() => setPendingDelete({ kind: 'credential', id: provider.id })}>清除密钥</Button> : null}
                <Button size="xs" variant="danger" iconLeft={<Trash2 size={12} />} onClick={() => setPendingDelete({ kind: 'provider', id: provider.id })}>删除</Button>
              </div>
            ))}
          </div>
        )}
        </SettingsSection>
      </> : null}

      {surface !== 'settings' ? <>
        <SettingsSection id="mcp" title="MCP 服务器" hint="受控启动外部工具服务器；保存后自动启用 MCP 扩展" icon={<ServerCog size={14} />}>
        <SectionToolbar text={`${config.mcpServers.length} 个服务器`} onAdd={() => { setEditing(null); setEditor('mcp') }} addLabel="添加 MCP" />
        {config.mcpServers.length === 0 ? <Empty text="尚未配置 MCP。建议先以只读权限接入。" /> : config.mcpServers.map((server) => (
          <div key={`${server.scope}:${server.name}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-fg"><span className="font-medium">{server.name}</span><Chip size="xs">{server.scope === 'user' ? '用户' : '项目'}</Chip><Chip size="xs" tone={server.permission === 'read-only' ? 'success' : 'warn'}>{server.permission}</Chip></div>
              <div className="mt-1 truncate font-mono text-2xs text-fg-subtle">{server.command} {server.args.join(' ')}</div>
              {server.envKeys?.length ? <div className="mt-1 text-2xs text-fg-muted">环境变量：{server.envKeys.join('、')}（值已隐藏）</div> : null}
            </div>
            <Button size="xs" variant="outline" onClick={() => { setEditing(server); setEditor('mcp') }}>编辑</Button>
            <Button size="xs" variant="danger" iconLeft={<Trash2 size={12} />} onClick={() => setPendingDelete({ kind: 'mcp', id: server.name, scope: server.scope })}>删除</Button>
          </div>
        ))}
        </SettingsSection>

        <SettingsSection id="subagents" title="Subagents" hint="为委派任务定义隔离角色、提示词和最小工具集" icon={<Bot size={14} />}>
        <SectionToolbar text={`${config.subagents.length} 个角色`} onAdd={() => { setEditing(null); setEditor('subagent') }} addLabel="创建 Subagent" />
        <div className="grid gap-2 md:grid-cols-2">
          {config.subagents.map((agent) => (
            <div key={`${agent.scope}:${agent.name}`} className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex items-center gap-2"><span className="text-xs font-medium text-fg">{agent.name}</span><Chip size="xs">{agent.scope === 'builtin' ? '内置' : agent.scope === 'user' ? '用户' : '项目'}</Chip></div>
              <p className="min-h-8 text-2xs leading-relaxed text-fg-muted">{agent.description}</p>
              <div className="truncate font-mono text-2xs text-fg-subtle">{agent.allowedTools?.join(', ') || '继承父 Agent 工具'}</div>
              {agent.editable ? <div className="mt-auto flex justify-end gap-2"><Button size="xs" variant="outline" onClick={() => { setEditing(agent); setEditor('subagent') }}>编辑</Button><Button size="xs" variant="danger" onClick={() => setPendingDelete({ kind: 'subagent', id: agent.name, scope: agent.scope as ConfigScope })}>删除</Button></div> : null}
            </div>
          ))}
        </div>
        </SettingsSection>

        {config.diagnostics.length > 0 ? (
          <SettingsSection id="diagnostics" title="配置诊断" hint="无效条目不会进入运行时">
            {config.diagnostics.map((item, index) => <div key={`${item.path}:${index}`} className="rounded-md border border-warn/40 bg-warn-soft p-3 text-2xs text-warn"><span className="font-medium">{item.area} · {item.code}</span><div className="mt-1">{item.message}</div><div className="mt-1 font-mono opacity-80">{item.path}</div></div>)}
          </SettingsSection>
        ) : null}
      </> : null}

      <ProviderDialog open={editor === 'provider'} value={editing as ProviderConfig | null} saving={saving} onClose={() => setEditor(null)} onSave={mutate} />
      <McpDialog open={editor === 'mcp'} value={editing as McpServerSettings | null} trusted={config.projectTrusted} saving={saving} onClose={() => setEditor(null)} onSave={mutate} />
      <SubagentDialog open={editor === 'subagent'} value={editing as SubagentSettings | null} trusted={config.projectTrusted} saving={saving} onClose={() => setEditor(null)} onSave={mutate} />
      <ConfirmDialog
        open={pendingDelete != null}
        title={pendingDelete?.kind === 'credential' ? '清除 API Key？' : '删除配置？'}
        description={pendingDelete ? `${pendingDelete.id} 将从对应配置文件中移除；这不会删除会话。` : undefined}
        confirmLabel={pendingDelete?.kind === 'credential' ? '清除密钥' : '确认删除'}
        cancelLabel="取消"
        tone="danger"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

function RuntimeDefaults({ config, saving, onSave }: { config: ProductConfiguration; saving: boolean; onSave: Mutate }) {
  const runtime = config.runtime
  const [scope, setScope] = useState<ConfigScope>('user')
  const [turns, setTurns] = useState(String(runtime.max_turns))
  const [retries, setRetries] = useState(String(runtime.model_retry_attempts))
  const [maxTokens, setMaxTokens] = useState(String(runtime.stream_options.max_tokens ?? ''))
  useEffect(() => {
    setTurns(String(runtime.max_turns))
    setRetries(String(runtime.model_retry_attempts))
    setMaxTokens(String(runtime.stream_options.max_tokens ?? ''))
  }, [runtime.max_turns, runtime.model_retry_attempts, runtime.stream_options.max_tokens])
  const save = () => {
    const parsedTurns = Number(turns)
    const parsedRetries = Number(retries)
    const parsedMaxTokens = maxTokens.trim() ? Number(maxTokens) : null
    if (!Number.isInteger(parsedTurns) || parsedTurns < 1 || !Number.isInteger(parsedRetries) || parsedRetries < 0 || parsedRetries > 5 || (parsedMaxTokens != null && (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1))) {
      toast.danger({ title: '运行默认值无效', description: '轮次、重试与输出上限必须是有效整数。' })
      return
    }
    const values: Record<string, unknown> = { max_turns: parsedTurns, model_retry_attempts: parsedRetries }
    if (parsedMaxTokens != null) values.stream_options = { ...runtime.stream_options, max_tokens: parsedMaxTokens }
    void onSave({ method: 'config.runtime.update', params: { values, scope } })
  }
  return <div className="grid gap-3 md:grid-cols-4">
    <Labeled label="保存范围"><Select value={scope} options={SCOPE_OPTIONS.filter((item) => config.projectTrusted || item.value === 'user')} onChange={(value) => setScope(value as ConfigScope)} size="sm" /></Labeled>
    <Labeled label="最大轮次"><TextInput aria-label="最大轮次" type="number" min={1} value={turns} onChange={(event) => setTurns(event.target.value)} /></Labeled>
    <Labeled label="模型重试"><TextInput aria-label="模型重试" type="number" min={0} max={5} value={retries} onChange={(event) => setRetries(event.target.value)} /></Labeled>
    <Labeled label="最大输出 tokens"><TextInput aria-label="最大输出 tokens" type="number" min={1} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></Labeled>
    <div className="md:col-span-4 flex justify-end"><Button variant="primary" loading={saving} onClick={save}>保存运行默认值</Button></div>
  </div>
}

function ProviderDialog({ open, value, saving, onClose, onSave }: { open: boolean; value: ProviderConfig | null; saving: boolean; onClose: () => void; onSave: Mutate }) {
  const [id, setId] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [api, setApi] = useState('openai-completions')
  const [models, setModels] = useState<Array<Record<string, unknown>>>([])
  const [key, setKey] = useState('')
  const blankModel = (): Record<string, unknown> => ({
    id: '', name: '', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192,
  })
  useEffect(() => {
    if (!open) return
    setId(value?.id ?? '')
    setBaseUrl(value?.baseUrl ?? 'https://api.openai.com/v1')
    setApi(value?.api ?? 'openai-completions')
    setModels((value?.models?.length ? value.models : [blankModel()]).map((item) => ({ ...item })))
    setKey('')
  }, [open, value])
  const updateModel = (index: number, patch: Record<string, unknown>) => {
    setModels((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  }
  const submit = async () => {
    const normalized = models.map((model) => ({
      ...model,
      id: String(model.id ?? '').trim(),
      name: String(model.name ?? model.id ?? '').trim(),
      contextWindow: Number(model.contextWindow),
      maxTokens: Number(model.maxTokens),
      input: Array.isArray(model.input) && model.input.includes('image') ? ['text', 'image'] : ['text'],
      reasoning: Boolean(model.reasoning),
    }))
    if (!id.trim() || !baseUrl.trim() || normalized.length === 0 || normalized.some((model) => !model.id || !Number.isInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isInteger(model.maxTokens) || model.maxTokens <= 0 || model.maxTokens > model.contextWindow)) {
      toast.danger({ title: '模型配置无效', description: '请填写供应商、URL、模型 ID，并确保输出上限不超过上下文窗口。' })
      return
    }
    await onSave({ method: 'config.provider.save', params: { provider: { id: id.trim(), baseUrl: baseUrl.trim(), api, models: normalized } } })
    if (key.trim()) await onSave({ method: 'config.credential.set', params: { providerId: id.trim(), apiKey: key } })
  }
  return <Dialog open={open} onClose={onClose} title={value ? `编辑供应商 · ${value.id}` : '添加模型供应商'} description="模型元数据使用表单校验；API Key 单独写入 auth.json 且不会回显。" size="lg" footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={saving} onClick={() => void submit()}>保存并重载</Button></>}>
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Labeled label="供应商 ID"><TextInput aria-label="供应商 ID" value={id} disabled={!!value} onChange={(e) => setId(e.target.value)} mono /></Labeled>
        <Labeled label="API 适配器"><Select value={api} options={[{ value: 'openai-completions', label: 'OpenAI Chat Completions' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]} onChange={setApi} size="sm" /></Labeled>
        <Labeled label="Base URL"><TextInput aria-label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} mono /></Labeled>
        <Labeled label={value?.credentialConfigured ? '替换 API Key（可留空）' : 'API Key'}><TextInput aria-label="API Key" type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)} mono /></Labeled>
      </div>
      <div className="flex items-center justify-between border-t border-line pt-3">
        <div><div className="text-xs font-medium text-fg">模型</div><div className="mt-0.5 text-2xs text-fg-subtle">上下文与输出上限会直接控制压缩和请求预算</div></div>
        <Button size="sm" variant="outline" iconLeft={<Plus size={13} />} onClick={() => setModels((current) => [...current, blankModel()])}>添加模型</Button>
      </div>
      <div className="grid gap-3">
        {models.map((model, index) => {
          const modelId = String(model.id ?? '')
          const inputs = Array.isArray(model.input) ? model.input : ['text']
          return <div key={`${index}:${modelId}`} className="rounded-lg border border-line bg-surface-2 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-fg">{modelId || `模型 ${index + 1}`}</span>
              <Button aria-label={`删除模型 ${index + 1}`} size="xs" variant="ghost" disabled={models.length === 1} onClick={() => setModels((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={12} /></Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Labeled label="模型 ID"><TextInput aria-label={`模型 ${index + 1} ID`} value={modelId} onChange={(event) => updateModel(index, { id: event.target.value })} mono /></Labeled>
              <Labeled label="显示名称"><TextInput aria-label={`模型 ${index + 1} 显示名称`} value={String(model.name ?? '')} onChange={(event) => updateModel(index, { name: event.target.value })} /></Labeled>
              <Labeled label="上下文窗口"><TextInput aria-label={`模型 ${index + 1} 上下文窗口`} type="number" min={1} value={String(model.contextWindow ?? '')} onChange={(event) => updateModel(index, { contextWindow: event.target.value })} mono /></Labeled>
              <Labeled label="最大输出"><TextInput aria-label={`模型 ${index + 1} 最大输出`} type="number" min={1} value={String(model.maxTokens ?? '')} onChange={(event) => updateModel(index, { maxTokens: event.target.value })} mono /></Labeled>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-5">
              <Switch checked={Boolean(model.reasoning)} onChange={(checked) => updateModel(index, { reasoning: checked })} label="支持思考" />
              <Switch checked={inputs.includes('image')} onChange={(checked) => updateModel(index, { input: checked ? ['text', 'image'] : ['text'] })} label="支持图片" />
            </div>
          </div>
        })}
      </div>
    </div>
  </Dialog>
}

function McpDialog({ open, value, trusted, saving, onClose, onSave }: { open: boolean; value: McpServerSettings | null; trusted: boolean; saving: boolean; onClose: () => void; onSave: Mutate }) {
  const [name, setName] = useState(''); const [command, setCommand] = useState(''); const [args, setArgs] = useState('[]'); const [scope, setScope] = useState<ConfigScope>('user'); const [readOnly, setReadOnly] = useState(true)
  useEffect(() => { if (!open) return; setName(value?.name ?? ''); setCommand(value?.command ?? ''); setArgs(JSON.stringify(value?.args ?? [], null, 2)); setScope(value?.scope ?? 'user'); setReadOnly((value?.permission ?? 'read-only') === 'read-only') }, [open, value])
  const submit = () => { try { const parsed = JSON.parse(args) as string[]; void onSave({ method: 'config.mcp.save', params: { scope, server: { name, command, args: parsed, timeout: value?.timeout ?? 30, enabled: true, permission: readOnly ? 'read-only' : 'full-access', protocolVersion: value?.protocolVersion ?? 'auto' } } }) } catch (error) { toast.danger({ title: '参数 JSON 格式错误', description: message(error) }) } }
  return <Dialog open={open} onClose={onClose} title={value ? `编辑 MCP · ${value.name}` : '添加 MCP 服务器'} description="命令由 FoxCode 宿主启动。环境变量值不会回传到界面。" footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={saving} onClick={submit}>保存并重载</Button></>}>
    <div className="grid gap-3"><Labeled label="名称"><TextInput aria-label="MCP 名称" value={name} disabled={!!value} onChange={(e) => setName(e.target.value)} mono /></Labeled><Labeled label="命令"><TextInput aria-label="MCP 命令" value={command} onChange={(e) => setCommand(e.target.value)} mono placeholder="npx / uvx / python" /></Labeled><Labeled label="参数（JSON 数组）"><TextArea aria-label="MCP 参数" value={args} onChange={(e) => setArgs(e.target.value)} mono minRows={3} /></Labeled><div className="grid gap-3 md:grid-cols-2"><Labeled label="保存范围"><Select value={scope} options={SCOPE_OPTIONS.filter((item) => trusted || item.value === 'user')} onChange={(next) => setScope(next as ConfigScope)} /></Labeled><Labeled label="最小权限"><Switch checked={readOnly} onChange={setReadOnly} label={readOnly ? '只读' : '完全访问'} /></Labeled></div></div>
  </Dialog>
}

function SubagentDialog({ open, value, trusted, saving, onClose, onSave }: { open: boolean; value: SubagentSettings | null; trusted: boolean; saving: boolean; onClose: () => void; onSave: Mutate }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [prompt, setPrompt] = useState(''); const [tools, setTools] = useState('read, grep, find, ls'); const [scope, setScope] = useState<ConfigScope>('user')
  useEffect(() => { if (!open) return; setName(value?.name ?? ''); setDescription(value?.description ?? ''); setPrompt(value?.systemPrompt ?? ''); setTools(value?.allowedTools?.join(', ') ?? ''); setScope(value?.scope === 'project' ? 'project' : 'user') }, [open, value])
  const submit = () => void onSave({ method: 'config.subagent.save', params: { scope, subagent: { name, description, systemPrompt: prompt, allowedTools: tools.trim() ? tools.split(',').map((item) => item.trim()).filter(Boolean) : null } } })
  return <Dialog open={open} onClose={onClose} title={value ? `编辑 Subagent · ${value.name}` : '创建 Subagent'} description="每个角色运行在隔离上下文中，工具集只能收紧父 Agent 的能力。" size="lg" footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={saving} onClick={submit}>保存并重载</Button></>}>
    <div className="grid gap-3"><div className="grid gap-3 md:grid-cols-2"><Labeled label="名称"><TextInput aria-label="Subagent 名称" value={name} disabled={!!value} onChange={(e) => setName(e.target.value)} mono /></Labeled><Labeled label="保存范围"><Select value={scope} options={SCOPE_OPTIONS.filter((item) => trusted || item.value === 'user')} onChange={(next) => setScope(next as ConfigScope)} /></Labeled></div><Labeled label="用途描述"><TextInput aria-label="Subagent 描述" value={description} onChange={(e) => setDescription(e.target.value)} /></Labeled><Labeled label="允许工具（逗号分隔；留空继承）"><TextInput aria-label="Subagent 工具" value={tools} onChange={(e) => setTools(e.target.value)} mono /></Labeled><Labeled label="系统提示词"><TextArea aria-label="Subagent 提示词" value={prompt} onChange={(e) => setPrompt(e.target.value)} minRows={9} maxRows={18} /></Labeled></div>
  </Dialog>
}

function SettingsSection({ id, title, hint, icon, children }: { id: string; title: string; hint?: string; icon?: ReactNode; children: ReactNode }) { return <section id={`settings-${id}`} data-section={id} className="scroll-mt-4 flex flex-col gap-3"><div className="flex flex-wrap items-center gap-2">{icon}<h2 className="text-[13px] font-semibold tracking-wide text-fg">{title}</h2>{hint ? <span className="text-2xs text-fg-subtle">{hint}</span> : null}</div><div className="surface-card flex flex-col gap-4 rounded-xl p-5 shadow-soft">{children}</div></section> }
function SectionToolbar({ text, onAdd, addLabel }: { text: string; onAdd: () => void; addLabel: string }) { return <div className="flex items-center justify-between gap-3"><span className="text-2xs text-fg-subtle">{text}</span><Button size="sm" variant="primary" iconLeft={<Plus size={13} />} onClick={onAdd}>{addLabel}</Button></div> }
function Labeled({ label, children }: { label: string; children: ReactNode }) { return <div><FieldLabel>{label}</FieldLabel>{children}</div> }
function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-line p-5 text-center text-xs text-fg-subtle">{text}</div> }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
