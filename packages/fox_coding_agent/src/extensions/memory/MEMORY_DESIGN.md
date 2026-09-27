# FoxCode Memory v2 设计说明

## 1. 设计目标

Memory v2 将长期记忆拆成四层：

```text
受控写入 → 生命周期治理 → 三信号检索 → 预算化安全注入
```

目标不是堆叠尽可能多的 heuristic，而是保留少量、互相正交、可以单独解释和消融的能力。

## 2. 受控写入

- `filename` 由 `type + name` 决定，表示稳定物理身份；同名保存是原位更新。
- `topic` 表示事实槽；新值写入同 topic 后，旧值变为 `superseded`。
- `expiresAt` 管理临时事实，过期条目不会参与正常召回。
- `assess_write()` 在落盘前执行 schema、敏感信息、重复和冲突检查。
- `controlled_save()` 返回 `accepted/action/reasons/superseded`，使写入决策可观测。
- Markdown 是事实来源，`MEMORY.md` 是派生索引，写入使用临时文件和 `os.replace()`。

## 3. 检索只保留三个信号

### 3.1 Contextual BM25F

BM25F 同时处理字段权重、字段长度归一化、词频饱和和 IDF：

```text
name=3.0, description=1.8, tags=2.2, content=0.7
k1=1.2, b=0.65
```

对“那它呢”等指代查询，最近用户消息中的 term 以 `0.65` 权重加入同一 BM25F query。它不是独立 context boost，因此不会形成第四路分数。

### 3.2 Auditable Concept Graph

同义表达映射到稳定 concept ID：

```text
测试 / 单测 / pytest / test → testing
鉴权 / 认证 / auth         → authentication
重试 / retry / backoff     → retry
```

同一 concept 每条 query 最多计分一次，再使用 concept-level IDF：

```text
concept_score = 1.3 × log(1 + (N - concept_df + 0.5) / (concept_df + 0.5))
```

这避免通过增加 synonym alias 重复堆分，并让常见概念的权重自动下降。

### 3.3 Temporal Truth Arbitration

时间层先做真值裁决，再给有效候选很小的时间先验：

```text
过滤 expired
→ 过滤 superseded
→ 同 topic 选择最新 active 值
→ recency = 0.8 × exp(-age_days / 180)
```

过期和冲突属于 eligibility，不依赖排序分数碰运气。

### 3.4 总分与解释

```text
score = contextual_bm25f + concept_graph + temporal_truth
```

`ScoreBreakdown` 只有这三个字段。以下旧信号已删除：

- 独立 phrase bonus；
- 独立 context bonus；
- `importance × confidence` quality bonus；
- pinned ambient bonus。

阈值、top-score 60% 相对置信带和 topic diversification 只负责拒答与选择，不产生新的相关性分数。

`importance` 和 entry `confidence` 仍作为写入元数据保留，但不会把一条文本不相关的记忆推入检索结果。

## 4. Pinned 与检索解耦

稳定的 pinned user/feedback 是行为策略，不是查询相关证据。自动召回在注入层选择这些条目：

```text
score=0
matched_terms=("policy:pinned",)
```

因此它可以持续约束回复语言等行为，但不会污染 `memory_recall`、Null-FPR 或三信号分数。

## 5. 模型工具按意图收敛

模型不需要理解底层 CRUD，只保留三个用户意图：

```text
memory_remember  记住或更新
memory_recall    找到相关历史证据
memory_forget    按用户明确要求忘记
```

`memory_list` 和 `memory_read` 不再注册为模型工具。完整的 list/read/search/delete 仍保留在 `MemoryStore` 和 `/memory` 命令，供用户审计与运维。

`memory_recall` 不返回完整正文，而是在总字符预算内返回命中位置附近的 excerpt、filename、topic、score、confidence 和三信号 breakdown。工具结果标记 `trust=historical-data`、`instruction_priority=none`。

## 6. 预算化安全注入

- 严格保证 `used_chars <= max_chars`；
- 在命中 term 附近截取正文；
- 注入 filename、type、topic、score 和 confidence；
- 对历史正文做 XML/HTML 转义；
- 明确标记历史内容为 observation，而不是 instruction；
- 只修改本次模型请求副本，不写回 Session JSONL。

## 7. Benchmark

```text
fixtures/memory_eval/
├── store/              50 条 Markdown 记忆
├── queries.jsonl       120 条人工标注查询
├── write_cases.jsonl   12 条准入用例
├── manifest.json       3 组冲突和 10 条过期清单
└── results.json        可复现实验结果
```

查询构成：

```text
40 literal + 40 paraphrase + 20 referential + 20 none
```

先人工写记忆，再围绕记忆写查询和 `relevant_ids`。冲突查询只标当前值；无相关查询包含十条过期事实和十条语料外事实。固定评估时间避免 TTL 和时间先验随运行日期漂移。

## 8. 实验

```text
experiment                 R@5      P@5    Hit@1      MRR  Null-FPR    Stale
baseline                 0.720    0.162    0.030    0.248     1.000    0.114
no_conversation_context  0.660    0.500    0.600    0.628     0.200    0.000
no_concept_graph         0.600    0.600    0.600    0.600     0.100    0.000
no_temporal_truth        0.820    0.645    0.700    0.757     0.650    0.193
no_abstention            0.970    0.713    0.860    0.909     0.600    0.000
full                     0.850    0.659    0.790    0.818     0.200    0.000
```

完整方案相对旧 baseline：

- Recall@5：`0.720 → 0.850`，相对提升 18.1%；
- returned Precision：`0.162 → 0.659`；
- MRR：`0.248 → 0.818`，相对提升约 230%；
- Null-FPR：`1.000 → 0.200`，降低 80 个百分点；
- stale return rate：`0.114 → 0.000`。

三个核心消融分别验证 conversation context、concept graph 和 temporal truth。`no_abstention` 是阈值校准对照，不是第四个检索信号：它把 Recall 提高到 0.970，但使 Null-FPR 恶化到 0.600。

运行：

```powershell
uv run python -m fox_coding_agent.src.extensions.memory.eval
```

## 9. 结果边界

这是 50/120 小型人工 golden set，不是生产 A/B Test。它适合回归、消融和解释设计选择，但不能外推线上收益。后续应加入匿名真实失败查询、多人复标、multi-relevant 查询和最终回答 faithfulness 评估。

## 10. 简历表述

> 设计并实现 coding agent 的策略化长期记忆系统，引入 topic 级事实版本链、TTL/敏感信息准入，以及 Contextual BM25F、Auditable Concept Graph、Temporal Truth Arbitration 三信号检索和预算化安全注入；构建 50 条记忆、120 条人工查询的 golden set，使 Recall@5 从 0.72 提升至 0.85、MRR 从 0.248 提升至 0.818，无相关查询误召回率从 100% 降至 20%，过期/冲突返回率降至 0。
