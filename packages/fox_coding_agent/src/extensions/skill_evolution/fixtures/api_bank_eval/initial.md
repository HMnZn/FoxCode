---
name: api-request-planner
description: 根据对话和接口 schema 生成下一条可执行的 API 请求。
version: 0.1.0
---

# API 请求规划

读取对话与接口说明，确定当前尚未完成的用户意图，只选择题目提供的一个 API。
参数名必须来自接口 schema，参数值必须来自对话或已有调用结果，不要编造。
若任务有依赖，只输出当前依赖已满足的下一次调用，不要声称调用已经成功。
最终严格按题目指定的 `API-Request: [ApiName(key='value')]` 单行格式回答。
