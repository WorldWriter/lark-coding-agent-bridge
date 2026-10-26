# 小天才：企微 → Codex，Mac mini 部署

此版本复用企微长连接 channel 和 Codex CLI adapter。消息进入 bridge 后，Codex 在指定项目目录工作，结果回到企微。WorkBuddy 无需安装。

本地离线测试只能验证配置、权限路由和协议转换；BotID/Secret 认证、真实模型、群 @、文件回传和跨 10 分钟任务需要在目标机器验收。

## 1. 准备目标机器

- 安装 Node.js >= 20.12、pnpm 10.33.0 和 Codex CLI。在 Mac mini 的部署用户下完成 `codex login`，用 `codex login status` 检查；不要复制另一台电脑的登录文件。
- 企业微信创建「小天才」智能机器人，选择 API 模式、长连接。准备 BotID、Secret 和 owner 的企业微信 userid（不是姓名、手机号或飞书 open_id）。
- 将 bridge 源码包解压到长期保留的目录，例如 `$HOME/Applications/nexus-wecom-bridge`，不要从临时下载目录安装常驻服务。
- 将 `nexus_ai` 项目放到 Mac mini 的实际路径。bridge 独立仓不在主知识库 Git 中，不能只拉主仓就认为 bridge 也已经同步。

在 bridge 源码目录执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
node bin/lark-channel-bridge.mjs --version
codex --version
codex exec --help
```

Codex 需要支持 `exec --json`、`exec resume`、`--sandbox`、`--ignore-user-config`、`--ignore-rules`；开发机验证的版本是 0.145.0。模型沿用目标机器自己的 Codex 配置，不在 bridge 内固定。

## 2. 准备项目知识

| 依赖 | 在 Mac mini 上准备 |
|---|---|
| `AGENTS.md`、项目文档、代码 | 同步所需仓库，创建 profile 时指定真实项目路径 |
| 项目 skills | 检查 `.agents/skills` 的文件和符号链接；本机 ignored skills 不会随 Git 自动过去，绝对路径链接需要修复 |
| 知识库 SQLite | 使用 SQLite backup 生成一致快照后再迁移；不要在写入期间单独复制 `state.db` 而遗漏 WAL。默认目标为部署用户的 `~/.hermes/state.db` |
| 飞书工具 | 需要读写飞书时，在 Mac mini 独立配置并授权 `lark-cli`；企微 BotID 不是飞书 app，bridge 不会自动绑定它 |
| 后续知识同步 | 单独决定继续由原机更新还是迁移 dream。仅安装此 bridge 不会安装知识同步任务，也不会自动同步两台机器的数据库 |

`AGENTS.md` 是项目指令；Codex 的 `.rules` 是命令执行策略，两者不同。此版本新建企微 Codex profile 设置 `ignoreRules: false`，已有 profile 的显式设置不会自动改变。

## 3. 在 Mac mini 创建 profile

在 bridge 源码目录执行。把示例中的三个值换成实际值，Secret 不放命令行，按隐藏提示输入：

```sh
node bin/lark-channel-bridge.mjs profile create wecom-codex \
  --agent codex \
  --tenant wecom \
  --app-id 'YOUR_BOT_ID' \
  --owner 'YOUR_WECOM_USERID' \
  --workspace "$HOME/projects/nexus_ai"
```

这一步不会连接企微或运行模型。Codex 可执行文件和 workspace 路径在本机解析，Secret 存入本机加密存储。已有同名 profile 会拒绝覆盖，已有飞书 active profile 保持不变。

配置默认为 `~/.lark-channel/config.json` 下的 `profiles.wecom-codex`：

- `access.admins[0]` 是 owner，可私聊和群 @ 使用；其他用户需配置 `access.allowedUsers`，群需配置 `access.allowedChats`。不要混用飞书 ID。
- 权限沿用 bridge 默认值：owner 默认 full，其他人的执行权限默认上限 workspace。首轮只读验收可显式设置 `permissions.defaultAccess`、`maxAccess`、`guestMaxAccess` 均为 `read-only`；需要执行写任务时再按用途调整。
- 如果 CLI 默认模型被当前登录账号拒绝，可在此 profile 的 `codex.model` 填入该账号实测可用的模型。bridge 会对新会话和续聊传入 `--model`，不修改全局 Codex 配置；未设置时仍沿用 CLI 默认值。
- 当前 `codex exec` adapter 是非交互执行，固定 `approval_policy="never"`，不提供企微点击批准命令的闭环；不要把“批准”文字当成能解除沙箱限制的按钮。
- 旧版企微 profile 若没有 owner，启动会明确报错；补齐 `access.admins[0]` 后重启。若要保留执行策略，将旧 profile 的 `codex.ignoreRules` 显式设为 `false`。

## 企微在线文档工具（每台运行机器单独安装和授权）

消息长连接不包含在线文档读取能力。为 Codex 安装官方 CLI 和文档 skills：

```sh
npm install -g @wecom/cli
npx skills add WeComTeam/wecom-cli --skill wecomcli-shared wecomcli-doc-manage wecomcli-doc wecomcli-sheet wecomcli-smartsheet wecomcli-smartpage --agent codex -g -y
wecom-cli --version
wecom-cli auth show --status
# 仅未授权时，由 owner 在本机扫码：
wecom-cli auth init --noninteractive
```

CLI 版本至少 1.2.1。使用运行 bridge 的同一个 macOS 用户，确保 launchd 的 PATH 能找到 `wecom-cli`，skills 可被 Codex 读取。授权凭据默认由 CLI 加密保存在 `~/.config/wecom`，不要入库或放入源码包；Mac mini 上重新授权。

验收必须读取真实文档：对用户提供的在线表格先执行 `sheet workbook get`，再按返回的子表和范围执行 `sheet cells get`。只有返回真实单元格、确认范围和截断状态后才算通过。匿名网页可打开、CLI 显示 authorized，都不能代替文档权限验收。读取测试不修改表格及分享权限。

当前 CLI 身份属于运行 bridge 的本机账号，不能作为多用户权限隔离机制；此个人助手保持 owner 使用，不因安装文档工具而扩大聊天访问白名单。

## 4. 前台验收

确保旧机器没有运行同一 BotID，再执行：

```sh
node bin/lark-channel-bridge.mjs run --profile wecom-codex
```

| 检查 | 成功标准 |
|---|---|
| 企微认证 | 日志出现 authenticated，没有重复掉线或被另一连接踢下线 |
| owner 私聊 `/status` | 返回当前 agent 和会话状态 |
| 项目上下文 | 请它报告工作目录、读取项目 `AGENTS.md` 并说明小天才职责；内容来自实际文件 |
| 知识检索 | 请它通过 kb-search 查询一个已知项目事实，能给出真实来源；数据库缺失应明确报告 |
| 连续追问 | 第二轮沿用同一会话；`/new` 后是新会话 |
| 群 @ | owner 在目标群 @ 能得到回复；非白名单用户不会触发 Codex 执行 |
| 长任务 | 实际运行超过 10 分钟，检查最终结果是否完整返回；当前 stream rollover 不视为已通过真实平台验证 |
| 附件 | 私聊图片/文件单独验证；不要把普通机器人接入等同于获得全部群历史或办公数据权限 |

需要判断凭证或企微网络问题时，可使用源码中的 `tools/wecom-probe.mjs`；它会回声回复消息，必须使用测试机器人并先停止 bridge，避免同 BotID 争抢连接。

## 5. 常驻与迁机

前台按 Ctrl-C 停止后，在同一个源码目录、同一个 macOS 用户下执行：

```sh
node bin/lark-channel-bridge.mjs start --profile wecom-codex
node bin/lark-channel-bridge.mjs status --profile wecom-codex
```

`start` 在目标机生成 launchd 配置，记录本机 Node、bridge 入口和 PATH。它是用户 LaunchAgent，依赖用户登录；电脑要保持联网和唤醒。普通 shell 的临时环境变量不会全部自动传给 launchd，如需代理或自定义知识库路径，须在目标服务环境另行配置并验证。默认路径部署可避免依赖这些变量。

停止或移除自启动：

```sh
node bin/lark-channel-bridge.mjs stop --profile wecom-codex
node bin/lark-channel-bridge.mjs unregister --profile wecom-codex
```

迁机顺序：旧机 stop → 新机重新安装依赖和登录 Codex → 创建新 profile → 前台验收 → 新机 start。不要复制旧机 plist 或含旧绝对路径的 profile；不要同时运行同一个 BotID。回退时先停止新机，再启动旧机。

本说明采用新会话迁移，不承诺自动迁移旧机 Codex 历史或运行中的任务。源码包不包含 Bot Secret、Codex 登录、飞书授权、知识库或客户数据。
