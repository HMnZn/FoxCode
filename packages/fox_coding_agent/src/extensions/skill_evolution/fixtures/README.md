# API-Bank 中文 Skill 自进化实验

这里是唯一保留的真实 coding 实验。任务来自 `data/API-Bank/test-data/level-1-api.json`：给出对话、接口说明与调用历史，模型生成**下一条** `API-Request: [ApiName(key='value')]`。它考察接口选择和参数生成，不等于仓库代码修复，也不是在线 replay 规则分。

## 冻结协议

- 数据以对话文件 `file` 为单位拆分，防止同一对话的不同轮次同时出现在训练和测试。确定性哈希划分：训练 80 条、验证 40 条；此前探索使用的 120 条单独隔离，最终确认集为其余 **159 条未见记录**。确认集不进入 Writer 输入，也不参与候选选择。
- 学生模型为 `deepseek/deepseek-flash`，Writer/Maintainer 为 `deepseek/deepseek-v4-pro`。学生每题每组一次逻辑调用，温度 0，API 错误调用可重试；成功响应按 phase/system/prompt 缓存，不重新抽样。三组在同一次实验中随机交错调度，提示主体和评分器相同，仅 Skill 文本不同。
- 先用初始 Skill 跑训练集，选至多 12 条训练轨迹供 Extractor 归纳一条通用候选；Maintainer 决定 add/merge/discard，并输出整篇合并 Skill。评估器还形成启发式和模型改写候选，只用 40 条验证集按完整请求 EM 选一个。该选择在打开最终确认集之前冻结。只有 `baseline`（无 Skill）、`initial`（初始中文 Skill）、`evolved`（所选完整中文 Skill）进入确认集三组对比。
- 评分先安全解析单行 API 表达式（AST，不执行模型文本），再依据题目 schema 对**预测与标签两侧**做相同的列表、字典、整数和浮点类型规范化。主指标为 API 名及完整参数字典严格相等；只输出了合法格式但参数错误不算通过。统计配对 wins/losses 和 2,000 次有固定随机种子的 bootstrap 区间。区间是描述性不确定性估计，不应过度解释为独立同分布任务总体的严格置信保证。
- Writer、验证和测试的原始请求/响应保存在 `api_bank_eval/calls.jsonl.gz`；这是**原样压缩**的调用记录，含内部历史提示，不对其内容做改写。可用 `gzip -cd` 查看。可复核结果在 `results.json`、验证记录在 `validation.json`，初始和最终 Skill 分别在 `initial.md`、`evolved.md`。压缩日志可能包含原始任务数据，不应直接公开发布。

## 真实结果

| 组别 | 完整请求 EM | 可解析 | 错误调用 | Tokens | 记录费用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 无 Skill | 135/159（84.91%） | 159/159 | 0 | 81,551 | $0.019119612 |
| 初始 Skill | 131/159（82.39%） | 159/159 | 0 | 97,281 | $0.019275240 |
| 自进化 Skill | 135/159（84.91%） | 159/159 | 0 | 126,205 | $0.019133952 |

进化版比初始版多做对 4 题，配对胜 5、负 1，准确率差 +2.52 个百分点；bootstrap 95% 区间为 [0, 5.66] 个百分点。**但进化版与无 Skill 持平，且 token 消耗明显更高。**验证集三个候选均为 34/40，最终按预定顺序选择 Maintainer 版本；验证没有区分候选的能力。当前证据只支持“进化修复了部分初始 Skill 的负面影响”，**不足以证明它优于无 Skill 或稳定提升 coding 能力**。因此实验只在隔离 Store 应用 Skill，没有自动发布到真实用户 Skill 目录。费用是提供商当次回传的记录值，不能按 token 数推定。

## 复核与复跑

从仓库根目录执行：

```bash
uv run python -m fox_coding_agent.src.extensions.skill_evolution.fixtures.experiment audit \
  --dataset api-bank-final \
  --run-dir packages/fox_coding_agent/src/extensions/skill_evolution/fixtures/api_bank_eval

# 新建独立目录才会真实调用模型、产生新费用；不覆盖已冻结结果。
uv run python -m fox_coding_agent.src.extensions.skill_evolution.fixtures.experiment run \
  --dataset api-bank-final --run-dir /tmp/foxcode-api-bank-new \
  --model deepseek/deepseek-flash --writer deepseek/deepseek-v4-pro
```

`audit` 不调用模型：检查数据哈希、三组样本完整性，逐条重算 EM，并将保存的预测与原始模型响应对照。复跑要求本地已有可用模型认证；由于服务端、模型版本和并发状态可能变化，新结果不保证与冻结结果逐字相同。实用设计与安全边界见[教学文档](../TUTORIAL.md)。
