---
{
  "name": "当前 API 前缀",
  "description": "当前服务接口统一使用 /api/v2",
  "type": "project",
  "topic": "project.api-prefix",
  "status": "active",
  "pinned": false,
  "importance": 0.9,
  "confidence": 0.95,
  "createdAt": "2026-09-22T08:16:00+00:00",
  "updatedAt": "2026-09-22T08:16:00+00:00",
  "tags": [
    "api",
    "endpoint",
    "v2"
  ],
  "writeReason": "人工评估基准中的持久事实",
  "supersedes": [
    "project_api-92e50d5ecd.md"
  ]
}
---
所有新 HTTP endpoint 使用 /api/v2；兼容层只负责把旧客户端重定向到 v2。
