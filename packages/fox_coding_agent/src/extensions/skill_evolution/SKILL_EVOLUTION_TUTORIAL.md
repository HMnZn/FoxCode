# 自进化 Skill 学习教程

## 1. 先理解它解决什么问题

Memory 与 Skill 保存的内容不同：

- Memory 保存事实、偏好和项目背景，例如“默认使用中文”。
- Skill 保存可复用的方法，例如“代码审查先列阻塞问题，再给最小修复方案”。

自进化不是让模型随意改提示词，而是把一次对话里得到的方法先变成候选，再经过规则、
权限和人工确认，最终写入标准 `SKILL.md`。候选与活动 Skill 分开存放，所以抽取错误不会
立刻影响后续任务。

## 2. 一次演化的完整生命周期

```text
第 N 轮用户请求与助手回答
  -> 暂存反馈窗口
第 N+1 轮用户反馈
  -> 辅助模型抽取一个可复用候选
  -> 本地安全门禁
  -> 重名与相似 Skill 检查
  -> pending proposal
  -> apply 或 discard
  -> SKILL.md + version + history + provenance
```

为什么等下一轮反馈：助手自己的回答不能证明用户认可了某种方法。下一轮出现“以后也这样做”
或明确纠正时，证据才足够强。

## 3. 源码地图

| 文件 | 作用 |
| --- | --- |
| `models.py` | 候选、proposal、状态和动作的数据结构 |
| `extraction.py` | 辅助模型提示词、JSON 解析和字段归一化 |
| `store.py` | 安全门禁、去重、原子写入、版本快照和来源日志 |
| `extension.py` | 扩展注册、生命周期钩子、工具、命令和上下文注入 |
| `evaluation.py` | 离线机制评估、数据审计和真实 API 消融 |

扩展注册三个关键钩子：

- `agent_end`：保存刚完成的一轮，等待下一次用户反馈。
- `before_prompt`：把上一轮和新反馈交给抽取器，只生成隔离候选。
- `session_start`：绑定项目目录、用户目录并激活扩展工具。

## 4. 为什么不能让模型直接写文件

模型输出只是建议，必须经过本地不可绕过的门禁：

- 名称必须是合法 kebab-case。
- description、instructions、用户证据不能为空。
- 密钥形态、固定 URL、精确日期和超长正文拒绝持久化。
- 被拒绝的候选正文不写磁盘。
- 正常来源窗口仍会二次脱敏。

通过门禁的候选进入 `proposals.json`，状态为 `pending`。只有调用 `apply` 后才会进入项目级
或用户级 Skills 目录。

## 5. add 与 merge

候选名称与现有 Skill 相同，或者名称、描述和触发条件的词项相似度达到阈值时，建议
`merge`；否则建议 `add`。合并前会把旧 `SKILL.md` 完整写入 `history/*.jsonl`，版本号只
递增 patch，例如 `0.1.0 -> 0.1.1`。

所有活动 Skill 仍使用 FoxCode 原有发现机制：

- 项目级：`<cwd>/.foxcode/skills/<name>/SKILL.md`
- 用户级：`~/.foxcode/skills/<name>/SKILL.md`

写入完成后当前会话会重新加载 Skill，无需重启。

## 6. 如何启用和观察

桌面端“插件”页面会把 `skill_evolution` 与 Memory、Subagent 一样显示为内置扩展。启用后
可使用：

```text
/skill-evolution status
/skill-evolution list
/skill-evolution read <proposal-id>
/skill-evolution apply <proposal-id> [project|user]
/skill-evolution discard <proposal-id> [reason]
/skill-evolution dir
```

模型侧的 `skill_evolution` 工具支持相同的 status、list、propose、apply 和 discard 动作。

## 7. 随附数据集

`data/ALFWorld/test.json` 包含 134 条家庭物品目标，每条记录包括：

- `goal`：自然语言任务目标；
- `difficulty`：难度标签；
- `subgoals`：期望出现的有序子目标模式。

这里只复制了约 33 KB 的单一数据集。由于没有交互环境，它适合评估“是否正确拆解动作顺序”，
不适合宣称真实环境任务完成率。

## 8. 三类评估不要混在一起

### 8.1 机制评估

不调用外部模型，直接运行生产代码中的安全门禁与 add/merge 决策：

```bash
python -m fox_coding_agent.src.extensions.skill_evolution.evaluation offline
```

它回答“演化系统是否安全、可追溯、会不会重复创建”，不回答模型是否更会做任务。

### 8.2 数据审计

```bash
python -m fox_coding_agent.src.extensions.skill_evolution.evaluation audit
```

它确认数据规模和缺失环境，防止把不可运行样本当成真实成功或失败。

### 8.3 真实 API Skill 消融

真实评估必须用同一模型、同一批样本和同一解码参数比较：

```text
baseline：不注入用户级 Skill
full：注入完整用户级 Skill
```

家庭任务数据只统计动作分解质量：期望动作是否按顺序出现、目标物品是否出现。逐样本预测、
token 用量、错误和汇总必须落盘。评估输出不能写成模拟器成功率。

用户级 `household-task-planner` 的真实 API 对照命令是：

```bash
python -m fox_coding_agent.src.extensions.skill_evolution.evaluation planning-live \
  --model deepseek/deepseek-v4-flash \
  --limit 8 \
  --output packages/fox_coding_agent/src/extensions/skill_evolution/fixtures/evolution_eval/planning_api_eval.json
```

本次保存的真实调用结果使用 8 条固定样本：

| 变体 | 计划通过率 | 平均动作召回率 | API 错误 |
| --- | ---: | ---: | ---: |
| baseline | 0.00 | 0.4583 | 0 |
| full | 0.75 | 0.8333 | 1 |
| 差值 | +0.75 | +0.3750 | — |

完整 Skill 在 8 条中通过 6 条，但其中 1 条请求超时并按失败计入，因此这是一组偏保守的小样本
结果。原始预测、token、费用、停止原因和错误保存在
`fixtures/evolution_eval/planning_api_eval.json`。它只证明这批样本上的动作分解改善，不能外推为
交互环境成功率或生产质量保证。

上面的 baseline/full 是静态 Skill 消融，只能说明 Skill 是否有效，不能证明 Skill 自己发生了
进化。端到端闭环必须另外运行。

### 8.4 真实 API 端到端自进化闭环

```bash
python -m fox_coding_agent.src.extensions.skill_evolution.evaluation evolve-live \
  --model deepseek/deepseek-v4-flash \
  --evolution-limit 9 \
  --test-limit 8 \
  --retries 1 \
  --output packages/fox_coding_agent/src/extensions/skill_evolution/fixtures/evolution_eval/e2e_api_eval.json
```

该命令执行的不是提示词替换，而是完整生产路径：

1. 将 v0.1.0 初始 Skill 复制到隔离的用户级 Skills 目录；
2. 用真实 API 在 9 条演化集样本上运行 v0，收集失败；
3. 根据失败标签生成明确的评估者反馈；
4. 通过生产 `extract_candidate()` 再次调用真实 API 提炼候选；
5. 通过生产 `propose()` 进入 `pending`，并确认建议动作是 `merge`；
6. 通过生产 `apply()` 写入历史、来源并升级到 v0.1.1；
7. 重新加载写入后的 Skill；
8. 在完全不同的 8 条留出样本上比较无 Skill、v0.1.0 和 v0.1.1。

本次真实结果：

| 留出集变体 | 版本 | 计划通过率 | 平均动作召回率 | 最终 API 错误 |
| --- | --- | ---: | ---: | ---: |
| baseline | 无 Skill | 0.000 | 0.4583 | 0 |
| initial_skill | v0.1.0 | 0.125 | 0.6042 | 0 |
| evolved_skill | v0.1.1 | 0.750 | 0.9167 | 0 |

相对 v0.1.0，v0.1.1 的计划通过率提升 `0.625`，动作召回率提升 `0.3125`。两次首轮
调用超时均在一次重试后成功，原始 attempts 保留在报告中。报告还保存了真实提炼响应、候选、
pending proposal、应用记录、Skill 前后哈希、完整 diff、history 和 provenance。演化集 ID 为
0–8，留出集 ID 为 9–16，没有交叉。

为了不污染日常使用的用户 Skill，自动 apply 只发生在临时的用户级目录布局中。这里验证的是
真实写入路径和版本机制，但不会覆盖 `~/.foxcode/skills` 下正在使用的文件。

## 9. 消融结果怎么读

离线消融分别关闭安全门禁、去重和 provenance：

- 关闭安全门禁主要伤害拒绝错误候选的能力。
- 关闭去重会把应合并的候选误判为新增。
- 关闭 provenance 不一定改变 add/merge 决策，但可追溯率会变成零。

所以不能只看一个总分；至少同时报告决策准确率、安全拒绝、合并正确率和可追溯率。

## 10. 常见调试顺序

1. `status` 查看目录与各状态数量。
2. `list` 查看候选是否真的进入 pending。
3. 检查 `last_extraction_error`，确认辅助模型调用有没有失败。
4. 查看 proposal 的 `reasons`，区分安全拒绝与低置信度。
5. apply 后检查活动 `SKILL.md`、history 和 provenance 是否同时更新。
6. 用固定样本重跑 baseline/full，避免凭单个对话判断“变好了”。

这套设计的核心不是自动写得越多越好，而是只让有用户证据、可复用、可撤查的方法进入活动
Skill 集合。
