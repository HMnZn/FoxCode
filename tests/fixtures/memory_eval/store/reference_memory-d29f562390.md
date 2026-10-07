---
{
  "name": "故障手册",
  "description": "runbook-ops.md 记录线上故障处置顺序",
  "type": "reference",
  "topic": "reference.incident",
  "status": "active",
  "pinned": false,
  "importance": 0.6,
  "confidence": 0.95,
  "createdAt": "2026-09-25T08:33:00+00:00",
  "updatedAt": "2026-09-25T08:33:00+00:00",
  "tags": [
    "runbook",
    "故障",
    "日志"
  ],
  "writeReason": "人工评估基准中的持久事实"
}
---
先确认影响面并冻结发布，再采集指标和日志；恢复后补事故时间线，不直接清空数据。
