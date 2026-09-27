---
{
  "name": "鉴权方式",
  "description": "服务端使用短期 access token 和轮换 refresh token",
  "type": "project",
  "topic": "project.auth",
  "status": "active",
  "pinned": false,
  "importance": 0.6,
  "confidence": 0.95,
  "createdAt": "2026-09-21T08:29:00+00:00",
  "updatedAt": "2026-09-21T08:29:00+00:00",
  "tags": [
    "auth",
    "鉴权",
    "token"
  ],
  "writeReason": "人工评估基准中的持久事实"
}
---
access token 有效期十五分钟；refresh token 单次轮换并在服务端保存撤销状态。
