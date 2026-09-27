---
{
  "name": "失败重试",
  "description": "网络瞬时错误最多重试两次",
  "type": "project",
  "topic": "project.retry",
  "status": "active",
  "pinned": false,
  "importance": 0.6,
  "confidence": 0.95,
  "createdAt": "2026-09-22T08:37:00+00:00",
  "updatedAt": "2026-09-22T08:37:00+00:00",
  "tags": [
    "重试",
    "backoff"
  ],
  "writeReason": "人工评估基准中的持久事实"
}
---
连接重置和 502/503 最多 retry 两次，退避为 0.2 秒和 0.8 秒；业务错误不重试。
