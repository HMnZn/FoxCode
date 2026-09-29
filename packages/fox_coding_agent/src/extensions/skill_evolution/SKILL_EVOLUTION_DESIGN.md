# 自进化 Skill 扩展

## 目标与边界

这个扩展学习的是可复用方法，而不是项目事实。事实、偏好和外部资料仍由 Memory
扩展负责；稳定工作流、输出规范、纠正规则和判断标准才进入 Skill 演化。

BearCode 的设计里最有价值的部分是反馈窗口、add/merge/discard、版本快照、来源追踪
和使用评估。FoxCode 保留这些思想，但将“模型直接写 Skill”改成隔离式两阶段提交：

```text
本轮请求与回答
  -> 等待下一轮用户反馈
  -> 辅助模型抽取至多一个候选
  -> 本地安全门禁与重复检测
  -> proposals.json 隔离候选（尚未生效）
  -> skill_evolution 工具 / /skill-evolution apply 明确提交
  -> 原子更新 SKILL.md + 旧版本快照 + provenance
  -> 当前会话立即刷新技能目录
```

自动抽取失败不会修改活动 Skill。默认置信度门槛为 0.7；密钥形态、固定 URL、精确日期、
无用户证据、非法技能名和超长正文会被本地规则拒绝，不能被模型绕过。
被拒绝的候选正文不会持久化；正常候选的来源窗口也会再次脱敏密钥、URL 和精确日期。

## 存储

- 活动项目 Skill：`<cwd>/.foxcode/skills/<name>/SKILL.md`
- 用户 Skill：`~/.foxcode/skills/<name>/SKILL.md`
- 候选与审计：`~/.foxcode/projects/<project-id>/skill-evolution/`
- 旧版本：上述目录的 `history/*.jsonl`
- 完整来源事件：上述目录的 `provenance.jsonl`

扩展状态和活动 Skill 分离，因此候选不会被技能发现器误加载。写入采用同目录临时文件与
`os.replace`；合并前的完整 `SKILL.md` 会进入历史记录。

## 启用与使用

桌面端“插件/扩展”页面会像 Memory、Subagent 一样自动发现 `skill_evolution`，打开开关
即可热加载。也可以在 `settings.json` 中配置：

```json
{
  "extensions": [
    "module:fox_coding_agent.src.extensions.skill_evolution:setup"
  ]
}
```

模型工具 `skill_evolution` 支持 `status`、`list`、`propose`、`apply`、`discard`。
命令行提供：

```text
/skill-evolution status
/skill-evolution list
/skill-evolution read <proposal-id>
/skill-evolution apply <proposal-id> [project|user]
/skill-evolution discard <proposal-id> [reason]
/skill-evolution dir
```

## 评估与消融

### 1. 不调用模型的机制评估

运行真实的候选校验、重复判定、落盘和 provenance 代码，并分别移除安全门禁、去重、
来源追踪，分别观察决策准确率与可追溯率：

```bash
uv run python -m fox_coding_agent.src.extensions.skill_evolution.evaluation offline
```

用例文件是 `fixtures/evolution_eval/cases.jsonl`，覆盖新增、合并、密钥、固定 URL、日期和
缺少用户证据；当前可复现汇总保存在 `fixtures/evolution_eval/results.json`。该结果评估的
是演化机制，不是大模型答题能力。

### 2. BearCode 数据审计

```bash
uv run python -m fox_coding_agent.src.extensions.skill_evolution.evaluation audit \
  --data-root '/mnt/c/Users/Qin/Desktop/秋招/BearCode/data'
```

BearCode `data/` 不是自进化训练集。GAIA/HLE 可用于最终任务 Pass@1，但 GAIA 的文件附件、
HLE 图像以及 ALFWorld/WebShop 交互环境并未完整包含在该目录。审计命令会逐类报告可运行与
跳过数量，不把缺环境样本伪装成真实执行。ToolHop 目录含问题、答案和工具 schema，但没有
对应工具实现；若另行直接问模型，也只能算 direct-answer 诊断，不能宣称 ToolHop agent 成绩。
本次目录审计快照保存在 `fixtures/evolution_eval/bear_data_audit.json`。

### 3. 真实模型 Pass@1 与 Skill 消融

```bash
uv run python -m fox_coding_agent.src.extensions.skill_evolution.evaluation live \
  --data-root '/mnt/c/Users/Qin/Desktop/秋招/BearCode/data' \
  --datasets gaia,hle \
  --skills-dir .foxcode/skills \
  --variants baseline,metadata-only,full \
  --model provider/model-name \
  --limit 20
```

三个条件分别是不注入 Skill、只注入名称/描述、注入完整当前 Skill。每个样本只调用一次，
使用严格归一化精确匹配统计 Pass@1。逐样本输出和汇总保存在
`.foxcode/evals/skill-evolution/`。这是会实际产生模型费用的入口，因此默认不会在测试中运行。

要做正式报告，应固定模型、温度、样本顺序、Skill 快照和数据版本，并至少报告：总样本数、
跳过原因、各 variant Pass@1、相对 baseline 的百分点变化、token 用量和失败样本。
