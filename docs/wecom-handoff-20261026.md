# 小天才企微 / Codex 迁机交接（2026-10-26）

## 本次部署

- 源码：https://github.com/WorldWriter/lark-coding-agent-bridge
- 部署分支：`codex/wecom-codex-macmini`。
- 文档接入实现提交：`0c004e2`；模型与 service secret 修复：`56f2ab4`。
- 当前 profile：`wecom-codex`；launchd label：`ai.lark-channel-bridge.bot.wecom-codex`。
- 当前机器继续运行，待 Mac mini 准备就绪后再切换。同一 BotID 不要同时启动两台 bridge。
- 部署步骤：[wecom-codex-macmini.md](wecom-codex-macmini.md)。不要沿用旧飞书/Claude 的 `ai.hermes.gateway` 启动方式。

## 已验证与未验证

| 项目 | 结果与边界 |
|---|---|
| 企微单聊 → Codex → 回复 | 用户已确认正确收到「小天才 Codex 已上线」 |
| Codex 模型 | 本机 `gpt-5.6-sol` 已实测；本机账号拒绝全局默认 `gpt-6.1-sol`，只在 bridge profile 设置 `codex.model`；目标机需单独验证 |
| 项目文件 | 本机 `AGENTS.md` 和 `nexus-小天才-PRD.md` 可读取；PRD 有历史 Claude runtime 描述，实际运行以本表及 profile 为准 |
| 知识库检索 | 实际 `.agents/skills/kb-search/scripts/kb_search.py` 查询「权限管理」返回 `success:true`、2 条带引用的历史记录；不把历史记录当当前决定 |
| 知识库文件 | `~/.hermes/state.db` 只读打开正常，当前约 87.1 MiB；迁移用 SQLite backup |
| 文档工具 | CLI 1.3.4；6 个官方文档 skills 已安装；后台服务 PATH 能找到 CLI |
| 文档授权 | 扫码成功，`auth show --status` 为 `authorized`；真实表格读取返回 `851008`，等待管理员审批「搜索与获取文档内容」；尚未读到表格单元格 |
| 自动检查 | 文档接入改动后 565 项测试通过，typecheck/build 通过 |
| 真实 Codex 工具调用 | 本轮 `gpt-5.6-sol` 只读执行成功：读取两份项目文件并引用原文，实际运行 KB 返回 2 条记录，检查 CLI 版本与授权；这是本机 Codex 验收，不代替企微端附件/群聊验收 |
| 尚需真人端验收 | 群 @、附件、超 10 分钟任务、Mac mini 实机，以及文档审批后的原表读取 |

本机版本参考：Node v23.11.0、pnpm 10.33.0、Codex CLI 0.145.0。目标机按部署指南的最低要求安装，并验证兼容性；不要硬编码旧 Homebrew Cellar 路径。

## Mac mini 按顺序操作

1. 拉主知识库 `nexus_ai`，准备所需项目文档；独立拉取 bridge：

   ```sh
   git clone --branch codex/wecom-codex-macmini https://github.com/WorldWriter/lark-coding-agent-bridge.git nexus-wecom-bridge
   cd nexus-wecom-bridge
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build
   ```

2. 使用部署用户登录 Codex，安装文档 CLI 和 skills，按部署指南创建 `wecom-codex` profile。BotID、Secret 和 owner userid 通过本地安全渠道提供，不把完整旧配置、登录 token、Keychain 或 `.env` 提交到 Git。工作目录换成 Mac mini 的真实 `nexus_ai` 路径。
3. 迁移本地项目 skills，并检查符号链接。当前 kb-search skill 文本仍引用不存在的 `.Codex/skills/...`；实际可用命令（在项目根目录执行）为：

   ```sh
   python3 .agents/skills/kb-search/scripts/kb_search.py '权限管理' --limit 2
   # 若未迁入 skill，项目自带的确定性检索入口：
   python3 scripts/search_knowledge.py '权限管理' --json --no-synthesis --no-llm-rewrite --limit 2
   ```

4. 在旧机对知识库做一致快照，通过私有传输渠道迁移。不要将知识库装入公开源码包：

   ```sh
   python3 - <<'PY'
   import os, sqlite3
   from pathlib import Path
   source = Path.home() / '.hermes/state.db'
   target = Path.home() / '.hermes/state.macmini.snapshot.db'
   fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
   os.close(fd)
   with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
       with sqlite3.connect(target) as dst:
           src.backup(dst)
   print(target)
   PY
   ```

   在目标机放到部署用户的 `~/.hermes/state.db` 前，先确认目标没有要保留的数据库。dream 同步任务本次不迁移：快照不会自动更新，应单独规划同步或迁移。
5. 在目标机先测试 Codex、本地文件、KB 和 CLI；此时不要启动同一 BotID 长连接。当前旧机 launchd 环境只有 PATH 和 LARK_CHANNEL_HOME，没有代理变量；目标机须有可用网络，不能假设旧机网络设置会自动迁移。
6. 切换时先在旧机执行 `node bin/lark-channel-bridge.mjs stop --profile wecom-codex`；目标机先前台 `run --profile wecom-codex`，私聊验收成功后停止前台，再 `start --profile wecom-codex` 常驻。
7. 回退时先停目标机，再启动旧机。切换确认前保留旧机配置和知识库。

## 可在企微私聊执行的测试

逐项发送，不要一次混测；附件需在单聊上传普通测试文件。

1. 「读取 AGENTS.md 和小天才 PRD，各引用一句原文，并说明你的工作目录。先不要修改文件。」
2. 「通过 kb-search 检索权限管理，列两条记录和来源日期，区分历史讨论和决定。不要修改文件。」
3. 紧接着问：「刚才两条记录分别是哪天的？」验证同一会话续聊。
4. 上传不含敏感数据的 TXT 或 CSV，让它报告实际行数和一条样本；这项须真实上传，不能用本地读取测试代替。
5. 文档审批通过后，再发送原企微表格链接，要求报告子表名称及表头；必须实际读到单元格才能验收。

源码 Git/archive 不包含本机登录、Bot Secret、SQLite 数据、个人文档、聊天日志或本地 ignored skills；这些不能靠拉取 bridge 自动恢复。
