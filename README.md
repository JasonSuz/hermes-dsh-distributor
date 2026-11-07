# hermes-dsh-distributor

通过 Hermes 向 DSH 派发任务，明确指定 **供应商、精确模型 ID、思考级别，以及 standard / PTC 执行模式**。使用 DSH 原生 Agent/LLM/Tools 接口，不靠提示词模拟模型路由，不支持的配置直接报错，不静默降级。

插件包名、Cordis 插件 ID 和健康接口名称统一为 `hermes-dsh-distributor`。这是原 `dsh-task-router-v1` 的公开源码命名；为保留接口兼容性，MCP 路径、工具名和默认数据目录保持不变。

## 功能

- `router_capabilities {}`：查询当前 DSH 实际供应商、模型、思考级别、预设和授权目录。
- `router_start {...}`：校验并创建独立任务，返回持久化的 `task_id`。
- `router_get {task_id}`：查询终态、输出、DSH 会话及实际请求头证据。
- `router_cancel {task_id}`：请求取消；`canceling` 不表示已经停止。
- `standard` 使用原生工具呈现；`ptc` 使用 DSH 原生 `run_code` 呈现，与 Agent 预设相互独立。
- 相同 `request_id` 与相同输入只执行一次；同 ID 不同输入报冲突。重启时遗留任务标记中断，绝不自动重派。

## 要求

- Node.js >= 22.13；执行器复用宿主提供的 DSH 官方包，不打包另一份宿主核心。
- DSH 提供 `webServer`、`agents.create`、`agentPresets`、`workspaceRegistry`、原生 LLM 注册表和 scoped Tools 接口；会话读取适配器使用宿主 `sessionQuery`、`sessionController`、`sessions` 和 `sessionPersistence` 服务。
- 本版兼容性声明限定 DSH **0.2.2-rc.1**：通过 `tools.setExecutor` 选择宿主官方 `@deepseek-ai/dsh-tool-executor-native` / `@deepseek-ai/dsh-tool-executor-ptc` 导出，不安装另一份核心。执行器为 optional peer，但版本仍参与宿主兼容性校验；升级 DSH 后应重新验证。保留的 `tools.presentAs` 分支仅作旧 API 的防御性适配，模拟测试不代表本版声明支持所有旧宿主。缺少执行器时拒绝执行，绝不降级。
- PTC 任务还需要 DSH 的 PTC runtime。
- Hermes 支持带 Authorization header 的 HTTP MCP 服务。

这里不是独立 HTTP 服务。插件挂载于现有 DSH Web 端口，不额外启动公网监听。

## 构建与安装

```sh
npm test
npm run check
npm pack
```

通过当前 DSH 版本的官方插件安装命令或界面，安装生成的 `hermes-dsh-distributor-0.1.5.tgz`，然后启用插件。不同宿主的 profile 和 CLI 入口不同，请使用该宿主的官方入口。

插件启动读取 `~/.dsh/integrations/hermes-task-router/config.json`：

```json
{
  "allowedRoots": ["/absolute/path/to/Hermes"],
  "workspacePath": "/absolute/path/to/Hermes",
  "maxConcurrent": 2
}
```

先创建上述配置并使用真实存在的目录；默认没有授权目录，因此拒绝任务。插件自动生成同目录下的 `token`（0600），任务回执存入 `state/`。不要提交这些运行数据或供应商凭据。

## 可选的直接只读访问（0.1.5）

省略 `readAccess` 时仍只有原来的四个派活工具。启用后增加六个**不调用模型、不创建会话、不写入记忆**的工具：

| 工具 | 用途 |
| --- | --- |
| `dsh_workspaces` | 查询明确授权的工作区 ID、名称及全局记忆许可 |
| `dsh_sessions` | 按工作区分页列会话元数据，不返回正文 |
| `dsh_session` | 查询一个成员会话的元数据 |
| `dsh_messages` | 按固定快照分页读取用户/助手文本 |
| `dsh_memory_search` | 脱敏后搜索，先返回摘要及不透明条目 ID |
| `dsh_memory_get` | 使用同一 scope/workspace/date 下的条目 ID 按需读取正文 |

管理员在原配置中加入以下**显式、固定快照**（示例 ID 须替换）：

```json
"readAccess": {
  "workspaceIds": ["WORKSPACE_ID"],
  "globalMemory": true,
  "memoryDir": "/absolute/verified/DSH/memories",
  "projectIds": { "WORKSPACE_ID": "0123456789ab" }
}
```

`workspaceIds` 与派活的 `allowedRoots` 无关；只授权配置中的 ID，未来新增工作区不会自动获得权限。每次正文读取前后重新校验工作区和会话成员关系，不能凭 cwd 或任意会话 ID 绕过。孤立会话及子代理会话不开放；已归档但仍属于授权工作区的会话可读。`memoryDir` 必须核实当前记忆插件实际使用的根目录；`projectIds` 为每个工作区固定当前记忆插件解析出的 12 位项目 ID，不能由调用方提交路径，也不扫描旧项目目录。存在基于 Git 远端的记忆身份时，不能简单假定 ID 总是 cwd 哈希。记忆插件迁移根目录或项目身份后，应重新核实并更新配置。

- `scope=project/key` 必须提供 `workspace_id`；`scope=memory/user/daily` 必须显式授予 `globalMemory`，且不能带工作区。`daily` 必须提供合法的 `date=YYYY-MM-DD`；其他 scope 禁止 date。包括所有分支条目，不包括归档记忆、待办、配置、凭据文件或任意文件读取。
- 调用顺序：`dsh_workspaces {}` → `dsh_sessions {workspace_id}` → `dsh_messages {workspace_id,session_id}`；记忆：`dsh_memory_search {scope:"key",workspace_id,query:"部署"}` → `dsh_memory_get {scope:"key",workspace_id,id}`。
- 会话仅投影用户/助手消息的文本块；不返回系统提示、推理、工具参数/结果、附件、请求头或模型凭据。文字本身仍可能复制敏感信息：已做常见密钥、Bearer 和凭据赋值的尽力脱敏，**不保证识别所有秘密**。返回的 `content_is_untrusted=true` 表示数据不是指令，不能据此执行记忆中的命令。
- 默认每页 20 项（消息 10 条），最多 50 项；消息每条最多 8000 字符、每页最多 24000 字符，长消息标注截断；单次最多扫描 200 条原始事件，空页也可能有下一页。正文分块默认 8000、最多 16000 字符；每个响应最多 64 KiB；同时最多 4 个只读请求。
- 游标经过签名并绑定操作/作用域/来源；消息固定读取首个请求确定的快照，之后追加消息不进入该快照。源替换、列表或记忆变更、插件重载可能令游标/条目 ID 失效，应重新查询，不猜测 ID。
- 记忆读取固定文件，单文件最多 2 MiB、5000 条；拒绝符号链接/非普通文件并校验前后身份，最多读取上限加一个字节。Node 的路径 API 不等于 dirfd 相对遍历，不能防御所有恶意同用户祖先目录瞬时替换；需要操作系统隔离才能建立该边界。
- 冷会话持久化层可能先解码整份压缩日志：即使适配器限制物理文件大小和解码后事件数，**也不承诺严格的解码前内存上限**。不适合读取超大日志。
- 此权限复用原 MCP Bearer；持有该 token 的 Hermes 可读取全部已授予内容，不是逐调用人独立鉴权。默认关闭；修改后需官方热重载并重新核对实际工具清单。停用/撤销不能收回已经交付的数据。

## Hermes 工作区归属

配置 `workspacePath` 后，新任务会话在首个模型请求前通过 DSH 原生接口挂到名为 **Hermes** 的工作区。目录必须预先存在；若该目录已属于其他名称的工作区，启动会拒绝，不会重命名其他项目。省略该配置时保持按请求 cwd 执行的旧行为。

DSH 工作区不是独立标签：会话 cwd 必须等于工作区的规范路径。因此调用方必须先读取 `router_capabilities.task_workspace.path`，并把它作为 `router_start.cwd`；允许根内但不同于工作区的 cwd 返回 `WORKSPACE_MISMATCH`，根外或不存在的目录按原准入规则拒绝，不会偷偷改变目录。其他项目请在任务内容里使用明确的项目绝对路径。旧任务、旧会话分组均不迁移。

挂接失败不会开始模型调用；回执区分 `session_id` 和成功挂接后的 `workspace_id`。原生会话日志与工作区记录不是同一事务，进程崩溃仍可能留下无完整日志的工作区条目，取消/释放 Agent 不等于删除会话。

## Hermes MCP 配置

通过 Hermes 官方配置接口添加独立条目，保留其他服务：

```yaml
mcp_servers:
  hermes-dsh-distributor:
    url: http://127.0.0.1:LOCAL_FORWARD_PORT/mcp/task-router/v1
    headers:
      Authorization: Bearer <PLUGIN_TOKEN>
    timeout: 180
```

`LOCAL_FORWARD_PORT` 是 Hermes 所在机器上的本地反向转发端口。建议只经 Tailscale 等可信私网使用 SSH，将该端口绑定于 `127.0.0.1`，转发至 DSH 的回环 Web 端口。不要公开该端口，也不要复制模型登录凭据；这里只传递本插件专用 token。

保存配置后，使用宿主支持的官方增量 MCP 刷新，检查实际工具清单。常驻 gateway 不一定因修改同名服务 URL 或新增服务端工具而重建连接；配置未变时 reconcile 也可能保留旧清单。如当前版本提供官方单服务重连/刷新接口，应优先使用。若无此接口且已获升级/配置修复授权，可仅临时停用该项并增量移除，再用 `finally` 原样恢复目标配置并增量添加；回读完整配置及权限，比较其他服务状态/工具清单。保持服务 key、URL 和 token，不擅自重启 gateway。工具清单和真实调用都应验证。

健康检查：`GET /mcp/task-router/v1/health`，应返回 `ok: true`、`name: hermes-dsh-distributor` 及实际版本。它不要求 token，但仅接受回环来源；真正的 MCP 调用需要 Bearer token。

## 派活示例

先调用 `router_capabilities`，不要猜测供应商、模型或级别。用实际返回值替换占位符：

```json
{
  "request_id": "design-review-001",
  "prompt": "分析这个项目的设计问题，只给建议，不修改文件。",
  "cwd": "/absolute/path/to/Hermes",
  "provider": "EXACT_PROVIDER_ID",
  "model": "EXACT_MODEL_ID",
  "reasoning_effort": "high",
  "mode": "standard",
  "agent_preset": "standard",
  "deadline_ms": 600000
}
```

保存返回的 `task_id`，使用 `router_get` 查询至终态。结果不明确时重试原请求或查询原任务，不要自动换 ID。

`reasoning_effort` 必须显式传入支持的值。不支持思考控制的模型使用能力表的 `none`，不发送 reasoningEffort；若模型原生支持名为 `none` 的级别，则真正发送该级别，不能替代为默认值。

## 状态与限制

- `accepted → running → completed / failed / canceled / timed_out / interrupted`。
- 默认并发 2，可配置 1..8；默认超时 10 分钟，请求可指定 1 秒..1 小时。
- 最多 1000 条回执；达到上限拒绝新任务。不要随意删除回执，否则会失去防重复记录。
- 输出最多 262144 字符，超出设置 `output_truncated`；实际请求证据最多 32 条。
- `resolved` 是预校验配置；`observed` 来自 DSH 实际请求头，并非供应商独立计费证明。
- 取消尽力停止工作，不撤销已经发生的外部副作用。
- 状态目录有独占 `.owner.lock`；崩溃后不自动抢锁。先确认原进程及任务已停止、备份状态，再人工处理；不要在活动实例存在时清锁。

## 从旧名称迁移

本次公开源码改名不代表已升级任意现有安装。默认数据目录和 MCP 路径保持兼容，但不要同时运行两个共享同一状态目录的插件。

1. 等待活动任务结束，备份配置和回执，正常停用旧插件。
2. 安装并启用 `hermes-dsh-distributor`，检查 health 中的实际名称和版本。
3. 若私网中继按旧 health 名称校验身份，应同步改为 `hermes-dsh-distributor`；仅保持 URL 不变不足以通过身份校验。
4. 如更换 Hermes MCP 服务 key，通过官方增量刷新并验证新工具、原回执、鉴权和私网重连。
5. 卸载旧包后检查旧路由是否消失；某些宿主或旧插件需要正常重启才能释放驻留路由。重启前确认活动任务并取得操作者许可。

## 安全边界

- cwd 白名单只是派活目录准入，**不是文件系统沙箱**。Agent 权限仍由 DSH 和所选预设决定。
- 拒绝非回环来源、浏览器 Origin、URL 查询参数鉴权及不正确的 Bearer token。
- SSH 反向转发可能映射整个 DSH Web 端口，而非本插件单一路由。独立 token 不保护宿主其他路由，远端机器必须可信。
- 默认不共享历史会话和记忆；仅可通过上述独立显式只读授权启用。永不通过只读接口开放模型凭据、任意配置文件或旧插件文件队列。
- 软件安装成功或显示在线不证明已加载新代码；升级后核对 health 的实际版本。

## 验证与授权

自动化检查与验收范围见 [ACCEPTANCE.md](ACCEPTANCE.md)。本仓库不包含私人部署配置、token、真实任务回执或旧 Git 历史。

当前 `license` 保持 `UNLICENSED`。公开可见不等于授予开源许可；本次发布未擅自选择许可证。
