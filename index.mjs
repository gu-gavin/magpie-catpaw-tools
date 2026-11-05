// opencode-catpaw-tools-auth — the 妙手 (CatPaw, Meituan) provider plugin for magpie.
//
// Unlike a plain chat bridge, this plugin implements CatPaw's *agent* protocol:
// the server decides which tool to call, the client executes it and sends the
// result back. That round trip is what makes it usable as a coding agent's
// backend.
//
// Protocol (verified against the 妙手 desktop client, 2026-10-23):
//   POST /api/agent/conversation/round     create the round
//   POST /api/agent/conversation/event     mark it running
//   POST /api/agent/conversation/turn      SSE answer  (repeatable, per tool call)
//   POST /api/agent/conversation/turn-end  close the tool round
//
// The SSE frames are *cumulative* — every frame carries the whole text so far,
// not a delta — so each is diffed against the last.

const ID = "catpaw-tools"
const NAME = "妙手 CatPaw (tools)"

const ORIGIN = "https://ai.catpaw.meituan.com"

// The credit balance endpoint lives on a different host AND takes a different
// auth header from the conversation gateway: X-Auth-Token, not the gateway's
// Cookie: X-Passport-Token. Sending the cookie there answers 401 code 4010,
// and magpie reads a 401 from usage as "this sign-in is gone", which would mark
// a live account signed out.
const BALANCE_URL =
  process.env.CATPAW_BALANCE_URL || "https://catx.nocode.cn/api/gateway/credit/balance"

const PASSPORT_BASE = process.env.CATPAW_PASSPORT_BASE || "https://catx.nocode.cn"

// ── models ─────────────────────────────────────────────────────────────────
//
// modelType ids verified one by one against the live gateway on 2026-10-23 by
// reading the `model` field of the first SSE frame. Context/output sizes come
// from models.dev for the same model family; CatPaw publishes no per-model
// window of its own, so these are the model's own figures, not invented ones.

const MODELS = {
  "longcat-2.5": { name: "LongCat-2.5", type: 10002544, context: 1048576, output: 131072, reasoning: true, image: false },
  "longcat-2.0": { name: "LongCat-2.0", type: 77, context: 1048576, output: 131072, reasoning: true, image: false },
  "glm-5.3": { name: "GLM-5.3", type: 89, context: 1000000, output: 131072, reasoning: true, image: false },
  "glm-5.3-flash": { name: "GLM-5.3-Flash", type: 91, context: 1000000, output: 131072, reasoning: true, image: false },
  "glm-5.3-flashx": { name: "GLM-5.3-FlashX", type: 98, context: 1000000, output: 131072, reasoning: true, image: false },
  "deepseek-v4.1-flash": { name: "DeepSeek-V4.1-Flash", type: 97, context: 1000000, output: 384000, reasoning: true, image: false },
  "deepseek-v4-pro": { name: "DeepSeek-V4-Pro", type: 64, context: 1000000, output: 384000, reasoning: true, image: false },
  "minimax-m3.1-flash": { name: "MiniMax-M3.1-Flash", type: 10002518, context: 1000000, output: 524288, reasoning: true, image: false },
  "minimax-m3": { name: "MiniMax-M3", type: 70, context: 1000000, output: 524288, reasoning: true, image: false },
  "kimi-k3.1-pro": { name: "Kimi-K3.1-Pro", type: 10002533, context: 1048576, output: 131072, reasoning: true, image: false },
  "kimi-k3": { name: "Kimi-K3", type: 83, context: 1048576, output: 131072, reasoning: true, image: false },
  "auto": { name: "Auto (妙手自动选择)", type: 0, context: 1000000, output: 131072, reasoning: true, image: false },
}

const modelTypeOf = (id) => MODELS[id]?.type ?? liveTypes.get(id) ?? MODELS["longcat-2.0"].type

const isKnownModel = (id) => id in MODELS || liveTypes.has(id)

// A model the table cannot describe (the vendor added it since this release)
// still gets the shape every CatPaw gateway model has, rather than no limits
// at all; the vendor enforces the real ones.
function configModel(id, m = MODELS[id]) {
  const base = {
    name: m?.name ?? id,
    context: 1000000,
    output: 131072,
    reasoning: true,
    ...(m ?? {}),
  }
  return {
    name: base.name,
    limit: { context: base.context, output: base.output },
    reasoning: base.reasoning,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  }
}

// ── the live model list ────────────────────────────────────────────────────

// The vendor serves models the table above cannot know about — LongCat-2.5
// arrived that way. `provider.models` asks the gateway what it has right now,
// so the list in magpie is the vendor's, not a snapshot from the last release.
const LIVE_TTL = 5 * 60 * 1000
const LIVE_URL = "/api/agent/maas/model-types"

const liveLists = new Map() // token -> { at, models }
const liveTypes = new Map() // model id -> modelType, for models the table lacks

// The vendor rate-limits new conversations and answers 429 when they come too
// fast. The sibling catpaw plugin measured the window at ~41s on the web chat
// endpoint and found that retrying in place only renews it, so we do not retry:
// we remember when the window ends and fail fast, with Retry-After, until then.
// CATPAW_RATE_LIMIT_MS overrides the guess.
const RATE_LIMIT_MS = Number(process.env.CATPAW_RATE_LIMIT_MS) || 45_000
let limitedUntil = 0

const looksRateLimited = (text) => /rate.?limit|too many|请求过于频繁|429/i.test(text ?? "")

// Opens a window and returns how many seconds the caller should wait.
function noteRateLimit(ms = RATE_LIMIT_MS) {
  limitedUntil = Math.max(limitedUntil, Date.now() + ms)
  return Math.ceil((limitedUntil - Date.now()) / 1000)
}

const rateLimitSecondsLeft = () => Math.max(0, Math.ceil((limitedUntil - Date.now()) / 1000))

const rateLimitMessage = (sec) =>
  `妙手限制建会话频率（HTTP 429）：请等约 ${sec} 秒再发。原地重试会把窗口续期，所以插件不自动重试。`

const rateLimitedError = (sec) =>
  errorResponse(429, rateLimitMessage(sec), "rate_limit_error", { "retry-after": String(sec) })

// extendedInfo.rateMultiplier, the multiplier the client prints as "<n>x";
// undefined when the vendor gives none, so nothing is shown rather than 0
function rateOf(v) {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\s*\d+(?:\.\d+)?\s*[x×]?\s*$/i.test(v)
        ? Number.parseFloat(v)
        : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function liveModels(rows) {
  const out = {}
  const byType = new Map(Object.entries(MODELS).map(([id, m]) => [m.type, id]))
  for (const r of Array.isArray(rows) ? rows : []) {
    const type = r?.modelTypeId
    // a negative id is the user's own custom model: it needs their own key and
    // base URL, and this gateway does not serve it
    if (!Number.isInteger(type) || type < 0 || r.provider === "USER_CUSTOM") continue
    const name = typeof r.modelTypeName === "string" ? r.modelTypeName.trim() : ""
    const id = byType.get(type) ?? name.toLowerCase().replace(/\s+/g, "-")
    if (!id || id in out) continue
    const x = r.extendedInfo ?? {}
    const rate = rateOf(x.rateMultiplier)
    const copy =
      typeof x.marketingCopy === "string"
        ? x.marketingCopy
            .split(/[,，]/)
            .map((c) => c.trim())
            .filter(Boolean)
        : []
    const free = copy.some((c) => c.includes("免费")) || rate === 0
    out[id] = {
      // the table's name is the tidy one; an unknown model keeps the vendor's,
      // with the badges the client draws beside it
      name: MODELS[id]?.name ?? (copy.length ? `${name} (${copy.join("、")})` : name),
      type,
      ...(rate !== undefined ? { rate } : {}),
      ...(free ? { free: true } : {}),
    }
  }
  return out
}

async function fetchLiveModels(token, signal) {
  const res = await fetch(ORIGIN + LIVE_URL, {
    method: "POST",
    headers: gatewayHeaders(token),
    body: JSON.stringify({ tenant: "CatDesk", scene: "CATX_APP", env: "EXTERNAL" }),
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("妙手登录态已过期，请在妙手桌面端重新登录"), {
      signIn: "expired",
    })
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`妙手模型列表返回 HTTP ${res.status}`)
  if (body && typeof body.code === "number" && body.code !== 0 && body.code !== 200) {
    throw new Error(`妙手模型列表返回 code ${body.code}`)
  }
  const rows = Array.isArray(body) ? body : body?.data
  if (!Array.isArray(rows)) throw new Error("妙手模型列表无法解析")
  const models = liveModels(rows)
  for (const [id, m] of Object.entries(models)) liveTypes.set(id, m.type)
  return models
}

// the account's list, five minutes cached; null when it cannot be read, so the
// table stays the list rather than the provider going empty
async function liveListFor(token, signal) {
  const hit = liveLists.get(token)
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.models
  try {
    const models = await fetchLiveModels(token, signal)
    liveLists.set(token, { at: Date.now(), models })
    return models
  } catch {
    return hit?.models ?? null
  }
}

// ── small helpers ──────────────────────────────────────────────────────────

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const errorResponse = (status, message, type = "invalid_request_error", headers = {}) =>
  json(status, { error: { message, type, code: null, param: null } }, headers)

async function bodyText(input, init) {
  const b = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (b == null) return ""
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

const uuid = () => crypto.randomUUID().replace(/-/g, "")

// ── credentials ────────────────────────────────────────────────────────────

const fs = await import("node:fs")
const os = await import("node:os")
const path = await import("node:path")

// 妙手 is a VS Code-derived app (its product config carries applicationName
// "catpaw-moon" and dataFolderName ".meituan-catpaw"), so its data folder
// follows that family's rule rather than living next to the app:
//
//   Windows   %APPDATA%\.meituan-catpaw\auth.json
//   macOS     ~/.meituan-catpaw/auth.json
//   Linux     ~/.meituan-catpaw/auth.json
//
// The env overrides win first, both our own names and the MEITUAN_* ones the
// other catpaw plugin documents, so an unusual install (or a user migrating
// from it) can still be pointed at without patching anything.
function authCandidates() {
  const out = []
  const add = (p) => {
    if (p && !out.includes(p)) out.push(p)
  }

  const explicit = process.env.CATPAW_AUTH_PATH || process.env.MEITUAN_AUTH_PATH
  if (explicit) return [explicit] // trust it, even if it is not there yet

  for (const dir of [process.env.CATPAW_DATA_DIR, process.env.MEITUAN_DATA_DIR]) {
    if (dir) add(path.join(dir, "auth.json"))
  }
  for (const env of ["APPDATA", "LOCALAPPDATA"]) {
    if (process.env[env]) add(path.join(process.env[env], ".meituan-catpaw", "auth.json"))
  }
  add(path.join(os.homedir(), ".meituan-catpaw", "auth.json"))

  return out
}

// The first candidate that is actually a file; otherwise the last one, which is
// the most likely place, so the error message points somewhere useful.
function authPath() {
  const candidates = authCandidates()
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {}
  }
  return candidates[candidates.length - 1]
}

class SignedOut extends Error {}

let cachedAuth = null
let cachedMtime = 0

// readAuth reads the desktop client's auth.json live, mtime-checked, so signing
// in again in 妙手 is picked up without restarting magpie.
function readAuth() {
  const p = authPath()
  let mtime = 0
  try {
    mtime = fs.statSync(p).mtimeMs
  } catch {
    throw new SignedOut(`未找到妙手登录态文件 ${p}：请安装并登录妙手桌面端，或改用「手动粘贴 token」登录`)
  }
  if (cachedAuth && cachedMtime === mtime) return cachedAuth
  let file
  try {
    file = JSON.parse(fs.readFileSync(p, "utf8"))
  } catch (e) {
    throw new SignedOut(`妙手登录态文件无法解析（${p}）：${e?.message ?? e}`)
  }
  const token = file?.auth?.accessToken
  if (!token) throw new SignedOut(`妙手登录态文件里没有 accessToken（${p}）：请在妙手桌面端重新登录`)
  cachedAuth = { token: String(token), uid: String(file?.account?.uid ?? ""), name: file?.account?.name || "" }
  cachedMtime = mtime
  return cachedAuth
}

function authAccountName() {
  try {
    return readAuth().name || "妙手桌面端账号"
  } catch {
    return "妙手桌面端账号"
  }
}

// resolveToken: any sign-in that carries its own token wins (the web login and
// a pasted one), otherwise the desktop client's file — which is read live, so
// signing in again in 妙手 is picked up without restarting magpie.
async function resolveToken(getAuth) {
  const a = await getAuth()
  if (a?.type === "oauth" && a.access && a.source !== "desktop") {
    const name = a.name || a.accountId || (a.source === "manual" ? "手动粘贴" : "网页登录")
    return { token: a.access, name }
  }
  const file = readAuth()
  return { token: file.token, name: file.name || "妙手桌面端账号" }
}

// ── the gateway ────────────────────────────────────────────────────────────

// Every value here is what the official desktop client puts on the wire.
function gatewayHeaders(token, extra = {}) {
  const traceId = uuid()
  return {
    "Content-Type": "application/json",
    Cookie: `X-Passport-Token=${token}`,
    "User-Agent": "axios/1.19.0",
    "m-appkey": "com.sankuai.mcopilot.cli",
    "m-debug": "true",
    "m-traceid": traceId,
    "x-request-id": crypto.randomUUID(),
    "x-trace-id": traceId,
    "x-agent-version": "1.2.0-beta.6",
    ...extra,
  }
}

async function post(pathname, body, token, { extraHeaders, signal, timeoutMs = 30_000 } = {}) {
  const res = await fetch(ORIGIN + pathname, {
    method: "POST",
    headers: gatewayHeaders(token, extraHeaders),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {}
  return { status: res.status, text, payload }
}

// ── message translation ────────────────────────────────────────────────────
//
// CatPaw carries a *structured* message list, not one flattened blob: it knows
// `tool_use` and `tool_result`. Keeping that structure is what lets an agent
// continue a tool call across turns.

// fromOpenAI converts an incoming chat-completions body to CatPaw's shape.
// System prompts go into systemPromptContext; the rest becomes ordered
// user/assistant/tool messages.
function fromOpenAI(chat) {
  const systemParts = []
  const messages = []
  let lastAssistantId = null

  for (const msg of chat.messages ?? []) {
    const role = msg.role

    if (role === "system" || role === "developer") {
      const text = contentToText(msg.content)
      if (text) systemParts.push(text)
      continue
    }

    if (role === "user") {
      const parts = normalizeUserContent(msg.content)
      if (parts.length === 0) continue
      messages.push({
        type: "user",
        messageId: uuid(),
        content: parts,
        finished: true,
      })
      continue
    }

    if (role === "assistant") {
      const content = []
      const text = contentToText(msg.content)
      if (text) content.push({ type: "text", text })
      for (const call of msg.tool_calls ?? []) {
        const fn = call.function ?? {}
        content.push({
          type: "tool_use",
          toolCallId: call.id,
          toolName: fn.name,
          // CatPaw's own frames carry toolParams as a JSON *string*
          toolParams: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        })
      }
      if (content.length === 0) continue
      const messageId = uuid()
      lastAssistantId = messageId
      messages.push({ type: "assistant", messageId, content, finished: true })
      continue
    }

    if (role === "tool") {
      // OpenAI carries one tool result per message; CatPaw groups them in one
      // `tool` message, so consecutive results are merged.
      const result = {
        type: "tool_result",
        toolCallId: msg.tool_call_id,
        toolName: msg.name ?? "tool",
        toolResult: contentToText(msg.content),
      }
      const prev = messages[messages.length - 1]
      if (prev && prev.type === "tool") {
        prev.content.push(result)
      } else {
        messages.push({
          type: "tool",
          messageId: uuid(),
          parentMessageId: lastAssistantId ?? undefined,
          content: [result],
          finished: true,
        })
      }
      continue
    }
  }

  return { messages, systemPrompt: systemParts.join("\n\n") }
}

function contentToText(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c
        if (c?.type === "text") return c.text ?? ""
        if (c?.type === "image_url" || c?.type === "image") return ""
        return c?.text ?? ""
      })
      .filter(Boolean)
      .join("")
  }
  return String(content)
}

function normalizeUserContent(content) {
  if (content == null) return []
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  const parts = []
  if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === "string") {
        if (c) parts.push({ type: "text", text: c })
      } else if (c?.type === "text" && c.text) {
        parts.push({ type: "text", text: c.text })
      }
      // images are refused in the fetch hook, so they never reach here
    }
  }
  return parts
}

// CatPaw ships its own agent toolbelt (read_file, bash, web_search, sub-agents,
// goals …) which runs in its own sandbox. Those tools would fire whether or not
// we send any, and a tool call the host cannot execute is a dead end: magpie
// would surface a tool it knows nothing about. Every one of them is sent with
// `enable: false` — measured 2026-11-05, that does NOT actually take them out
// of the set, it only leans the model towards ours. Keeping an agent's tool
// names clear of these is what really prevents the leak.
//
// Read off the model's own answer to "list your tools" (2026-10-23).
const SERVER_TOOLS = [
  "todo_write",
  "CallMcpTool",
  "codebase_search",
  "read_file",
  "bash",
  "powershell",
  "task_stop",
  "list_dir",
  "grep",
  "delete_file",
  "fetch_rules",
  "string_replace",
  "write",
  "multi_edit",
  "glob_file_search",
  "task",
  "read_lints",
  "web_fetch",
  "web_search",
  "create_plan",
  "AskQuestion",
  "GenerateImage",
  "Agent",
  "get_goal",
  "create_goal",
  "update_goal",
  "advisor",
  "send_to_agent",
  "list_agents",
]

// toToolConfigs turns OpenAI tool definitions into CatPaw's toolConfigs.
//
// `enable: true` is mandatory: without it the server silently ignores the whole
// entry and the model answers "I have no such tool". `fromClient: true` marks
// the tool as one the client executes (as opposed to the server's own sandbox).
//
// The server's own tools are sent alongside with `enable: false`. The tool set
// is per-turn (leaving them out would not disable them) and `enable: false`
// does not disable them either — it is the best signal available.
function toToolConfigs(tools) {
  const out = []
  const mine = Array.isArray(tools) ? tools : []
  const claimed = new Set()

  for (const t of mine) {
    const fn = t?.function ?? t
    if (!fn?.name) continue
    claimed.add(fn.name)
    out.push({
      name: fn.name,
      enable: true,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parameters ? { inputSchema: fn.parameters } : {}),
      fromClient: true,
    })
  }

  for (const name of SERVER_TOOLS) {
    if (claimed.has(name)) continue
    out.push({ name, enable: false })
  }

  return out
}

// ── the turn stream ────────────────────────────────────────────────────────

// runTurn drives one turn and yields parsed frames. The caller decides when to
// stop (a tool call ends the turn; the host then executes it and calls again).
async function* runTurn(token, { conversationId, message, modelType, toolConfigs, systemPrompt, signal }) {
  const res = await fetch(ORIGIN + "/api/agent/conversation/turn", {
    method: "POST",
    headers: gatewayHeaders(token, {
      Accept: "text/event-stream",
      enableheartbeat: "true",
      "m-spanid": "0.4.1",
      "m-spanname": "conversation.turn",
    }),
    body: JSON.stringify({
      conversationId,
      turnRequestId: uuid(),
      message,
      modelType,
      source: "CatX",
      mode: "CATX_APP",
      permissionMode: "unsafeBypassPermissions",
      toolConfigs,
      toolVersion: "2.0.2",
      ...(systemPrompt ? { systemPromptContext: { systemPrompt } } : {}),
    }),
    // long tool-loop answers stream the whole time; a short cap would cut them
    signal: signal ?? AbortSignal.timeout(15 * 60_000),
  })

  if (res.status !== 200) {
    const detail = (await res.text().catch(() => "")).slice(0, 500)
    throw Object.assign(new Error(`妙手 turn 失败：HTTP ${res.status} ${detail}`), {
      httpStatus: res.status,
    })
  }
  if (!res.body) throw new Error("妙手 turn 返回了空流")

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffered = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data) continue
      if (data === "[DONE]") return
      let frame
      try {
        frame = JSON.parse(data)
      } catch {
        continue
      }
      if (frame.error) {
        throw Object.assign(new Error(`妙手 SSE 错误：${frame.error.message ?? JSON.stringify(frame.error)}`), {
          unifyCode: frame.error.unifyCode,
          code: frame.error.code,
        })
      }
      if (frame.message) yield frame.message
    }
  }
}

// The stream is cumulative: each frame repeats the whole text / toolParams so
// far. diff() tracks the last value per key and returns only what is new.
function makeDiffer() {
  const text = new Map()
  const reasoning = new Map()
  const params = new Map()
  return {
    text(key, full) {
      const prev = text.get(key) ?? ""
      if (full === prev) return null
      text.set(key, full)
      return full.startsWith(prev) ? full.slice(prev.length) : full
    },
    reasoning(key, full) {
      const prev = reasoning.get(key) ?? ""
      if (full === prev) return null
      reasoning.set(key, full)
      return full.startsWith(prev) ? full.slice(prev.length) : full
    },
    params(key, full) {
      const prev = params.get(key) ?? ""
      if (full === prev) return null
      params.set(key, full)
      return full.startsWith(prev) ? full.slice(prev.length) : full
    },
  }
}

// ── the plugin ─────────────────────────────────────────────────────────────

export async function CatPawToolsAuthPlugin({ client } = {}) {
  // conversationId per magpie session, so multi-turn tool loops stay in one
  // conversation. Keyed by chat id, which the fetch hook derives from the
  // request body's first user message when no session header is present.
  const conversations = new Map()

  return {
    auth: {
      provider: ID,
      // A paw, inlined so the provider row has a picture without a fetch.
      // magpie takes an https:// URL or a data: URI here; auth.icon wins over
      // the shared "magpie": { "icon": … } in package.json.
      icon:
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMzIiIGZpbGw9IiNGMjY2MkEiLz48ZyBmaWxsPSIjZmZmIj48ZWxsaXBzZSBjeD0iMjEuNSIgY3k9IjI0IiByeD0iNSIgcnk9IjYuNSIvPjxlbGxpcHNlIGN4PSIzMiIgY3k9IjE5IiByeD0iNS41IiByeT0iNyIvPjxlbGxpcHNlIGN4PSI0Mi41IiBjeT0iMjQiIHJ4PSI1IiByeT0iNi41Ii8+PGVsbGlwc2UgY3g9IjE1IiBjeT0iMzYiIHJ4PSI0LjUiIHJ5PSI2Ii8+PGVsbGlwc2UgY3g9IjQ5IiBjeT0iMzYiIHJ4PSI0LjUiIHJ5PSI2Ii8+PHBhdGggZD0iTTMyIDMyYzcgMCAxMiA0LjYgMTIgMTEgMCA1LTQgOC0xMiA4cy0xMi0zLTEyLThjMC02LjQgNS0xMSAxMi0xMXoiLz48L2c+PC9zdmc+Cg==",

      async loader(getAuth) {
        return {
          baseURL: ORIGIN,
          apiKey: "catpaw",
          async fetch(input, init = {}) {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const pathname = new URL(url).pathname
            if (!/\/chat\/completions$/.test(pathname)) {
              return errorResponse(404, "this plugin serves /chat/completions only")
            }

            let chat
            try {
              chat = JSON.parse(await bodyText(input, init))
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
              return errorResponse(400, "messages is required")
            }

            const model = chat.model || "longcat-2.0"
            if (!isKnownModel(model)) {
              return errorResponse(
                400,
                `unknown model "${model}" (known: ${[...Object.keys(MODELS), ...liveTypes.keys()].join(", ")})`,
              )
            }

            // images: the protocol carries text only, so refuse rather than
            // silently dropping them
            const hasImage = chat.messages.some(
              (m) =>
                Array.isArray(m.content) &&
                m.content.some((c) => c?.type === "image_url" || c?.type === "image"),
            )
            if (hasImage) {
              return errorResponse(
                400,
                "妙手 CatPaw: this provider is text-only; an image part would be dropped silently, so the request is refused",
              )
            }

            // A cooldown opened by an earlier 429 is still running: answer at
            // once instead of sending another doomed request upstream.
            const cooling = rateLimitSecondsLeft()
            if (cooling > 0) return rateLimitedError(cooling)

            let token, accountName
            try {
              const r = await resolveToken(getAuth)
              token = r.token
              accountName = r.name
            } catch (e) {
              return errorResponse(
                e instanceof SignedOut ? 401 : 502,
                String(e?.message ?? e),
                e instanceof SignedOut ? "authentication_error" : "api_error",
              )
            }

            const { messages, systemPrompt } = fromOpenAI(chat)
            if (messages.length === 0) return errorResponse(400, "no usable messages")

            const toolConfigs = toToolConfigs(chat.tools)

            // A tool result in the tail means this is a continuation of a tool
            // round: reuse the conversation and send that message directly.
            const tail = messages[messages.length - 1]
            const continuing = tail.type === "tool"

            const sessionKey = chatId(chat)
            let conversationId = conversations.get(sessionKey)
            const fresh = !conversationId
            if (fresh) {
              conversationId = uuid()
              conversations.set(sessionKey, conversationId)
            }

            // The server keeps the chat history, so each round sends only the
            // new message: the opening one for a fresh conversation, the tool
            // result (or the latest user turn) afterwards. Re-sending the whole
            // list would duplicate it.
            const messageToSend = continuing ? tail : lastUserMessage(messages)

            // Every round starts with `round`. On a fresh conversation it is
            // followed by `event` to mark it running; later rounds are already
            // running from the previous one, and an extra `event` there answers
            // "会话正在执行中" on round.
            const round = await post(
              "/api/agent/conversation/round",
              {
                conversationId,
                message: messageToSend,
                modelType: modelTypeOf(model),
                source: "CatX",
                mode: "CATX_APP",
                permissionMode: "unsafeBypassPermissions",
                toolVersion: "2.0.2",
                repositories: [],
              },
              token,
              { extraHeaders: { "m-spanid": "0.2", "m-spanname": "conversation.round" } },
            ).catch((e) => ({ status: 0, text: String(e?.message ?? e) }))

            if (round.status === 429 || looksRateLimited(round.text)) {
              return rateLimitedError(noteRateLimit())
            }
            if (round.status !== 200) {
              // status 0 means the call never landed (network, timeout): going
              // on to open the stream would fail with a much less useful error
              return errorResponse(
                502,
                `妙手 round 失败：HTTP ${round.status} ${round.text.slice(0, 300)}`,
                "api_error",
              )
            }

            if (fresh) {
              const event = await post(
                "/api/agent/conversation/event",
                { conversationId, eventType: "conversation", data: { status: "running" } },
                token,
                { extraHeaders: { "m-spanid": "0.3", "m-spanname": "conversation.event" } },
              ).catch((e) => ({ status: 0, text: String(e?.message ?? e) }))

              if (event.status === 429 || looksRateLimited(event.text)) {
                return rateLimitedError(noteRateLimit())
              }
            }
            const chatcmpl = `chatcmpl-${uuid().slice(0, 24)}`
            const created = Math.floor(Date.now() / 1000)

            const {
              stream: wantStream = false,
              ...rest
            } = chat
            void rest

            // collect the turn: text, reasoning, and any tool calls
            const differ = makeDiffer()
            let stashed = null
            // one turn can carry several tool_use items; each needs its own
            // delta index or clients append them into one call
            const toolIndex = new Map()
            const indexOf = (id) => {
              if (!toolIndex.has(id)) toolIndex.set(id, toolIndex.size)
              return toolIndex.get(id)
            }

            if (wantStream) {
              const encoder = new TextEncoder()
              const chunk = (delta, finish) => {
                const choices = [{ index: 0, delta: {}, finish_reason: finish ?? null }]
                if (delta) Object.assign(choices[0].delta, delta)
                return encoder.encode(
                  `data: ${JSON.stringify({ id: chatcmpl, object: "chat.completion.chunk", created, model, choices })}\n\n`,
                )
              }

              const stream = new ReadableStream({
                async start(controller) {
                  controller.enqueue(chunk({ role: "assistant" }, null))
                  try {
                    for await (const msg of runTurn(token, {
                      conversationId,
                      message: messageToSend,
                      modelType: modelTypeOf(model),
                      toolConfigs,
                      systemPrompt,
                      signal: init.signal,
                    })) {
                      for (const c of msg.content ?? []) {
                        if (c.type === "text") {
                          const r = differ.reasoning(msg.messageId, c.reasoningContent ?? "")
                          if (r) controller.enqueue(chunk({ reasoning_content: r }, null))
                          const d = differ.text(msg.messageId, c.text ?? "")
                          if (d) controller.enqueue(chunk({ content: d }, null))
                        } else if (c.type === "tool_use") {
                          stashed = c
                          const idx = indexOf(c.toolCallId)
                          const d = differ.params(c.toolCallId, c.toolParams ?? "")
                          if (d) {
                            controller.enqueue(
                              chunk(
                                {
                                  tool_calls: [
                                    {
                                      index: idx,
                                      id: c.toolCallId,
                                      type: "function",
                                      function: { name: c.toolName, arguments: d },
                                    },
                                  ],
                                },
                                null,
                              ),
                            )
                          }
                        }
                      }
                    }
                    controller.enqueue(chunk({}, stashed ? "tool_calls" : "stop"))
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  } catch (e) {
                    // headers are already out, so the status cannot change:
                    // say it in the frame instead
                    const message =
                      e?.httpStatus === 429
                        ? rateLimitMessage(noteRateLimit())
                        : String(e?.message ?? e)
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ error: { message } })}\n\n`,
                      ),
                    )
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  }
                  controller.close()
                },
              })
              return new Response(stream, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              })
            }

            // non-streaming
            let text = ""
            let reasoning = ""
            const toolCalls = []
            try {
              for await (const msg of runTurn(token, {
                conversationId,
                message: messageToSend,
                modelType: modelTypeOf(model),
                toolConfigs,
                systemPrompt,
                signal: init.signal,
              })) {
                for (const c of msg.content ?? []) {
                  if (c.type === "text") {
                    if (c.text) text = c.text
                    if (c.reasoningContent) reasoning = c.reasoningContent
                  } else if (c.type === "tool_use") {
                    // frames repeat a tool call as its params grow: keep the last
                    const i = toolCalls.findIndex((t) => t.toolCallId === c.toolCallId)
                    if (i === -1) toolCalls.push(c)
                    else toolCalls[i] = c
                  }
                }
              }
            } catch (e) {
              if (e?.httpStatus === 429) return rateLimitedError(noteRateLimit())
              const status = e?.httpStatus === 401 ? 401 : 502
              return errorResponse(status, String(e?.message ?? e), "api_error")
            }

            const message = { role: "assistant", content: text || null }
            if (reasoning) message.reasoning_content = reasoning
            if (toolCalls.length) {
              message.tool_calls = toolCalls.map((t) => ({
                id: t.toolCallId,
                type: "function",
                function: { name: t.toolName, arguments: t.toolParams || "{}" },
              }))
            }
            return json(200, {
              id: chatcmpl,
              object: "chat.completion",
              created,
              model,
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: toolCalls.length ? "tool_calls" : "stop",
                },
              ],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            })
          },
        }
      },

      async usage(getAuth) {
        let token
        try {
          token = (await resolveToken(getAuth)).token
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: "kept" }
        }
        let res
        try {
          res = await fetch(BALANCE_URL, {
            headers: {
              Accept: "application/json",
              "X-Auth-Token": token,
              "gray-set": "new-agent-sdk",
            },
            signal: AbortSignal.timeout(20_000),
          })
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: "kept" }
        }
        const payload = await res.json().catch(() => null)
        const code = typeof payload?.code === "number" ? payload.code : null
        if (res.status === 401 || code === 4010 || code === 4011) {
          return { error: "妙手登录态已过期，请在妙手桌面端重新登录", signIn: "expired" }
        }
        if (!res.ok) return { error: `妙手余额查询返回 HTTP ${res.status}`, signIn: "kept" }
        if (!payload) return { error: "妙手余额响应无法解析", signIn: "kept" }
        if (code !== 0) return { error: `妙手余额查询返回异常 code=${code ?? "null"}`, signIn: "kept" }
        const data = payload.data
        if (!data || typeof data !== "object") return { error: "妙手余额响应缺少 data", signIn: "kept" }
        const credit = data.availableCredits ?? data.credit ?? data.balance ?? data.available
        const plan = data.userPlan ?? {}
        // no signIn on a clean read: magpie takes that as "the sign-in is fine"
        // and clears an earlier expired mark
        return {
          plan: plan.planName || NAME,
          user: authAccountName(),
          windows: [
            {
              name: "可用积分",
              used: 0,
              display: `${credit ?? "?"} credit`,
              aside: true,
              ...(plan.nextRefreshTime ? { resetsAt: plan.nextRefreshTime } : {}),
            },
          ],
        }
      },

      methods: [
        {
          type: "oauth",
          label: "妙手桌面端登录态（读本机妙手客户端，推荐）",
          authorize: () => ({
            url: "",
            instructions:
              "使用本机妙手桌面端已保存的登录态：每次请求前实时读取，重开妙手即自动刷新，无需粘贴任何内容。",
            method: "auto",
            callback: async () => {
              try {
                const auth = readAuth()
                return {
                  type: "success",
                  refresh: "",
                  access: auth.token,
                  expires: 0,
                  accountId: auth.name || "妙手桌面端账号",
                  uid: auth.uid,
                  source: "desktop",
                }
              } catch (e) {
                return { type: "failed", error: String(e?.message ?? e) }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "网页登录（妙手官方授权页）",
          authorize: async () => {
            const sid = uuid()
            let entry
            try {
              const res = await fetch(`${PASSPORT_BASE}/api/gateway/passport/login-config`, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(10_000),
              })
              const payload = await res.json().catch(() => null)
              entry = payload?.data?.loginEntryUrl
            } catch (e) {
              return { type: "failed", error: `无法连接妙手登录服务: ${e?.message ?? e}` }
            }
            if (!entry) return { type: "failed", error: "妙手登录服务未返回登录入口地址" }
            const url = new URL(entry)
            url.searchParams.set("sid", sid)
            url.searchParams.set("redirect", "http://127.0.0.1:9/catpaw-callback")
            return {
              url: url.href,
              instructions:
                "浏览器打开上面的妙手登录页并完成登录。成功后本插件会自动取到登录态（约几秒），无需粘贴任何东西。",
              method: "auto",
              callback: async () => {
                const deadline = Date.now() + 180_000
                while (Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, 1000))
                  try {
                    const res = await fetch(
                      `${PASSPORT_BASE}/api/gateway/passport/poll-token?sid=${sid}`,
                      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) },
                    )
                    const payload = await res.json().catch(() => null)
                    const t = typeof payload?.data === "string" ? payload.data.trim() : ""
                    if (t) {
                      let accountId = "妙手网页登录"
                      let uid = ""
                      try {
                        const u = await fetch(
                          `${PASSPORT_BASE}/api/gateway/passport/current-user`,
                          {
                            headers: { Accept: "application/json", "X-Auth-Token": t },
                            signal: AbortSignal.timeout(10_000),
                          },
                        )
                        const p = await u.json().catch(() => null)
                        const d = p?.data
                        if (d) {
                          uid = String(d.userId ?? "")
                          if (d.userName) accountId = d.userName
                        }
                      } catch {}
                      return {
                        type: "success",
                        refresh: "",
                        access: t,
                        expires: 0,
                        accountId,
                        ...(uid ? { uid } : {}),
                        source: "web",
                      }
                    }
                  } catch {}
                }
                return { type: "failed", error: "网页登录超时（3 分钟内未取到登录态），请重试" }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "手动粘贴 token（Paste accessToken）",
          prompts: [
            {
              type: "password",
              key: "token",
              message: "accessToken（妙手 auth.json 里的 auth.accessToken）",
              validate: (v) => (v && v.trim() ? undefined : "必填"),
            },
          ],
          authorize: async (inputs) => {
            const token = String(inputs?.token ?? "").trim()
            if (!token) return { type: "failed", error: "token 必填" }
            return {
              type: "success",
              refresh: "",
              access: token,
              expires: 0,
              accountId: "手动粘贴",
              source: "manual",
            }
          },
        },
      ],
    },

    // The account's own list: the table plus what the vendor serves today.
    // magpie calls this once per account, and again when the user reloads the
    // provider. Returning provider.models unchanged keeps the old list.
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const have = provider?.models ?? {}
        let token
        try {
          token = (await resolveToken(async () => auth ?? null)).token
        } catch {
          return have
        }
        const live = await liveListFor(token)
        if (!live) return have
        const extra = Object.fromEntries(
          Object.entries(live)
            .filter(([id]) => !(id in have))
            .map(([id, m]) => [id, configModel(id, { ...MODELS[id], ...m })]),
        )
        // a model the table knows gets the list's rate and free mark, unless
        // the user's own config already set one
        const known = Object.fromEntries(
          Object.entries(have).map(([id, m]) => {
            const l = live[id]
            if (!l) return [id, m]
            return [
              id,
              {
                ...m,
                ...(l.rate !== undefined && m.rate === undefined ? { rate: l.rate } : {}),
                ...(l.free && m.free === undefined ? { free: true } : {}),
              },
            ]
          }),
        )
        return { ...known, ...extra }
      },
    },

    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: ORIGIN,
        ...was,
        models: {
          ...Object.fromEntries(Object.keys(MODELS).map((id) => [id, configModel(id)])),
          ...(was.models ?? {}),
        },
      }
    },
  }
}

// The last user turn is what a continuing conversation sends. The server keeps
// the earlier history, so sending it again would duplicate it.
function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "user") return messages[i]
  }
  return messages[0]
}

// A stable key for one conversation: magpie does not hand a session id to the
// provider fetch, so the opening user message is used. Consecutive rounds in a
// chat repeat the same opening message, which keeps the key stable.
function chatId(chat) {
  const first = (chat.messages ?? []).find((m) => m.role === "user")
  const text = contentToText(first?.content).slice(0, 200)
  return text || "session"
}

// for tests
export const _internal = {
  ID,
  NAME,
  MODELS,
  modelTypeOf,
  isKnownModel,
  configModel,
  liveModels,
  liveListFor,
  rateOf,
  forgetLive: () => {
    liveLists.clear()
    liveTypes.clear()
  },
  authCandidates,
  rateLimitSecondsLeft,
  noteRateLimit,
  forgetRateLimit: () => {
    limitedUntil = 0
  },
  fromOpenAI,
  toToolConfigs,
  contentToText,
  normalizeUserContent,
  makeDiffer,
  gatewayHeaders,
  readAuth,
  authPath,
  chatId,
  lastUserMessage,
}
