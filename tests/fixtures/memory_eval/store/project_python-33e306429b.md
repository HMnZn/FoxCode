---
{
  "name": "当前 Python 包管理",
  "description": "项目统一使用 uv 管理依赖",
  "type": "project",
  "topic": "project.package-manager",
  "status": "active",
  "pinned": false,
  "importance": 0.9,
  "confidence": 0.95,
  "createdAt": "2026-09-20T08:14:00+00:00",
  "updatedAt": "2026-09-20T08:14:00+00:00",
  "tags": [
    "uv",
    "依赖",
    "package"
  ],
  "writeReason": "人工评估基准中的持久事实",
  "supersedes": [
    "project_python-48af465261.md"
  ]
}
---
当前流程：uv sync 安装锁定依赖；运行命令使用 uv run，不维护 requirements.txt。
