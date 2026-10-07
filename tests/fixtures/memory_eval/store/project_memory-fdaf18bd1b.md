---
{
  "name": "缓存策略",
  "description": "缓存键带 schema 版本并设置 TTL",
  "type": "project",
  "topic": "project.cache",
  "status": "active",
  "pinned": false,
  "importance": 0.6,
  "confidence": 0.95,
  "createdAt": "2026-09-20T08:28:00+00:00",
  "updatedAt": "2026-09-20T08:28:00+00:00",
  "tags": [
    "redis",
    "缓存",
    "ttl"
  ],
  "writeReason": "人工评估基准中的持久事实"
}
---
Redis 缓存键格式为 fox:<schema-version>:<resource>，所有业务缓存必须设置 TTL。
