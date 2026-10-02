(async () => {
  const results = []
  const frames = []
  const unsubscribe = window.foxcode.on('host:frame', (frame) => frames.push(frame))
  const assistantAnswered = (start, marker) => frames.slice(start).some((frame) =>
    frame.type === 'message_end' && frame.message?.role === 'assistant'
    && frame.message.stopReason === 'stop'
    && frame.message.content?.some((part) => part.type === 'text' && part.text.includes(marker)),
  )
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const body = () => document.body.innerText
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const waitFor = async (predicate, label, timeout = 180000) => {
    const started = Date.now()
    let lastError
    while (Date.now() - started < timeout) {
      try {
        const value = predicate()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(200)
    }
    throw new Error(`等待超时：${label}${lastError ? ` (${lastError})` : ''}`)
  }
  const button = (needle) =>
    [...document.querySelectorAll('button')].find((node) => {
      const label = `${node.textContent || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`
      return label.includes(needle)
    })
  const textarea = () => {
    const fields = [...document.querySelectorAll('textarea')]
    return fields.find((node) => !node.getAttribute('aria-label')) || fields[0]
  }
  const setText = (node, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const pressEnter = (node, options = {}) => {
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    )
  }
  const send = async (text) => {
    const field = await waitFor(textarea, '消息输入框')
    setText(field, text)
    await sleep(80)
    pressEnter(field)
  }
  const waitIdle = async () => {
    await waitFor(
      () => !button('中止本轮') && !body().includes('正在压缩上下文…'),
      '模型空闲',
    )
    await sleep(600)
  }

  await waitFor(
    () => textarea() && body().includes('已连接') && body().includes('e2e-live-workspace'),
    '真实宿主和工作区信息',
    60000,
  )
  const initialHost = await window.foxcode.invoke('host:info')
  assert(initialHost.transport === 'sidecar' && initialHost.sidecarConnected, '意外连接到了演示宿主')
  assert(initialHost.model?.displayName?.includes('DeepSeek'), '真实模型信息没有加载')
  results.push({ case: '真实 Electron/sidecar/model 连接', passed: true })

  // `/` 目录必须只暴露两个面向日常输入的动作。
  setText(textarea(), '/')
  await waitFor(() => body().includes('/文件') && body().includes('/压缩'), '/ 命令菜单')
  const slashLabels = [...document.querySelectorAll('button')]
    .map((node) => (node.textContent || '').trim())
    .filter((label) => /^\/(文件|压缩)/.test(label))
  assert(slashLabels.length === 2, `/ 菜单数量错误：${JSON.stringify(slashLabels)}`)
  results.push({ case: '/ 命令菜单仅含文件与压缩', passed: true })

  // `/文件` -> real files.list -> mention -> real model/tool read.
  setText(textarea(), '/文件')
  pressEnter(textarea())
  const fileList = await waitFor(
    () => document.querySelector('[aria-label="工作区文件"]'),
    '工作区文件选择器',
  )
  const fixture = [...fileList.querySelectorAll('button')].find((node) =>
    (node.textContent || '').includes('fixture.txt'),
  )
  assert(fixture, '文件选择器里没有 fixture.txt')
  fixture.click()
  await waitFor(() => textarea().value.includes('@fixture.txt'), '插入文件引用')
  setText(textarea(), '请使用 read 工具读取 @fixture.txt，并逐字回复文件中唯一一行。')
  pressEnter(textarea())
  await waitFor(
    () => body().includes('FOXCODE_REAL_E2E_MARKER_20260929') && !button('中止本轮'),
    '真实模型读取所选文件',
  )
  results.push({ case: '/文件选择、@引用、真实 read 工具', passed: true })

  // Start a deliberately slow tool call, then queue, edit, and promote it.
  const toolStart = frames.length
  await send('请只调用 bash 工具执行 sleep 20，然后简短说明。不要改用 Python。')
  await waitFor(() => frames.slice(toolStart).some((frame) =>
    frame.type === 'tool_execution_start' && frame.tool_name === 'bash'), '工具真正开始执行', 30000)
  assert(!frames.slice(toolStart).some((frame) => frame.type === 'tool_execution_end'), '插队前工具已经结束')
  await send('排队占位文本')
  await waitFor(() => document.querySelector('[aria-label="排队消息"]'), '排队消息出现')
  const edit = button('修改排队消息：')
  assert(edit, '找不到排队消息编辑按钮')
  edit.click()
  const editField = await waitFor(
    () => document.querySelector('textarea[aria-label="修改排队消息"]'),
    '排队消息编辑框',
  )
  setText(editField, '只回复 UI_STEER_OK')
  pressEnter(editField)
  await waitFor(() => body().includes('UI_STEER_OK'), '修改后的排队内容可见')
  const steer = button('立即插队')
  assert(steer, '找不到立即插队按钮')
  steer.click()
  await waitFor(
    () => assistantAnswered(toolStart, 'UI_STEER_OK') && !document.querySelector('[aria-label="排队消息"]') && !button('中止本轮'),
    '插队完成且队列清空',
  )
  results.push({ case: '真实工具执行期间排队、编辑、立即插队且模型确实回复', passed: true })

  await window.foxcode.invoke('host:command', { method: 'thinking.set', params: { level: 'high' } })
  const thinkingStart = frames.length
  await send('不要调用工具。请先深入思考单文件 HTML 编辑器的撤销重做、离线同步、并发冲突与崩溃恢复，分析所有边界情况后再给出完整代码。')
  await waitFor(() => {
    const batch = frames.slice(thinkingStart)
    return batch.some((frame) =>
      frame.assistant_message_event?.type === 'thinking_delta')
  }, '真实模型的纯思考阶段')
  setText(textarea(), '取消之前的任务，不调用工具，只回复 UI_REASONING_STEER_OK')
  await sleep(80)
  pressEnter(textarea(), { ctrlKey: true })
  await waitFor(() => assistantAnswered(thinkingStart, 'UI_REASONING_STEER_OK') && !button('中止本轮'),
    '纯思考期间 Ctrl+Enter 插队成功')
  assert(frames.slice(thinkingStart).some((frame) => frame.type === 'message_end'
    && frame.message?.stopReason === 'aborted'
    && frame.message.content?.some((part) => part.type === 'thinking')
    && !frame.message.content?.some((part) => part.type === 'toolCall' || part.type === 'text' && part.text)),
  '没有实际命中纯思考中止')
  assert(!body().includes('本轮出错'), '正常插队被显示成红色错误')
  assert(!frames.slice(thinkingStart).some((frame) => frame.message?.stopReason === 'error'), '插队后模型发生错误')
  results.push({ case: '纯思考期间快捷键插队，得到回复且无红色错误', passed: true })
  await window.foxcode.invoke('host:command', { method: 'thinking.set', params: { level: 'off' } })

  // Follow the actual keyboard UX: first Enter accepts the completion, the
  // second runs it. This also verifies that `/压缩` is not sent to the model as
  // an ordinary prompt.
  setText(textarea(), '/压缩')
  await sleep(150)
  pressEnter(textarea())
  await waitFor(() => textarea().value === '/压缩 ', '/压缩补全')
  await sleep(150)
  pressEnter(textarea())
  await waitFor(
    () => body().includes('上下文压缩完成') && !body().includes('正在压缩上下文…'),
    '/压缩完成',
  )
  results.push({ case: '/压缩真实宿主链路', passed: true })

  const historyInfo = await window.foxcode.invoke('host:info')
  const historyRows = await window.foxcode.invoke('host:sessions')
  const historyRow = historyRows.find((row) => row.file === historyInfo.sessionFile)
  assert(historyRow, '历史测试会话不存在')
  const historyTitle = `UI_PREVIEW_${Date.now()}`
  await window.foxcode.invoke('host:command', {
    method: 'sessions.rename', params: { id: historyRow.id, title: historyTitle },
  })

  const newSession = button('新建会话')
  assert(newSession, '找不到新建会话按钮')
  newSession.click()
  await waitFor(
    () => !body().includes('FOXCODE_REAL_E2E_MARKER_20260929') && textarea().value === '',
    '新建会话清空当前时间线',
  )
  results.push({ case: '新建会话', passed: true })

  const historyButton = await waitFor(() => [...document.querySelectorAll('button')].find((node) =>
    node.getAttribute('aria-label') === `打开会话 ${historyTitle}`), '侧栏历史会话按钮')
  historyButton.click()
  await waitFor(() => body().includes('UI_REASONING_STEER_OK'), '历史会话回放')
  const previewRows = await window.foxcode.invoke('host:sessions')
  const previewRow = previewRows.find((row) => row.id === historyRow.id)
  assert(previewRow?.updatedAt === historyRow.updatedAt, '仅点击预览就刷新了最后活动时间')
  assert(!body().includes('本轮出错'), '历史里的正常中止显示为红色错误')
  results.push({ case: '侧栏打开历史会话不更新最后活动时间', passed: true,
    before: historyRow.updatedAt, after: previewRow.updatedAt })

  // Start a conversation in the pre-seeded second project from the sidebar.
  // Use its exact accessible label: a substring search would hit the adjacent
  // expand/collapse row, which intentionally does not switch cwd.
  const second = await waitFor(
    () => document.querySelector('button[aria-label="在 e2e-live-project-two 新建对话"]'),
    '第二项目的新对话按钮',
  )
  second.click()
  const switchStarted = Date.now()
  let switchedHost
  while (Date.now() - switchStarted < 60000) {
    switchedHost = await window.foxcode.invoke('host:info')
    if (switchedHost.cwd.endsWith('/e2e-live-project-two')) break
    await sleep(200)
  }
  assert(switchedHost?.cwd.endsWith('/e2e-live-project-two'), '项目切换没有到达真实宿主')
  await waitFor(
    () => document.querySelector('p[title$="/e2e-live-project-two"]') && textarea()?.value === '',
    '项目切换同步到渲染器',
  )
  await send('请使用 read 工具读取 project-two.txt，并只回复文件内容。')
  await waitFor(
    () => body().includes('FOXCODE_SECOND_PROJECT_MARKER_20260929') && !button('中止本轮'),
    '第二项目真实读取',
  )
  results.push({ case: '最近项目切换与新项目会话', passed: true })

  await waitIdle()
  unsubscribe()
  return { passed: results.length, total: results.length, results }
})()
