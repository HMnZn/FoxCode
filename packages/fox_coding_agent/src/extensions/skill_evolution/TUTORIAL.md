# FoxCode 自进化 Skill：从概念到源码、实验

本文面向第一次接触 Agent 扩展的开发者。先读[总览](README.md)，实验数字和复核命令以[实验页](fixtures/README.md)为准。实现采用一条统一的在线流程：**检索 → 观察 → 提取 → 维护 → 隔离提案 → 显式应用 → 在线质检**。算法尽量保持原方法的操作语义，同时通过 FoxCode 扩展 API 而不是修改核心 Agent 实现。

## 1. 为什么需要 Skill 自进化

普通对话历史只是上下文；下次会话未必还在。Memory 更适合存事实，例如“项目的测试命令是什么”；Skill 则保存**未来可复用的做事步骤**，例如“根据 API schema 选下一次调用时先检查依赖，再验证参数来源”。如果把一次性姓名、令牌、失败猜测或具体答案保存为 Skill，后续任务会被错误约束。因此自进化的关键不是多写规则，而是从反馈中找出有证据、可迁移的方法，并决定它是新能力、既有能力的合并，还是应该丢弃。

本实现中，模型负责语义判断；确定性代码负责限制候选数、校验字段、查重、暂存、版本和审计。自动提取**不等于自动发布**。这一点让方法学习与用户文件权限分离。

## 2. 一个回合如何流转

```text
用户请求
  ├─ before_prompt：BM25 检索最多 3 个现有 Skill，注入名称/描述/触发条件
  └─ Agent 正常回答
        ├─ agent_end：保存最近的 user/assistant 消息为 pending window
        └─ 判断召回 Skill 是否相关、是否真的被回复使用
下一个用户回合（可能包含“以后都先检查依赖”）
  └─ before_prompt：上一个 pending window + 新用户话语
        ├─ Extractor：0 或 1 个可复用候选
        ├─ Maintainer：add / merge / discard
        └─ Store：安全过滤、来源记录、生成待审提案
用户检查提案并显式 apply → 原子写入 Skill、保存旧版本、刷新正常 loader
需要质检时运行 eval → 冻结回放、规则评分、候选/冠军状态；不自动发布
```

使用下一条用户反馈而非只看刚刚的助手回答，是因为“我会这么做”只是助手承诺，不是用户认可的方法证据。若下一轮用户纠正了做法，Extractor 才有真实的纠错信号。插件在未受信任项目中不进行这些读取与写入操作。

### 对应源码

| 概念 | 文件及入口 | 核心职责 |
| --- | --- | --- |
| 插件接线 | `extension.py:create_skill_evolution_extension` | 注册 `session_start`、`before_prompt`、`agent_end`、上下文变换、工具、命令 |
| 召回 | `retrieval.py:retrieve_relevant_skills` | 对名称、描述、触发条件和正文算 BM25 |
| 候选提取 | `extraction.py:extract_candidate` | 从 pending window 提取最多一个方法 |
| Skill 集维护 | `maintainer.py:maintain_candidate` | 决定 add/merge/discard，并合成完整正文 |
| 持久化 | `store.py:SkillEvolutionStore` | 提案隔离、安全门禁、版本历史、provenance、usage |
| 在线质检 | `online_eval.py:evaluate_online_skill_evolution_async` | replay、规则、候选选择、状态、champion |
| 任务正确率 | `fixtures/experiment.py` | API-Bank 训练/验证/确认、三组 EM、配对分析与离线审计 |

## 3. 检索：召回不是使用

`retrieval.py` 将英文词和相邻汉字双字词转成 token。Skill 的 name、description、when-to-use 会重复三次加权，正文只取前 2,500 字；BM25 参数为 `k1=1.4, b=0.75`。在线请求最多召回 3 条，最低分 0.08。注入内容是**候选目录**，不是无条件的系统命令：模型仍要判断当前请求是否匹配。

统计时需要区分三个事件：

1. `retrieved`：检索器返回了这条 Skill。
2. `relevant`：任务和方法确实相关。
3. `used`：最终回复体现了这条 Skill 的独特步骤，而非仅仅在上下文里出现。

`agent_end` 的 Judge 判断后两者；Judge 失败时不把相关/使用计为真。这样避免“检索到了就算生效”的虚假使用率。相关性 Judge 仍是模型判断，不是任务结果的金标准。

## 4. 从反馈提取候选

Extractor 输入最多 12 条压缩消息、最近的检索引用，以及新到来的用户话语。输出只接受严格 JSON：`{"skills":[]}`，或 `{"skills":[{"name":"...","description":"...","when_to_use":"...","instructions":"...","evidence":"...","tags":[]}]}`。它最多选一个候选，用户消息是主要证据；助手消息和召回引用只是理解上下文。若只有一次性请求、弱确认、URL、账号、密钥、精确日期或助手自己推断出的偏好，就输出空数组。

例如用户说“以后生成 API 请求先检查 token 依赖，不要猜缺失参数”，可归纳为中文的跨任务方法；“这次请给张三发邮件，token 是 xyz”不能保存具体姓名或令牌。提取后的 `SkillCandidate` 还要通过 Store 的本地检查，失败会留下拒绝记录而非写入活跃 Skill。

## 5. Maintainer：统一管理，而不是不断追加

Maintainer 先比较候选与现有 Skill 的名称、描述、触发条件，进行精确身份匹配；再用同一检索器找最多 8 个相似 Skill，最低分 0.03。模型只可给出 `add`、`merge`、`discard`。精确身份命中强制 merge；若模型要求 add 但相似 Skill 分至少 0.55，也转成 merge。非法决策直接 discard。

**add** 代表能力集合里确实没有这类方法。**merge** 应返回包含旧有效步骤和新通用步骤的完整 Skill 正文，而不是末尾再附一段“学到的规则”；插件用 `replace` 提案保存。**discard** 用于重复、无增量或不可迁移的候选。手动 `append` 兼容模式仍存在，但自动在线同名合并采用整篇替换。

Store 把提案写到隔离状态目录。用户运行 `/skill-evolution read ID` 审核，再运行 `/skill-evolution apply ID project` 或 `... user`。应用时先保存旧版到 `history/*.jsonl`，递增 patch 版本，原子写入 `SKILL.md`，然后用 FoxCode 正常的 Skill loader 热刷新。过程不要求更改核心 Agent loader；若写入失败，应恢复旧版。也可以 `/skill-evolution discard ID 理由`。

## 6. 在线 eval 到底衡量什么

`/skill-evolution eval` 从本地 provenance 和 usage 组成 Skill lineage，按内容哈希去重形成 replay。sample ID 的前 8 位十六进制确定性地按 0.75 比例分成 `mutate_dev` 与 `promotion_test`；有至少两条时保证两边非空。规则可由程序或 LLM 二元 Judge 判分：普通通过 1 分，硬规则通过 2 分。失败规则产生启发式和 LLM 候选，先在 dev replay 选，再在 promotion replay 检查。

状态有 `unobserved`、`incubating`、`watch`、`healthy`、`pruned`。默认健康门槛包含至少 2 条 replay、至少 1 条 promotion 样本、5 次检索、规则通过率至少 0.8、相关率至少 0.35、使用率至少 0.2，且没有硬失败。只有健康候选相对已有 champion 平均分改善至少 0.01、硬失败不增加，才更新本地 champion 快照。**champion 不是自动覆盖用户 Skill 的指令。**

这里的“规则通过率”不是 API-Bank 正确率：规则可能只判断格式、步骤或行为一致性；历史 active 回复与新候选生成回复也不是完全对称 A/B。若想证明 coding 任务能力，必须另做带隐藏确认集的任务评分。实验实现就在 `fixtures`。

## 7. 真实中文 Skill 的前后对照

本仓库可直接查看[初始 Skill](fixtures/api_bank_eval/initial.md)与[进化 Skill](fixtures/api_bank_eval/evolved.md)。初始 0.1.0 只有几条总原则：选择下一条 API、参数来自 schema 和对话、不编造、按格式输出。进化 0.1.1 是一份完整重写的中文正文，将训练错误归为两部分：

- **依赖检查**：检查认证令牌等前置结果；未满足先调用依赖 API；已有结果不要重复获取。
- **参数规范**：核对字段名、参数来源、列表/对象类型、数值语义单位、原始文本保留；最后仍严格输出一条 API 请求。

这不是把训练题的标准答案粘贴进 Skill。候选来自训练轨迹，验证用于选择，最后确认集的任务和标签不参与修改。初始与进化 Skill 文件都随仓库保存，可逐字复核。

## 8. 实验怎么解释

正式结果：无 Skill **135/159**，初始 Skill **131/159**，进化 Skill **135/159**。三组合法格式均 159/159，因此只看完成率/格式率会误判。进化相对初始 +4 题、配对胜 5 负 1，95% bootstrap 区间约 [0, 5.66] 个百分点；但与无 Skill **完全持平**，且 token 为 126,205，对照初始 97,281。它说明维护器能纠正部分不利的初始说明，尚不能证明 Skill 对该数据集有净收益，也不能推广到代码修复。

另外，三个候选在 40 条验证题上都为 34/40；候选选择没有实质性证据指向某一版本更好。对于面试或技术汇报，应把这一负/有限结果作为方法边界说明，不能称“显著提升 coding 能力”。下一步若要证明净收益，应预先冻结更强无 Skill 基线、更多不重叠 coding 任务和不同随机种子，再在完全新测试集确认；不能继续用这 159 题调整 Skill 后重测并当作盲测。

## 9. 本地操作与排错

在受信任项目的会话中运行：

```text
/skill-evolution status
/skill-evolution list
/skill-evolution read <proposal-id>
/skill-evolution apply <proposal-id> project
/skill-evolution eval
/skill-evolution dir
```

若没有新候选，先看 `status` 的 `last_extraction_error`，再确认是否真的有下一轮用户反馈、模型认证可用、项目已受信任。若只有 retrieved 没有 used，检查最终回复是否执行了该 Skill 的独特方法；不能简单提高计数。若候选被拒，查看 `read ID` 中的理由，不要为通过过滤而保存密钥或任务答案。若想复核真实 benchmark，使用[实验页的 audit 命令](fixtures/README.md)；它不再调用模型。

状态文件分别记录待审 `proposals.json`、变更 `provenance.jsonl`、在线事件 `online_provenance.jsonl`、按 Skill 聚合的 `online_skill_provenance.json`、召回/使用 `skill_usage_stats.json`。这些记录可能包含脱敏后的会话摘要，也应按本地敏感数据管理。
