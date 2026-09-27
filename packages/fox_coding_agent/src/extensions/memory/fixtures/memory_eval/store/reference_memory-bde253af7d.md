---
{
  "name": "重试规范",
  "description": "内部 RFC-07 定义幂等重试规则",
  "type": "reference",
  "topic": "reference.retry-rfc",
  "status": "active",
  "pinned": false,
  "importance": 0.6,
  "confidence": 0.95,
  "createdAt": "2026-09-22T08:30:00+00:00",
  "updatedAt": "2026-09-22T08:30:00+00:00",
  "tags": [
    "rfc-07",
    "重试",
    "backoff"
  ],
  "writeReason": "人工评估基准中的持久事实"
}
---
RFC-07：只对幂等操作自动重试，使用带抖动的指数退避，并记录最终失败。
