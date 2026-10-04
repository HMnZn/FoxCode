# FoxCode 插件式 Skills 自进化

本实现把在线 Skill 沉淀与评估方法接入 FoxCode 的扩展 API。核心算法是 BM25 召回、pending window、Extractor、Maintainer 的 `add / merge / discard`、来源与使用统计，以及 replay/rule/candidate/champion 评估。运行入口始终是 FoxCode 插件：`create_skill_evolution_extension()` 注册生命周期钩子、上下文变换、工具、服务和 `/skill-evolution` 命令，未修改核心 Agent 的 Skill loader。

在线回放质检不能当成 benchmark 的任务正确率。唯一 coding benchmark 选择 API-Bank `level-1-api`，用独立的三组对照和程序化 EM 判分；协议与真实结果见 [实验文档](fixtures/README.md)。

从概念、事件顺序、算法参数、源码定位到真实中文 Skill 前后对照，请读[教学文档](TUTORIAL.md)。正式确认集里进化 Skill 比初始 Skill 高 4/159，但与无 Skill 持平；这里不宣称已证明净收益。

## 一条在线链路

```text
用户请求 → BM25 检索现有 Skill → 只注入 top-3 引用供模型选择
        → Agent 完成任务 → 记录 pending window 和 retrieved reference
下一轮用户反馈 → Extractor 抽取至多一个 durable candidate
        → Maintainer 决定 add / merge / discard
        → FoxCode Store 隔离暂存 proposal、记录 provenance
        → 用户显式 apply → 原子写入 SKILL.md、版本快照、正常 loader 热刷新
任务结束后 → 判断 retrieved / relevant / used，累积 usage stats
/skill-evolution eval → 冻结 replay → 规则判分 → 候选重放 → status/champion
```

`before_prompt` 读取下一条用户反馈，`agent_end` 保存最近消息并判断 Skill 是否真正被使用。这样不会让助手在刚生成回答后凭自己猜测立即写入长期方法。提取器只接受用户话语作为方法证据；旧助手回复和 BM25 引用仅提供上下文。普通任务内容、临时参数、私密信息、URL 和弱确认要返回空候选。

`retrieval.py` 使用 BM25：中英文 token 化，元数据重复三次加权、正文前 2500 字、`k1=1.4`、`b=0.75`，默认最多 3 条、最低分 `0.08`。召回不是调用；上下文只告诉模型候选 Skill 的名称、描述、触发条件和来源，不能据此计“已使用”。任务结束后再以 `relevant/used` 二元 Judge 提问，只有回复实际遵循独特方法才记 `used`。Judge 不可用时按未证实处理，避免虚增使用率。

`extraction.py` 使用 `{"skills": []}` / 单候选 JSON 合约。`maintainer.py` 使用 `add|merge|discard` 决策 schema：先查名称/描述/触发条件的精确身份，再用 BM25 取最多 8 个相似 Skill（最低分 `0.03`）；精确身份强制 merge，模型判 add 且相似度至少 `0.55` 也转 merge，非法动作降级 discard。merge 输出一份完整正文，FoxCode Store 以 `replace` 暂存，避免每次在正文尾部堆叠规则。运行时旧 `append` 模式保留给手动提出的兼容用法；自动 Maintainer 的同名合并走整篇 `replace`。

权限边界是：插件先将候选写到隔离 `proposals.json`，待显式 `apply` 后才更新项目/用户 Skill。这保持 FoxCode 现有权限模型，不让在线评价或候选生成静默改写用户文件。`apply` 再跑本地安全检查、存旧版 `history/*.jsonl`、递增 patch 版本、原子写入并用标准 loader 重载；失败恢复旧版。`provenance.jsonl` 和 `online_provenance.jsonl` 记录决策与脱敏来源，`online_skill_provenance.json` 按 Skill 聚合，`skill_usage_stats.json` 保存召回与使用计数。

## 在线评估与 champion

`online_eval.py` 实现 replay 构造、规则编译、候选变体、状态判定和晋级阈值。`/skill-evolution eval` 读取当前插件的 provenance、usage 和活跃 Skill，按 Skill 形成 lineage；同一会话内容哈希去重，冻结为 `online-eval/datasets/<lineage>/replay_pool.jsonl`。`sample_id` 前 8 位十六进制按 `0.75` 阈值划分 `mutate_dev` / `promotion_test`，至少两条时保证两边均非空。旧池按 ID 合并，新样本进入后可审计分配。

规则分有程序化与可选 LLM 二元 Judge 两类。每条规则通过记 1 分，硬规则通过记 2 分；`pass_rate` 是规则判断通过率，**不是任务正确率**。失败规则生成最多 4 个启发式候选和一个 LLM 候选；在 dev 回放上重新生成回复和判分，选择平均规则分最高、硬失败较少的版本，再在 promotion-test 上看表现。默认状态门槛为至少 2 条 replay、1 条 promotion-test、5 次检索，规则通过率至少 `0.8`、相关率至少 `0.35`、使用率至少 `0.2` 且无硬失败；不满足时为 `unobserved`、`incubating` 或 `watch`。只有 `healthy` 候选的平均分比已存 champion 高至少 `0.01`、硬失败不增加时才记录新 champion。champion 是候选快照，**不会自动覆盖活跃 Skill**。

这个评估的性质是：历史 active 回复和候选新生成回复不是完全对称的 A/B，规则通过不保证接口请求正确；单靠 champion 不足以声称 coding 能力提升。因此 `fixtures` 的 API-Bank 实验另用同题、同模型、同调用数的无 Skill/初始/进化三组，以完整 API 名与参数 EM 为主指标，保存逐题响应、成本和配对结果。用户若只看 `/skill-evolution eval` 中的 `healthy`，仍不能把它解释成 benchmark 胜率。

## 代码和状态

| 文件 | 职责 |
| --- | --- |
| `extension.py` | FoxCode 插件钩子、工具、命令、热刷新 |
| `retrieval.py` | BM25 检索与 top-3 引用 |
| `extraction.py` | pending feedback 的单候选提取 |
| `maintainer.py` | `add / merge / discard` 与完整正文合并 |
| `store.py`、`models.py` | 隔离提案、安全门禁、版本历史、provenance、usage |
| `online_eval.py` | replay/rule/candidate/status/champion 评估 |
| [`fixtures/README.md`](fixtures/README.md) | 唯一数据集的初始/进化 Skill、可复核实验、局限 |

工作区未受信时插件不进行提取、使用判断或写入。敏感候选被本地门禁拒绝，来源消息最多保留 12 条并脱敏；但启发式过滤不是安全证明。插件**不自动归档长期未使用的活跃 Skill**，因为归档会移动整个 Skill 目录，需要用户明确授权。在线评估仍会标记长期无效的 Skill，用户可据此决定是否清理。
