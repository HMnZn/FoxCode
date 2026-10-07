---
{
  "name": "依赖方向",
  "description": "上层包可以依赖内核，内核不能反向依赖",
  "type": "project",
  "topic": "project.dependencies",
  "status": "active",
  "pinned": false,
  "importance": 0.6,
  "confidence": 0.95,
  "createdAt": "2026-09-20T08:21:00+00:00",
  "updatedAt": "2026-09-20T08:21:00+00:00",
  "tags": [
    "依赖",
    "架构"
  ],
  "writeReason": "人工评估基准中的持久事实"
}
---
依赖方向固定为 fox_coding_agent -> fox_agent_core -> fox_ai，禁止底层导入产品层。
