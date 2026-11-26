# Magpie CatPaw 插件缺陷审查

- 审查日期：2026-11-26
- 插件版本：`0.1.0`
- 插件提交：`a79ecfba3c10cbb33397397fa4f675effc1ff3a3`
- 实际验证 Magpie：`0.1.4794`
- Magpie 规范参考提交：`6346f3835092400206f330ddf4a4fe1eaef1dc73`
- 官方插件仓库参考提交：`d8e0ed71bdcffc2c9201110575d0c967fd57b02e`
- 审查范围：`index.mjs`、`index.test.mjs`、`package.json`、`README.md`
- 审查方式：源码审查、官方规范对照、假上游复现、Magpie 沙箱加载
- 当前状态：待审阅；本文不代表问题已经修复

## 1. 审查结论

**不是所有“必须修复”都属于 Magpie 插件规范强制要求。** 需要分成四类看：

| 类别 | 是否属于强制规范 | 本文涉及问题 |
|---|---|---|
| Magpie Host 契约 | 是；插件选择使用对应能力时，必须按契约传递语义 | session/subagent 隔离、`usage.balance`、登录失效标记 |
| Magpie 官方社区仓库规范 | 仅提交到 `magpie-community/plugins` 时适用 | scoped 包名、registry summary、OpenCode 检查器 |
| OpenCode / OpenAI 兼容契约 | 插件声称兼容对应宿主或协议时适用 | `_internal` 导出、OpenCode 2 适配器、`tool_choice`、`usage` |
| 通用正确性、安全与产品质量 | 不是某一条插件格式规范，但属于真实缺陷 | 会话串线、全局模型缓存、错误映射、账号显示、图片校验、文档措辞 |

因此：

- **会话串线、模型类型串号、错误被伪装成成功**是确定 correctness bug，即使格式完全符合 Magpie manifest，也必须修。
- **`usage.balance`**是 Magpie 已支持的可选契约；当前写法没有违法，但会丢失 Smart routing 能力，属于功能缺陷。
- **`magpie.name`、scoped 包名、registry summary**不是个人 Git 插件的强制要求；它们主要解决展示和官方仓库收录问题。
- **`_internal` 和 OpenCode 2 适配器**不会阻止 Magpie 加载，但会让官方插件检查器失败；只有继续声称 OpenCode 兼容时才必须处理。

### 1.1 严重程度定义

| 等级 | 含义 |
|---|---|
| P0 | 可能造成跨会话数据污染、隐私泄露或不可控工具执行 |
| P1 | 明确的功能错误、错误账号/模型、假成功、客户端卡住 |
| P2 | 多账号、异常路径、兼容性或长期运行缺陷 |
| P3 | 展示、文档、元数据等质量问题 |

### 1.2 缺陷总表

| ID | 等级 | 问题 | 主要依据 | 状态 |
|---|---|---|---|---|
| D-01 | P0 | 会话 key 忽略 Magpie session/subagent，可能串线 | 通用正确性 + Magpie session 契约 | 已修复 |
| D-02 | P1 | 会话映射仅存内存、无清理，重启丢上下文 | 通用正确性 + 长期运行 | 已修复 |
| D-03 | P1 | HTTP 200 业务错误和 SSE 错误码被误判为成功 | 通用正确性 + 错误契约 | 已修复 |
| D-04 | P1 | `liveTypes` 全局缓存导致多账号模型类型串号 | 通用正确性 | 已修复 |
| D-05 | P1 | 用量卡片用桌面账号显示网页/手动 token 的余额 | 通用正确性 | 已修复 |
| D-06 | P2 | 余额只作为文本，未传递结构化 `balance` | Magpie `usage` 契约 | 已修复 |
| D-07 | P0 | `tool_choice:none` 无效，服务端工具无法保证关闭 | OpenAI 兼容 + 安全 | 已修复 |
| D-08 | P1 | 空参数工具调用发出非法流 | OpenAI streaming 契约 | 已修复 |
| D-09 | P2 | 命名与文案缺乏层次，老配置还会覆盖新名称 | 产品质量 + Magpie 可选展示字段 | 已修复 |
| D-10 | P2 | OpenCode 官方检查器失败 | OpenCode / 官方仓库规范 | 已修复 |
| D-11 | P2 | 未验证的模型上下文/输出上限被声明为事实 | 产品质量 | 已修复 |
| D-12 | P2 | 限流状态全局共享，忽略 `Retry-After` | 多账号正确性 | 已修复 |
| D-13 | P2 | 图片缺少模型能力、MIME、大小校验，错误分类错误 | 安全 + 异常处理 | 已确认 |
| D-14 | P2 | 取消信号未贯穿，桌面登录失效状态不一致 | Magpie abort / sign-in 契约 | 已确认 |
| D-15 | P2 | 静默忽略 OpenAI 参数，伪造零 token 用量 | OpenAI 兼容契约 | 已确认 |
| D-16 | P3 | README 和包 metadata 保留旧定位与不中性措辞 | 官方仓库规范 + 文档质量 | 已确认 |
| D-17 | P2 | 高风险路径缺少回归测试 | 工程质量 | 已确认 |

## 2. 详细缺陷

以下章节按缺陷编号逐项展开。每项包含：依据、位置、现象、复现、影响、最小修复方向和验收标准。

### D-01 会话 key 忽略 session/subagent，可能串线

- **等级：** P0
- **状态：** 已修复
- **依据：** 通用正确性；Magpie 为有状态插件提供 `X-Magpie-Session` 和 `X-Magpie-Subagent`。规范没有强制所有插件使用，但一旦插件自行复用会话，就必须保证隔离。
- **位置：** `index.mjs:795`、`index.mjs:863`、`index.mjs:1358`
- **现象：** `chatId()` 只取首条 user 消息文本的前 200 字符；纯图片或空文本首轮统一返回 `session`。`fetch` 完全没有读取 Magpie 的 session/subagent header。
- **复现：** 使用同一个插件实例和假上游：
  1. 会话 A 首条消息为 `same opening`，创建 `round` 和 `conversationId=A`。
  2. 会话 B 首条消息也是 `same opening`，但请求头带 `x-magpie-session: independent-session`。
  3. 结果只创建了 1 次 `round`，两次 `turn` 使用同一个 `conversationId`。
- **影响：** 两个独立聊天可能共享服务端历史；相同首句、相同账号、并行子 Agent 都可能互相污染。如果进一步跨账号复用，风险更高。
- **最小修复方向：**
  - 从 `init.headers` 或 `Request.headers` 读取 `X-Magpie-Session`、`X-Magpie-Subagent`。
  - 使用稳定账号身份与 session/subagent 组合作为 key。
  - 没有可靠 session 时，不使用 prompt 文本兜底复用。
- **验收标准：**
  - 相同首句、不同 session 的请求创建不同 `conversationId`。
  - 相同 session、不同 subagent 的请求创建不同 `conversationId`。
  - 不同账号使用相同 session 时不会共享 `conversationId`。

### D-02 会话映射仅存内存、无清理，重启丢上下文

- **等级：** P1
- **状态：** 已修复
- **依据：** 通用正确性、长期运行稳定性。
- **位置：** `index.mjs:795`、`index.mjs:865`、`index.mjs:941`
- **现象：** `conversations` 是插件实例内的普通 `Map`，没有持久化、TTL 或容量上限。Magpie 重启后映射丢失，但请求仍被视为已有历史的续聊。
- **具体案例：** 一个会话已有 10 轮历史，Magpie 重启后用户发送第 11 轮。插件认为 `fresh=false`，只发送最后一条 user 消息；新的上游会话没有前 10 轮历史。
- **附带问题：** key 中保留用户 prompt 片段，且永久不清理；长期运行时内存和敏感文本会持续累积。
- **最小修复方向：**
  - 若协议允许，改成每次发送完整历史，不依赖跨请求会话映射。
  - 若必须复用，按账号 + session 持久化映射，并设置 TTL/LRU。
- **验收标准：**
  - Magpie/插件宿主重启后，续聊仍能保留预期历史，或明确退化为完整历史重放。
  - 映射达到容量上限时有确定淘汰策略。
  - 不长期保留原始 prompt 文本作为 key。

### D-03 HTTP 200 业务错误和 SSE 错误码被误判为成功

- **等级：** P1
- **状态：** 已修复
- **依据：** 通用正确性；Magpie 的 fallback、登录失效和限流处理依赖正确的 HTTP/error 语义。
- **位置：** `index.mjs:122`、`index.mjs:654`、`index.mjs:919`、`index.mjs:950`
- **现象：**
  - `post()` 已返回 `payload`，但 `round` 只检查 HTTP status 和原始文本，不检查 body 的 `code/unifyCode`。
  - `event` 只处理 429，其他非 200 状态被忽略。
  - SSE `frame.error` 带上 `code/unifyCode`，但 `stepError()` 不读取它们。
- **复现：** 假上游让 `round` 返回 HTTP 200 + `{"code":500,"msg":"boom"}`，插件仍继续执行，最终返回 HTTP 200 的空 completion。
- **其他案例：** SSE 返回 `error.code=401` 或 `error.code=429` 时，会被映射成普通 502，无法正确提示重新登录或进入冷却。
- **最小修复方向：**
  - 建立统一的上游错误归一化函数，同时读取 HTTP status、body code、SSE code。
  - 401 → `X-Magpie-Sign-In: expired`；402 → `insufficient_quota`；429 → `Retry-After` 和冷却。
  - `event` 的非 200 必须按与 `round` 一致的规则处理。
- **验收标准：**
  - HTTP 200 + 非零业务 code 不返回成功 completion。
  - SSE 401/402/429 分别映射为正确状态和类型。
  - `event` 500/401 不会继续静默执行。

### D-04 `liveTypes` 全局缓存导致多账号模型类型串号

- **等级：** P1
- **状态：** 已修复
- **依据：** 通用正确性、多账号隔离。
- **位置：** `index.mjs:93`、`index.mjs:197`、`index.mjs:829`
- **现象：** `liveLists` 按 token 缓存，但 `liveTypes` 是模块级全局 `Map`。任何账号刷新模型列表都会覆盖全局模型类型；模型有效性检查甚至还发生在 token 解析之前。
- **复现：**
  1. 账号 A 的模型列表把 `shared-model` 映射为 `modelTypeId=901`。
  2. 账号 B 的列表把同名模型映射为 `902`。
  3. 调用 `modelTypeOf("shared-model")` 得到 `902`，即使当前请求属于账号 A。
- **影响：** 多账号可能使用错误模型类型；某账号独享的模型还会被其他账号误判为可用。
- **最小修复方向：**
  - 模型类型与账号缓存放在同一个结构中，不维护全局 `liveTypes`。
  - 先解析当前账号 token，再用该账号的模型列表校验请求。
- **验收标准：**
  - A、B 同名模型使用不同 type 时，各自请求使用自己的 type。
  - 只有 A 可见的模型不能被 B 请求通过校验。

### D-05 用量卡片可能显示错误账号

- **等级：** P1
- **状态：** 已修复
- **依据：** 通用正确性、多账号隔离。
- **位置：** `index.mjs:1111`、`index.mjs:1114`、`index.mjs:1147`
- **现象：** `usage()` 正确使用当前登录 token 查询余额，但 `user` 字段调用 `authAccountName()`，后者永远读取本机桌面端 `auth.json`。
- **复现：** 让 `getAuth()` 返回网页账号 `Web User` 和 `web-token`，本机桌面文件为 `Desktop User`；最终 `usage.user` 显示 `Desktop User`。
- **影响：** 网页登录、手动 token、`CATPAW_TOKEN` 的余额可能挂在错误用户名下；多账号场景会误导用户。
- **最小修复方向：** 使用 `resolveToken()` 返回的账号名，并让桌面、网页、手动 token 都返回一致的 identity 信息。
- **验收标准：**
  - 网页 token 显示网页账号。
  - 手动 token 显示手动账号标识。
  - 桌面 token 显示桌面账号。

### D-06 余额只作为文本，未传递结构化 `balance`

- **等级：** P2
- **状态：** 已修复
- **依据：** Magpie `auth.usage` 契约。当前字段组合不会导致加载失败，但没有使用 Magpie 为 prepaid wallet 提供的结构化能力。
- **位置：** `index.mjs:1141`、`index.mjs:1148`
- **现象：** 返回 `used:0`、`display:"1154.73 credit"`、`aside:true`，没有 `balance/unit`。
- **影响：**
  - Magpie 无法比较同供应商账号的剩余积分。
  - Smart routing 不能优先使用余额更多的账号。
  - 余额为 0 时也不会被当作 wallet 已耗尽。
- **规范说明：** Magpie 支持 `{name, balance, unit}` 表示无总额上限的 prepaid wallet；此时应省略 `used`，不要伪造百分比。
- **最小修复方向：**
  - 校验 `credit` 是有限数字。
  - 返回 `{name:"可用积分", balance:credit, unit:"credit", resetsAt?}`。
- **验收标准：**
  - 余额变化会反映到结构化字段。
  - 0 余额被识别为耗尽。
  - 非数字或缺失余额返回 error，而不是显示 `?`。

### D-07 `tool_choice:none` 无效，服务端工具无法保证关闭

- **等级：** P0
- **状态：** 已修复
- **依据：** OpenAI 兼容契约、工具调用安全。
- **位置：** `index.mjs:525`、`index.mjs:571`、`index.mjs:617`、`index.mjs:856`
- **现象：**
  - 请求中的 `tool_choice` 从未读取。
  - 只要 `chat.tools` 非空，`toToolConfigs()` 就把所有客户端工具设为 `enable:true`。
  - 代码明确注明服务端工具 `enable:false` 不能真正禁用，但仍照发 `permissionMode:"unsafeBypassPermissions"`。
- **复现：** 请求设置 `tool_choice:"none"` 并声明工具 `danger`，假上游返回 `tool_use`；插件仍返回 `finish_reason:"tool_calls"` 和该调用。
- **影响：** 调用方明确禁止工具时仍可能收到工具调用；服务端自带工具是否被触发也无法由客户端保证，存在安全和工作流风险。
- **最小修复方向：**
  - `tool_choice:"none"` 时不启用客户端工具，并拒绝/过滤返回的 `tool_use`。
  - 过滤未声明的工具调用，避免把服务端工具暴露给 Magpie 客户端。
  - 如果私有协议无法保证关闭服务端工具，应显式拒绝该场景或给出明确限制，而不是静默忽略。
- **验收标准：**
  - `tool_choice:"none"` 永远不返回 tool call。
  - 未声明的 `tool_use` 不会进入客户端响应。
  - 对无法保证的行为有明确错误或文档说明。

### D-08 空参数工具调用产生不合法流

- **等级：** P1
- **状态：** 已修复
- **依据：** OpenAI streaming 契约、客户端正确性。
- **位置：** `index.mjs:763`、`index.mjs:1002`、`index.mjs:1026`
- **现象：** `makeDiffer.params()` 在首次收到空字符串时返回 `null`，因此不会发送包含工具 `id/name` 的首个 chunk；但 `stashed` 已非空，最终仍发送 `finish_reason:"tool_calls"`。
- **复现：** 假上游返回 `toolParams:""`；输出中没有 `call-empty`，却包含 `"finish_reason":"tool_calls"`。
- **影响：** 客户端可能等待一个永远不会出现的 tool call，表现为卡住、空执行或协议错误。
- **最小修复方向：** 每个新工具调用首次出现时都发送元数据 chunk，参数为空时发送 `arguments:""`。
- **验收标准：**
  - 空参数工具调用在流中先出现 `id/name`，再出现 tool_calls finish。
  - 多工具调用仍使用独立 index。

### D-09 命名与文案缺乏层次，老配置还会覆盖新名称

- **等级：** P2
- **状态：** 已修复
- **依据：** 产品质量；`magpie.name/magpie.summary` 是 Magpie 可选展示字段，不是强制格式。
- **位置：** `package.json:2`、`package.json:4`、`package.json:24`、`index.mjs:18`、`index.mjs:1146`、`index.mjs:1332`
- **现象：**
  - 插件列表标题来自 package name `opencode-catpaw-tools-auth`，容易与 OpenCode 产品混淆。
  - provider 列表和用量卡片标题来自 `NAME="妙手 CatPaw · 原生工具调用"`。
  - `usage.plan` 在没有真实 `planName` 时回退成 `NAME`，会把能力描述伪装成套餐名。
  - `config()` 中 `...was` 位于默认 `name` 之后，老安装保存的旧名称会继续覆盖新代码。
- **截图来源说明：** 第三张右侧的“体验版”是上游真实 `planName`；“原生工具调用”来自 provider 名称，不是套餐字段。
- **最小修复方向：**
  - 增加 `magpie.name:"妙手 CatPaw"`。
  - provider 名称改为 `妙手 CatPaw`；能力说明放 `magpie.summary` 或 README。
  - 套餐只使用真实 `planName`，缺失时省略。
  - 对旧的完整 `NAME` 做定向迁移，不覆盖用户自定义名称。
- **验收标准：**
  - 新安装和老安装升级后，插件列表、provider 列表、用量标题均显示 `妙手 CatPaw`。
  - 无套餐信息时不显示重复的能力描述。

### D-10 OpenCode 官方检查器失败

- **等级：** P2；仅当继续声称兼容 OpenCode 或提交官方仓库时必须修复。
- **状态：** 已修复
- **依据：** OpenCode 1.x/2.x 加载契约；`magpie-community/plugins` 检查脚本。
- **位置：** `opencode.mjs:1`、`opencode2.mjs:1`、`package.json:5`
- **官方检查结果：**
  - `main exports _internal, which OpenCode 1.x takes for a plugin and refuses`
  - `OpenCode 2.x: ./index.mjs has no default {id, setup}`
- **重要说明：** Magpie 0.1.4794 沙箱已成功加载当前插件，所以这不是 Magpie 运行时故障。
- **最小修复方向：**
  - 只支持 Magpie：删除 OpenCode 兼容声明和相关命名，不必强行增加适配器。
  - 同时支持 OpenCode：把测试内部导出拆出主入口，并增加官方 `opencode2.mjs` 适配器。
- **验收标准：** 官方 `scripts/check.mjs` 对目标 package 零错误。

### D-11 未验证的模型上下文/输出上限被声明为事实

- **等级：** P2
- **状态：** 已修复
- **依据：** 产品质量、模型元数据真实性。
- **位置：** `core.mjs:39`、`core.mjs:64`
- **现象：** 所有模型声明约 1M 上下文；未知模型也默认 1M/131072。README 说明这些值来自模型家族公开资料，而不是妙手网关的 per-model 限制。
- **影响：** 客户端可能按错误上限组装请求，导致妙手网关拒绝；输出上限错误也会影响截断和重试策略。
- **规范对照：** 官方 CatPaw 插件选择不声明未经客户端确认的上下文/输出窗口。
- **最小修复方向：** 未实测前省略 `limit`，或使用有依据的保守值；未知模型尤其不应套用固定上限。
- **验收标准：** 只声明有妙手实测或明确文档支持的模型限制。

### D-12 限流状态全局共享，忽略 `Retry-After`

- **等级：** P2
- **状态：** 已修复
- **依据：** 多账号正确性、HTTP 契约。
- **位置：** `core.mjs:97`、`core.mjs:103`、`core.mjs:970`、`core.mjs:1053`
- **现象：**
  - `limitedUntil` 是模块级全局变量，一个账号触发 429 会阻塞所有账号。
  - `post()` 没有返回响应头，因此无法使用上游 `Retry-After`，始终使用固定猜测值。
  - `CATPAW_RATE_LIMIT_MS` 没有校验正数，负值会产生无效等待时间。
- **最小修复方向：**
  - 按账号隔离冷却；只有确认供应商限额是全局作用域时才保留全局状态。
  - 保留响应头并优先解析 `Retry-After`。
  - 环境变量只接受有限正数。
- **验收标准：**
  - 账号 A 的 429 不会直接阻塞账号 B。
  - 上游指定 120 秒时，插件返回约 120 秒，而不是固定 45 秒。

### D-13 图片缺少能力、MIME、大小校验，错误分类错误

- **等级：** P2
- **依据：** 安全、异常处理、模型能力契约。
- **位置：** `index.mjs:689`、`index.mjs:718`、`index.mjs:884`
- **现象：**
  - 文本模型也会上传并发送图片，插件没有检查当前模型是否支持 image。
  - 任意 data URI MIME、任意大小和数量都被接受。
  - base64 会在内存中形成多份副本，超大图片可能拖垮插件宿主。
  - 上传的网络错误或上游 500 也统一返回 400。
- **最小修复方向：**
  - 上传前检查模型 image 能力。
  - 只接受 `image/*`，限制单图字节、图片数量和总解码大小。
  - 用户输入错误返回 400；网络/上游错误返回 502。
- **验收标准：**
  - 文本模型收到图片时在发送前被拒绝。
  - 非图片 MIME 和超限图片返回明确 400。
  - 上传服务 500 返回 502，而不是 400。

### D-14 取消信号未贯穿，桌面登录失效状态不一致

- **等级：** P2
- **依据：** Magpie abort/sign-in 契约、生命周期正确性。
- **位置：** `index.mjs:903`、`index.mjs:943`、`index.mjs:1113`、`index.mjs:1212`
- **现象：**
  - `round`、`event`、图片上传没有传入请求的 `init.signal`，只有 `turn` 使用。
  - 网页登录 callback 捕获所有轮询异常；Magpie 取消登录后，`AbortError` 被吞掉，循环仍可能继续到 3 分钟超时。
  - `usage()` 把桌面登录文件缺失、无 token 也返回 `signIn:"kept"`，与 loader 的 `SignedOut → 401 expired` 不一致。
- **最小修复方向：**
  - 将 abort signal 贯穿 round/event/upload。
  - 轮询遇到 `AbortError` 立即退出，不当作普通失败吞掉。
  - 桌面登录文件缺失或无 token 时返回 `signIn:"expired"`；临时网络错误保持 `kept`。
- **验收标准：**
  - 取消请求后不再继续创建 round/event 或上传图片。
  - 取消网页登录后轮询立即停止。
  - 桌面 token 文件被删除后，用量页不会继续显示正常已登录。

### D-15 静默忽略 OpenAI 参数，伪造零 token 用量

- **等级：** P2
- **依据：** OpenAI 兼容契约、用量数据真实性。
- **位置：** `index.mjs:957`、`index.mjs:1105`
- **现象：**
  - `max_tokens`、`max_completion_tokens`、`stop`、`response_format`、`stream_options` 等字段被静默丢弃。
  - 非流式响应固定返回 `usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}`；官方 CatPaw 插件选择直接省略，因为零值会被当成真实统计。
- **影响：** 调用方以为限制已生效，实际没有；Magpie 的 token 统计可能被写成真实零用量。
- **最小修复方向：**
  - 能实现的参数实现；不能实现的明确拒绝或记录到 README 限制。
  - 未知 token 数时省略 `usage`，不要填零。
- **验收标准：**
  - 不支持的字段不会静默改变语义。
  - 非流式响应不伪造 token 统计。

### D-16 README 和包 metadata 保留旧定位与不中性措辞

- **等级：** P3
- **依据：** 官方社区仓库规范、文档质量。
- **位置：** `README.md:1`、`README.md:5`、`package.json:4`、`package.json:12`
- **现象：**
  - 标题、description、keywords 强调 OpenCode，与“为 Magpie 编写”的定位不一致。
  - README 使用“假装工具调用”形容社区插件，不利于技术讨论。
  - 缺少 `repository` 元数据。
  - 如果提交官方仓库，还缺少 scoped 包名和 registry 的中英文 summary；现有 CatPaw channel 已存在，需要说明差异。
- **最小修复方向：**
  - README 用中性描述区分“文本协议适配”和“原生 Agent 协议”。
  - 补充 `repository` 和 `magpie.summary`。
  - 若提交官方仓库，按 `@magpie-community/opencode-<name>-auth` 命名，并在 registry summary 说明差异。
- **验收标准：** 包名、描述、README、registry 对目标平台和能力的表述一致。

### D-17 高风险路径缺少回归测试

- **等级：** P2
- **依据：** 工程质量。
- **位置：** `index.test.mjs:232`、`index.test.mjs:478`
- **现象：** 现有 45 个测试全部通过，但没有覆盖以下已复现缺陷：
  - 不同 session/subagent/账号的会话隔离。
  - 多账号模型类型隔离。
  - HTTP 200 业务错误、SSE 401/402/429。
  - 用量账号身份和结构化余额。
  - `tool_choice:none`、空参数工具流。
  - 宿主重启后的会话行为。
- **最小修复方向：** 把本文复现案例转成假上游测试；优先覆盖 D-01、D-03、D-04、D-05、D-07、D-08。
- **验收标准：** 每个 P0/P1 缺陷至少有一个会在回归时失败的测试。

## 3. 不应误判为规范违规的项目

- **个人 Git 插件未使用 scoped 包名：** 不是 Magpie 强制要求；只有提交 `magpie-community/plugins` 时才需要遵守其命名约定。
- **`magpie.maxConcurrency:2`：** 是 Magpie 支持的有效字段，不需要删除。
- **`auth.icon` 与 `magpie.icon` 同时存在：** 两者分别覆盖 provider 行和 Discover 卡片，当前重复设计合理。
- **三个登录方式都使用 `type:"oauth"`：** 官方手动 token 示例也使用该形式，并提供 `prompts`，不构成违规。
- **`usage` 使用 `aside/display`：** Magpie 仍接受这种字段组合；D-06 的问题是失去结构化余额和路由能力，不是 schema 非法。
- **`_internal` 导致 Magpie 无法加载：** 不成立；Magpie 0.1.4794 已实际加载成功。它只影响 OpenCode 1.x 和官方检查器。
- **`catpaw-tools` 与官方 `catpaw` 重名：** 不重名；但如果要收录到官方仓库，仍按“同一 channel”规则说明差异。
- **`permissionMode:"unsafeBypassPermissions"` 本身：** 来自妙手客户端抓包；D-07 的核心是插件无法可靠限制工具，而不是这个常量单独违规。

## 4. 规范与实现参考

- Magpie 传给插件的 session/subagent header：  
  https://github.com/yetone/magpie/blob/6346f3835092400206f330ddf4a4fe1eaef1dc73/internal/gateway/plugin_session.go#L23-L40
- Magpie `auth.usage` 的 `balance/unit` 契约：  
  https://github.com/yetone/magpie/blob/6346f3835092400206f330ddf4a4fe1eaef1dc73/internal/plugin/host.js#L3331-L3368
- Magpie `magpie.name` 的读取规则：  
  https://github.com/yetone/magpie/blob/6346f3835092400206f330ddf4a4fe1eaef1dc73/internal/plugin/market.go#L823-L865
- 官方插件仓库的 package 命名和检查方式：  
  https://github.com/magpie-community/plugins#writing-a-package
- 官方插件检查器：  
  https://github.com/magpie-community/plugins/blob/d8e0ed71bdcffc2c9201110575d0c967fd57b02e/scripts/check.mjs
- 官方 CatPaw 插件对模型窗口和 token usage 的处理：  
  https://github.com/magpie-community/plugins/blob/d8e0ed71bdcffc2c9201110575d0c967fd57b02e/packages/catpaw/README.md

## 5. 验证记录

### 5.1 已执行

| 验证 | 结果 |
|---|---|
| `bun test` | 45 pass，0 fail |
| Magpie 0.1.4794 沙箱加载 | 成功；provider `catpaw-tools` 和 12 个静态模型正常出现 |
| 官方 `scripts/check.mjs` | 当前通过；修复前曾有 2 项失败 |
| 假上游会话隔离复现 | 失败；不同 session 复用同一 `conversationId` |
| 假上游 HTTP 200 业务错误复现 | 失败；`round code=500` 仍返回 completion 200 |
| 假上游多账号模型类型复现 | 失败；901 被 902 覆盖 |
| 假上游用量身份复现 | 失败；网页 token 显示桌面用户名 |
| 假上游 `tool_choice:none` 复现 | 失败；仍返回 tool call |
| 假上游空参数流复现 | 失败；无 tool call chunk，但有 tool_calls finish |
| `npm pack --dry-run` | 成功；包内容完整 |

### 5.2 未验证

- 未使用真实妙手 token 发请求，未消耗额度。
- 未在 Windows 实机验证。
- 未修改代码，因此没有验证修复后的 Magpie GUI 展示和升级迁移。
- 私有协议未来变化不在本次静态审查范围内。

## 6. 建议修复批次

1. **第一批：正确性与安全**
   - D-01、D-02、D-03、D-04、D-05、D-07、D-08。
   - 目标：消除串线、假成功、错误账号/模型和非法工具流。
2. **第二批：多账号与异常路径**
   - D-06、D-12、D-13、D-14、D-15、D-17。
   - 目标：完善余额路由、限流、图片、取消和兼容语义。
3. **第三批：定位与发布**
   - D-09、D-10、D-11、D-16。
   - 目标：统一 Magpie/OpenCode 定位、展示名称、模型元数据和官方仓库收录材料。

**审阅重点：** 先确认 D-01/D-02 选择“持久化会话映射”还是“每次重放完整历史”，再确认 D-07 对无法关闭服务端工具采取拒绝策略还是明确的能力降级。这两个决策会直接影响后续实现范围。






