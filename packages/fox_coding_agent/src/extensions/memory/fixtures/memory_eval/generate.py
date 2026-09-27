"""Rebuild the checked-in memory evaluation fixture deterministically.

The corpus is manually authored from plausible coding-agent facts. Generation
only handles filenames/frontmatter and expands the reviewed query templates;
it does not ask a model to invent labels.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STORE = ROOT / "store"


def record(kind, name, topic, description, content, literal, paraphrase, **extra):
    return {"type": kind, "name": name, "topic": topic, "description": description,
            "content": content, "literal": literal, "paraphrase": paraphrase, **extra}


RECORDS = [
    record("user", "回复语言", "user.response-language", "默认回复使用简体中文",
           "除非用户明确要求其他语言，否则解释和结论使用简体中文；代码标识符保持英文。",
           "默认回复使用什么语言？", "平时用哪种语言回答我？", pinned=True, importance=.95,
           tags=["中文", "回复", "language"]),
    record("user", "回答篇幅", "user.response-length", "偏好先结论后细节的简洁回答",
           "先给结论；简单问题控制在五个要点以内，复杂问题再展开必要证据。",
           "回答篇幅有什么偏好？", "回复需要多精炼？", pinned=True, importance=.85,
           tags=["简洁", "回复"]),
    record("user", "测试要求", "user.testing", "代码改动后需要运行相关测试",
           "完成代码修改后运行最相关的测试，并明确报告没有执行的验证。",
           "代码改动后的测试要求是什么？", "改完程序后要怎么验证？", importance=.8,
           tags=["测试", "pytest", "verification"]),
    record("user", "注释风格", "user.comments", "注释解释原因而非复述代码",
           "代码注释只解释不明显的原因、约束和取舍，不逐行翻译实现。",
           "代码注释应该写什么？", "备注应该讲实现还是讲原因？", tags=["注释", "style"]),
    record("user", "界面符号", "user.emoji", "产品文案避免使用 emoji",
           "CLI 和文档的正式输出不使用 emoji，除非示例本身需要。",
           "产品文案可以使用 emoji 吗？", "命令行输出能放表情符号吗？", tags=["cli", "文案"]),
    record("user", "风险说明", "user.risk-reporting", "高风险改动要说明回滚方法",
           "涉及数据迁移、鉴权或兼容性的改动，需要同时说明风险与回滚路径。",
           "高风险改动要补充什么？", "动到认证和迁移时还应交代哪些内容？", tags=["风险", "回滚"]),
    record("feedback", "保持公共 API", "feedback.public-api", "未授权时不要破坏公共接口",
           "修复内部实现时保持已有公共 API；确需破坏性变化时先指出迁移影响。",
           "修复时如何处理公共 API？", "内部重构能直接改对外接口吗？", importance=.85,
           tags=["api", "兼容性"]),
    record("feedback", "先跑定向测试", "feedback.targeted-tests", "先执行覆盖改动的最小测试集",
           "验证时先跑目标测试文件，失败时再扩大到整个测试套件。",
           "测试应该先跑哪个范围？", "验证代码时先全量还是先单测？", tags=["测试", "pytest"]),
    record("feedback", "保留工作区修改", "feedback.preserve-changes", "不要覆盖用户已有修改",
           "工作区可能包含用户未提交的更改；编辑重叠文件前先检查差异并保留无关改动。",
           "如何处理工作区已有修改？", "看到未提交改动时应该怎么办？", importance=.9,
           tags=["git", "工作区"]),
    record("feedback", "引用精确位置", "feedback.file-links", "交付时引用可点击文件位置",
           "说明实现结果时给出具体文件和起始行，避免只写模糊目录。",
           "交付说明如何引用代码？", "汇报修改时怎样让文件位置可定位？", tags=["文档", "引用"]),
    record("feedback", "小步补丁", "feedback.small-patches", "优先采用局部且可审查的补丁",
           "修改代码优先使用边界清晰的小补丁，避免无关的整文件格式化。",
           "代码补丁的范围要求是什么？", "改文件时应该大面积重排吗？", tags=["patch", "review"]),
    record("feedback", "只在阻塞时提问", "feedback.questions", "可合理推断时直接推进",
           "只有缺少会实质改变结果的信息时才暂停提问；其余情况记录假设后继续。",
           "什么时候需要向用户提问？", "信息不全时都要停下来确认吗？", tags=["workflow", "假设"]),
    record("project", "旧 Python 包管理", "project.package-manager", "十天前使用 pip 安装依赖",
           "旧流程：python -m pip install -r requirements.txt。该流程已被替换。",
           "项目以前如何安装依赖？", "旧的包管理流程是什么？", status="superseded",
           updated="2026-09-17T08:00:00+00:00", tags=["pip", "依赖"]),
    record("project", "当前 Python 包管理", "project.package-manager", "项目统一使用 uv 管理依赖",
           "当前流程：uv sync 安装锁定依赖；运行命令使用 uv run，不维护 requirements.txt。",
           "项目现在如何安装依赖？", "当前使用哪个包管理工具？", importance=.9,
           supersedes_topic=True, tags=["uv", "依赖", "package"]),
    record("project", "旧 API 前缀", "project.api-prefix", "十天前服务接口位于 /api/v1",
           "旧约定：HTTP 接口统一挂载在 /api/v1；该前缀已下线。",
           "旧版 API 前缀是什么？", "以前的接口路径从哪里开始？", status="superseded",
           updated="2026-09-17T09:00:00+00:00", tags=["api", "v1"]),
    record("project", "当前 API 前缀", "project.api-prefix", "当前服务接口统一使用 /api/v2",
           "所有新 HTTP endpoint 使用 /api/v2；兼容层只负责把旧客户端重定向到 v2。",
           "当前 API 前缀是什么？", "现在接口端点的统一路径是哪一个？", importance=.9,
           supersedes_topic=True, tags=["api", "endpoint", "v2"]),
    record("project", "旧测试目录", "project.test-location", "十天前测试位于 src/tests",
           "旧布局把测试放在 src/tests；迁移完成后不要继续在这里新增文件。",
           "旧测试目录在哪里？", "以前单测放在哪个文件夹？", status="superseded",
           updated="2026-09-17T10:00:00+00:00", tags=["测试", "目录"]),
    record("project", "当前测试目录", "project.test-location", "当前测试统一放在仓库根目录 tests",
           "新增 pytest 用例放在根目录 tests/，并按被测模块命名为 test_<module>.py。",
           "当前测试目录在哪里？", "现在自动化测试应该放到哪个路径？", importance=.85,
           supersedes_topic=True, tags=["pytest", "测试", "目录"]),
    record("project", "分层架构", "project.architecture", "代码分为 AI、agent core 与 coding agent 三层",
           "fox_ai 负责模型协议，fox_agent_core 负责循环与会话，fox_coding_agent 负责产品运行时和扩展。",
           "项目分层架构是什么？", "模型协议、代理循环和产品运行时分别在哪层？", importance=.8,
           tags=["架构", "module"]),
    record("project", "CLI 启动命令", "project.cli", "开发环境通过 uv run fox 启动 CLI",
           "交互模式使用 uv run fox --trust-project --interactive；记忆扩展由 settings.json 的 memory 字段启用。",
           "CLI 的启动命令是什么？", "怎样 launch 交互式命令行？", tags=["cli", "启动", "uv"]),
    record("project", "依赖方向", "project.dependencies", "上层包可以依赖内核，内核不能反向依赖",
           "依赖方向固定为 fox_coding_agent -> fox_agent_core -> fox_ai，禁止底层导入产品层。",
           "包之间的依赖方向是什么？", "哪个模块不能反向 import 产品代码？", tags=["依赖", "架构"]),
    record("project", "会话格式", "project.session-format", "会话以 JSONL 追加写入",
           "每个 session 使用追加式 JSONL 保存消息树；上下文召回副本不能写回原始 transcript。",
           "会话使用什么格式保存？", "对话记录怎样持久化？", tags=["jsonl", "session"]),
    record("project", "项目可信边界", "project.trust", "未信任项目不能执行工具或读取记忆",
           "只有 --trust-project 或已记录为可信的目录才能加载项目资源、执行工具和召回 memory。",
           "未信任项目有哪些限制？", "项目何时可以执行工具并读取长期记忆？", importance=.9,
           tags=["trust", "安全"]),
    record("project", "Python 版本", "project.python-version", "项目要求 Python 3.14 或更高",
           "pyproject.toml 的 requires-python 为 >=3.14，代码可以使用对应标准库和语法。",
           "项目要求哪个 Python 版本？", "运行环境最低需要什么 Python？", tags=["python", "3.14"]),
    record("project", "格式化工具", "project.formatter", "Python 代码使用 ruff format",
           "格式化执行 uv run ruff format；只格式化本次改动覆盖的文件。",
           "项目使用什么格式化工具？", "Python 文件怎么统一格式？", tags=["ruff", "格式化"]),
    record("project", "发布分支", "project.release-branch", "稳定版本从 release 分支发布",
           "日常开发合并到 main；准备版本时从 main 创建 release 分支并生成变更记录。",
           "稳定版本从哪个分支发布？", "release 流程使用哪条 git branch？", tags=["git", "分支", "发布"]),
    record("project", "本地数据库", "project.database", "本地开发使用 SQLite",
           "开发与单元测试默认使用 SQLite 文件；生产适配器使用 PostgreSQL。",
           "本地开发使用什么数据库？", "开发环境的 DB 是哪一种？", tags=["sqlite", "数据库"]),
    record("project", "缓存策略", "project.cache", "缓存键带 schema 版本并设置 TTL",
           "Redis 缓存键格式为 fox:<schema-version>:<resource>，所有业务缓存必须设置 TTL。",
           "缓存键和过期策略是什么？", "Redis 数据如何命名并控制失效？", tags=["redis", "缓存", "ttl"]),
    record("project", "鉴权方式", "project.auth", "服务端使用短期 access token 和轮换 refresh token",
           "access token 有效期十五分钟；refresh token 单次轮换并在服务端保存撤销状态。",
           "项目采用什么鉴权方式？", "认证令牌如何过期和轮换？", tags=["auth", "鉴权", "token"]),
    record("reference", "重试规范", "reference.retry-rfc", "内部 RFC-07 定义幂等重试规则",
           "RFC-07：只对幂等操作自动重试，使用带抖动的指数退避，并记录最终失败。",
           "哪份规范定义重试规则？", "自动 retry 应遵循哪个文档？", tags=["rfc-07", "重试", "backoff"]),
    record("reference", "Pydantic 文档", "reference.pydantic", "模型校验参考 Pydantic 官方文档",
           "涉及 model_validate、field_validator 和 JSON schema 时以 docs.pydantic.dev 最新稳定版为准。",
           "Pydantic 校验参考哪个文档？", "数据模型 validation 去哪里查？", tags=["pydantic", "文档"]),
    record("reference", "Python 文档", "reference.python", "并发取消语义参考 Python 官方 asyncio 文档",
           "asyncio.TaskGroup、CancelledError 和 timeout 的行为以 docs.python.org/3/library/asyncio 为准。",
           "asyncio 行为参考哪里？", "异步取消和超时应该查哪份说明？", tags=["python", "asyncio", "文档"]),
    record("reference", "故障手册", "reference.incident", "runbook-ops.md 记录线上故障处置顺序",
           "先确认影响面并冻结发布，再采集指标和日志；恢复后补事故时间线，不直接清空数据。",
           "线上故障按哪份手册处理？", "服务异常时第一步该做什么？", tags=["runbook", "故障", "日志"]),
    record("reference", "API Schema", "reference.openapi", "接口契约来源是 api/openapi.yaml",
           "请求字段、响应状态码和兼容性检查以 api/openapi.yaml 为唯一契约来源。",
           "接口契约文件在哪里？", "endpoint 的字段定义以什么为准？", tags=["api", "openapi", "schema"]),
    record("reference", "Memory 设计文档", "reference.memory-design", "记忆设计决策记录在 MEMORY_DESIGN.md",
           "文档解释准入、冲突、混合检索、注入预算和离线评估的设计原因。",
           "记忆系统设计文档叫什么？", "哪里说明长期记忆的检索和注入方案？", tags=["memory", "文档", "设计"]),
    record("project", "HTTP 超时", "project.http-timeout", "外部 HTTP 请求默认十秒超时",
           "连接超时三秒，总超时十秒；流式接口必须使用单独的 idle timeout。",
           "外部 HTTP 请求超时是多少？", "调用第三方接口的 deadline 如何设置？", tags=["http", "超时"]),
    record("project", "失败重试", "project.retry", "网络瞬时错误最多重试两次",
           "连接重置和 502/503 最多 retry 两次，退避为 0.2 秒和 0.8 秒；业务错误不重试。",
           "网络错误最多重试几次？", "短暂 failure 的 backoff 策略是什么？", tags=["重试", "backoff"]),
    record("user", "时区", "user.timezone", "日期和计划默认使用 Asia/Shanghai",
           "没有显式时区时，把日期、日程和日志解释为 Asia/Shanghai。",
           "默认时区是什么？", "未标注 timezone 的时间按哪里理解？", tags=["timezone", "日期"]),
    record("user", "类型标注", "user.typing", "新增 Python 公共函数需要类型标注",
           "新增或修改的公共 Python API 写完整参数和返回类型，局部显然变量无需冗余标注。",
           "公共 Python 函数需要类型标注吗？", "新增方法的 typing 要做到什么程度？", tags=["python", "typing"]),
    record("feedback", "错误消息", "feedback.errors", "错误信息要包含动作和可恢复建议",
           "异常文本说明什么操作失败、关键对象是什么，并在可恢复时给出下一步。",
           "错误消息应该包含哪些信息？", "exception 文案怎样才可操作？", tags=["错误", "exception"]),
    # Ten deliberately obsolete memories: exact-match null queries test lifecycle filtering.
    record("project", "旧 staging 地址", "obsolete.staging", "已停用的 staging 域名",
           "staging 曾使用 https://staging-old.example.test，现已停用。", "", "",
           status="expired", expires="2026-08-01T00:00:00+00:00", tags=["staging"]),
    record("project", "旧部署脚本", "obsolete.deploy", "已删除的 deploy.sh 流程",
           "旧发布命令为 bash scripts/deploy.sh production。", "", "", status="expired",
           expires="2026-08-02T00:00:00+00:00", tags=["部署"]),
    record("reference", "旧监控面板", "obsolete.dashboard", "迁移前的 Grafana 面板",
           "旧面板编号 Grafana 42，只覆盖单实例指标。", "", "", status="expired",
           expires="2026-08-03T00:00:00+00:00", tags=["grafana"]),
    record("feedback", "临时禁用类型检查", "obsolete.typecheck", "一次性迁移期间的临时规则",
           "迁移周内可以跳过 mypy，该豁免已经结束。", "", "", status="expired",
           expires="2026-08-04T00:00:00+00:00", tags=["mypy"]),
    record("user", "临时英文演示", "obsolete.demo-language", "演示当天使用英文",
           "九月一日客户演示期间只用英文回复。", "", "", status="expired",
           expires="2026-09-02T00:00:00+00:00", tags=["英文", "演示"]),
    record("project", "旧端口", "obsolete.port", "旧开发服务器端口 8080",
           "迁移前本地服务监听 127.0.0.1:8080。", "", "", status="expired",
           expires="2026-08-06T00:00:00+00:00", tags=["port"]),
    record("reference", "旧需求单", "obsolete.ticket", "已经完成并关闭的迁移需求",
           "Linear ENG-118 要求迁移 session schema，目前已经验收关闭。", "", "",
           status="expired", expires="2026-08-07T00:00:00+00:00", tags=["eng-118"]),
    record("project", "旧 feature flag", "obsolete.flag", "已经删除的 beta_ui 开关",
           "曾通过 beta_ui=true 启用新版界面，该开关已经移除。", "", "", status="expired",
           expires="2026-08-08T00:00:00+00:00", tags=["feature flag"]),
    record("feedback", "临时跳过集成测试", "obsolete.integration-tests", "故障窗口临时跳过集成测试",
           "CI 故障时曾允许 skip integration，修复后不再适用。", "", "", status="expired",
           expires="2026-08-09T00:00:00+00:00", tags=["ci", "测试"]),
    record("reference", "旧值班电话", "obsolete.oncall", "已经失效的值班联系方式",
           "旧值班分机为 7712，该号码已停用。", "", "", status="expired",
           expires="2026-08-10T00:00:00+00:00", tags=["oncall"]),
]


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")[:40] or "memory"


def filename(item):
    digest = hashlib.sha256(
        f"{item['type']}\0{item['name'].strip().casefold()}".encode()
    ).hexdigest()[:10]
    return f"{item['type']}_{slug(item['name'])}-{digest}.md"


def write_jsonl(path, values):
    path.write_text("".join(json.dumps(value, ensure_ascii=False) + "\n" for value in values), encoding="utf-8")


def main():
    STORE.mkdir(parents=True, exist_ok=True)
    for path in STORE.glob("*.md"):
        path.unlink()
    filenames = [filename(item) for item in RECORDS]
    topic_files = {}
    for item, name in zip(RECORDS, filenames):
        topic_files.setdefault(item["topic"], []).append(name)
    for index, (item, name) in enumerate(zip(RECORDS, filenames), 1):
        updated = item.get("updated", f"2026-09-{20 + index % 7:02d}T08:{index:02d}:00+00:00")
        metadata = {
            "name": item["name"], "description": item["description"], "type": item["type"],
            "topic": item["topic"], "status": item.get("status", "active"),
            "pinned": item.get("pinned", False), "importance": item.get("importance", .6),
            "confidence": item.get("confidence", .95), "createdAt": updated, "updatedAt": updated,
            "tags": item.get("tags", []), "writeReason": "人工评估基准中的持久事实",
        }
        if item.get("expires"):
            metadata["expiresAt"] = item["expires"]
        if item.get("supersedes_topic"):
            metadata["supersedes"] = topic_files[item["topic"]][:-1]
        frontmatter = json.dumps(metadata, ensure_ascii=False, indent=2)
        (STORE / name).write_text(f"---\n{frontmatter}\n---\n{item['content']}\n", encoding="utf-8")

    active = RECORDS[:40]
    queries = []
    for index, item in enumerate(active, 1):
        relevant = filename(item)
        # Conflict old values are never golden; both old-query forms point to current truth.
        same_topic = [candidate for candidate in active if candidate["topic"] == item["topic"]]
        if item.get("status") == "superseded":
            relevant = filename(next(candidate for candidate in same_topic
                                     if candidate.get("status", "active") == "active"))
        queries.append({"id": f"literal-{index:03d}", "kind": "literal", "query": item["literal"],
                        "relevant_ids": [relevant]})
        queries.append({"id": f"paraphrase-{index:03d}", "kind": "paraphrase", "query": item["paraphrase"],
                        "relevant_ids": [relevant]})
    referential_indexes = [0, 1, 2, 6, 8, 13, 15, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 35, 36]
    references = []
    prompts = ["那它呢？", "这个呢？", "那项约定是什么？", "它具体怎么做？"]
    for number, record_index in enumerate(referential_indexes, 1):
        item = active[record_index]
        references.append({
            "id": f"referential-{number:03d}", "kind": "referential",
            "context": item["literal"], "query": prompts[(number - 1) % len(prompts)],
            "relevant_ids": [filename(item)],
        })
    null_queries = [
        "旧 staging 域名是什么？", "旧 deploy.sh 怎么发布 production？", "Grafana 42 面板看什么？",
        "现在还可以跳过 mypy 吗？", "客户演示期间只用英文吗？", "本地服务还是 8080 端口吗？",
        "ENG-118 需求是什么？", "beta_ui feature flag 怎么开？", "CI 还能 skip integration 吗？",
        "旧值班分机号码是多少？", "项目的 Kubernetes namespace 是什么？", "前端使用 React 还是 Vue？",
        "谁负责审批数据库访问？", "生产环境有多少台服务器？", "设计稿的 Figma 链接在哪里？",
        "移动端最低支持哪个 iOS 版本？", "公司报销上限是多少？", "邮件通知使用哪个 SMTP？",
        "对象存储 bucket 名称是什么？", "每周例会在哪个会议室？",
    ]
    nulls = [{"id": f"none-{index:03d}", "kind": "none", "query": query, "relevant_ids": []}
             for index, query in enumerate(null_queries, 1)]
    ordered = [query for kind in ("literal", "paraphrase") for query in queries if query["kind"] == kind]
    ordered.extend(references)
    ordered.extend(nulls)
    assert len(RECORDS) == 50
    assert {kind: sum(query["kind"] == kind for query in ordered) for kind in
            ("literal", "paraphrase", "referential", "none")} == {
                "literal": 40, "paraphrase": 40, "referential": 20, "none": 20,
            }
    write_jsonl(ROOT / "queries.jsonl", ordered)
    write_jsonl(ROOT / "write_cases.jsonl", [
        {"id": "accept-project", "accepted": True, "name": "队列并发数", "description": "worker 并发配置",
         "type": "project", "content": "worker 并发数固定为 4。", "topic": "project.worker-count"},
        {"id": "accept-user", "accepted": True, "name": "输出格式", "description": "用户格式偏好",
         "type": "user", "content": "表格超过六列时改用分组列表。"},
        {"id": "accept-reference", "accepted": True, "name": "规范位置", "description": "公开文档地址",
         "type": "reference", "content": "公开规范位于 docs.example.test/rfc/12。"},
        {"id": "accept-env-name", "accepted": True, "name": "环境变量名", "description": "只保存变量名",
         "type": "project", "content": "认证从 FOX_API_KEY 环境变量读取，不保存变量值。"},
        {"id": "accept-placeholder", "accepted": True, "name": "配置示例", "description": "无真实凭据",
         "type": "reference", "content": "示例写作 api_key=<从环境变量读取>。"},
        {"id": "accept-expiring", "accepted": True, "name": "冻结窗口", "description": "有明确期限的事实",
         "type": "project", "content": "发布冻结持续到十月一日。", "expires_at": "2026-10-01T00:00:00+08:00"},
        {"id": "reject-openai-key", "accepted": False, "name": "服务密钥", "description": "不应保存",
         "type": "reference", "content": "api_key=sk-1234567890abcdefghijklmnop"},
        {"id": "reject-private-key", "accepted": False, "name": "SSH 私钥", "description": "不应保存",
         "type": "reference", "content": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc"},
        {"id": "reject-github-token", "accepted": False, "name": "GitHub token", "description": "不应保存",
         "type": "reference", "content": "ghp_1234567890abcdefghijklmnopqrstuv"},
        {"id": "reject-aws-key", "accepted": False, "name": "AWS key", "description": "不应保存",
         "type": "reference", "content": "AKIA1234567890ABCDEF"},
        {"id": "reject-password", "accepted": False, "name": "数据库密码", "description": "不应保存",
         "type": "reference", "content": "password=correct-horse-battery-staple"},
        {"id": "reject-generic-secret", "accepted": False, "name": "webhook secret", "description": "不应保存",
         "type": "reference", "content": "secret: abcdefghijklmnopqrstuvwxyz"},
    ])
    (ROOT / "manifest.json").write_text(json.dumps({
        "records": 50, "queries": 120,
        "superseded_ids": [filenames[index] for index in (12, 14, 16)],
        "expired_ids": filenames[40:],
        "generated_by": "generate.py (manually reviewed source records and query templates)",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
