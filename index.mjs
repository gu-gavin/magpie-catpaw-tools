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
const NAME = "妙手 CatPaw · 原生工具调用"

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
  "longcat-2.5": { name: "LongCat-2.5", type: 107, context: 1048576, output: 131072, reasoning: true, image: true },
  "longcat-2.0": { name: "LongCat-2.0", type: 77, context: 1048576, output: 131072, reasoning: true, image: true },
  "glm-5.3": { name: "GLM-5.3", type: 89, context: 1000000, output: 131072, reasoning: true, image: false },
  "glm-5.3-flash": { name: "GLM-5.3-Flash", type: 91, context: 1000000, output: 131072, reasoning: true, image: true },
  "glm-5.3-flashx": { name: "GLM-5.3-FlashX", type: 98, context: 1000000, output: 131072, reasoning: true, image: true },
  "deepseek-v4.1-flash": { name: "DeepSeek-V4.1-Flash", type: 97, context: 1000000, output: 384000, reasoning: true, image: true },
  "deepseek-v4-pro": { name: "DeepSeek-V4-Pro", type: 64, context: 1000000, output: 384000, reasoning: true, image: false },
  "minimax-m3.1-flash": { name: "MiniMax-M3.1-Flash", type: 10002518, context: 1000000, output: 524288, reasoning: true, image: false },
  "minimax-m3": { name: "MiniMax-M3", type: 70, context: 1000000, output: 524288, reasoning: true, image: true },
  "kimi-k3.1-pro": { name: "Kimi-K3.1-Pro", type: 10002533, context: 1048576, output: 131072, reasoning: true, image: true },
  "kimi-k3": { name: "Kimi-K3", type: 83, context: 1048576, output: 131072, reasoning: true, image: true },
  "auto": { name: "Auto (妙手自动选择)", type: 0, context: 1000000, output: 131072, reasoning: true, image: false },
}

// the vendor's own id wins when the live list has it: modelTypeIds get
// renumbered (LongCat-2.5 moved 10002544 → 107 in 2026-11), and the table's
// snapshot is only a fallback for when the list cannot be read
const modelTypeOf = (id) => liveTypes.get(id) ?? MODELS[id]?.type ?? MODELS["longcat-2.0"].type

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
    modalities: {
      input: base.image ? ["text", "image"] : ["text"],
      output: ["text"],
    },
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

// One place that turns a failed step into the right status: the vendor reports
// a spent balance and an expired login as ordinary error text, and a 429 must
// carry Retry-After so the host backs off instead of retrying in place.
function stepError(e) {
  if (e?.httpStatus === 429) return rateLimitedError(noteRateLimit())
  const detail = String(e?.message ?? e)
  if (e?.quota || QUOTA_GATE.test(detail)) return quotaResponse(detail)
  if (e?.httpStatus === 401) return signInError(detail)
  if (e?.httpStatus === 402) return quotaResponse(detail)
  return errorResponse(e?.httpStatus >= 400 && e?.httpStatus < 500 ? e.httpStatus : 502, detail, e?.httpStatus === 401 ? "authentication_error" : "api_error")
}

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
      ...(r.supportImage === true ? { image: true } : {}),
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

const errorResponse = (
  status,
  message,
  type = "invalid_request_error",
  headers = {},
  fields = {},
) => json(status, { error: { message, type, code: null, param: null, ...fields } }, headers)

// magpie reads this header as "the sign-in is gone, stop retrying": without it
// an expired token looks like an ordinary upstream failure.
const SIGN_IN_HEADERS = { "X-Magpie-Sign-In": "expired" }
const signInError = (message) =>
  errorResponse(401, message, "authentication_error", SIGN_IN_HEADERS)

// 妙手 reports a spent balance as an ordinary error string rather than a 402.
// Mapping it keeps hosts from retrying a request that can never succeed.
const QUOTA_GATE = /余额不足|insufficient\s*(?:credit|quota|balance)/i
const PLAN_URL = "https://credit.catpaw.meituan.com/#/plan"

// The gate's sentence carries a markdown link, which most agents print as
// plain text; spell it out and keep the URL in a field they can use.
function quotaResponse(detail) {
  const upstream = String(detail ?? "").trim().slice(0, 300)
  const message = upstream.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
  const help = upstream.match(/https?:\/\/[^)\s]+/)?.[0] ?? PLAN_URL
  return errorResponse(
    402,
    message || "妙手账户余额不足",
    "insufficient_quota",
    {},
    { code: "insufficient_credits", help_url: help, upstream_message: upstream },
  )
}

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
  // A pasted/enved token is the escape hatch when the desktop client isn't
  // signed in but the user still has an accessToken to hand over.
  const pasted = process.env.CATPAW_TOKEN?.trim()
  if (pasted) return { token: pasted, name: "手动粘贴" }

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
        const said = `妙手 SSE 错误：${frame.error.message ?? JSON.stringify(frame.error)}`
        throw Object.assign(new Error(said), {
          unifyCode: frame.error.unifyCode,
          code: frame.error.code,
          quota: QUOTA_GATE.test(said),
        })
      }
      if (frame.message) {
        // the credit gate can also arrive as ordinary assistant text, in
        // frames that name no model (every real model's frame carries one)
        const said = (frame.message.content ?? []).map((c) => c.text ?? "").join("")
        if (frame.message.model == null && QUOTA_GATE.test(said)) {
          throw Object.assign(new Error(said), { quota: true })
        }
        yield frame.message
      }
    }
  }
}

// ── images ─────────────────────────────────────────────────────────────────
//
// round/turn take image parts directly: `{ type: "image_url", imageUrl: { url } }`,
// where url is an https link on the same S3 the desktop client uploads to. The
// bytes never go inline — a data: URI in `imageUrl.url` is stored but not shown
// to the model, so the picture is uploaded first and only the link is sent.
//
// The shape was measured 2026-11-25 on LongCat-2.5: `{type:"image"}` with the
// same imageUrl, or a bare string in `imageUrl`, is accepted by the JSON parser
// but never reaches the model (it answers "no image attached"). Only
// `type: "image_url"` + `imageUrl: { url }` does.

// Image parts of the *latest* user turn. Earlier turns are already in the
// server-side history, so re-sending their pictures would duplicate them.
function lastUserImages(chat) {
  const out = []
  for (let i = (chat.messages ?? []).length - 1; i >= 0; i--) {
    const msg = chat.messages[i]
    if (msg?.role !== "user") continue
    if (!Array.isArray(msg.content)) break
    for (const part of msg.content) {
      if (part?.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
        if (url) out.push(url)
      } else if (part?.type === "image") {
        const src = part.source
        if (!src) continue
        if (src.type === "base64") {
          const mime = src.media_type || src.mediaType || "image/png"
          const data = src.data ?? src.src
          if (data) out.push(String(data).startsWith("data:") ? String(data) : `data:${mime};base64,${data}`)
        } else if (src.url) {
          out.push(src.url)
        }
      }
    }
    break
  }
  return out
}

// uploadImage puts the bytes on the same S3 the desktop client uses and returns
// a URL the model can fetch. Data URIs are uploaded; http(s) URLs are reused.
async function uploadImage(token, url, conversationId) {
  if (/^https?:\/\//i.test(url)) return url
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!m) throw new Error("妙手 CatPaw: 图片必须是 data: URI 或 http(s) 链接")
  const mime = m[1] || "image/png"
  const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "binary")
  const name = `image-${Date.now()}.${(mime.split("/")[1] || "png").replace("jpeg", "jpg")}`
  const q = new URLSearchParams({ fileName: name, fileType: mime, conversationId })
  const res = await fetch(`${PASSPORT_BASE}/api/gateway/v1/s3/upload-image?${q}`, {
    method: "POST",
    headers: { "X-Auth-Token": token, "content-type": "text/plain" },
    body: bytes.toString("base64"),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await res.json().catch(() => null)
  const uploaded = payload?.data?.url
  if (res.status !== 200 || !uploaded) {
    throw new Error(
      `妙手图片上传失败：HTTP ${res.status} ${JSON.stringify(payload ?? {}).slice(0, 200)}`,
    )
  }
  return uploaded
}

// withImages returns the user message carrying the uploaded pictures. A message
// that is already in CatPaw's shape gets the parts appended; a plain one is
// wrapped.
//
// The id must be new: the same `messageId` was already sent to `round`, and the
// server answers a turn that repeats it by rebuilding the message from the
// stored round — pictures dropped. Measured 2026-11-25: same id → "没有看到图片
// 附件", fresh id → the picture is read.
function withImages(message, urls) {
  if (urls.length === 0) return message
  const parts = Array.isArray(message.content) ? [...message.content] : []
  if (parts.length === 0) {
    const text = typeof message.content === "string" ? message.content : ""
    if (text) parts.push({ type: "text", text })
  }
  for (const url of urls) parts.push({ type: "image_url", imageUrl: { url } })
  return { ...message, messageId: uuid(), content: parts }
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
      // The official 妙手 mark, inlined so the provider row has a picture with
      // nothing to fetch. magpie takes an https:// URL or a data: URI here;
      // auth.icon wins over the shared "magpie": { "icon": … } in package.json,
      // which carries the same string for the Discover card.
      icon:
        "data:image/webp;base64,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",

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
              if (e instanceof SignedOut) return signInError(String(e.message))
              return errorResponse(502, String(e?.message ?? e), "api_error")
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
            // Only remembered once the server has accepted the conversation:
            // a failed `round` must not leave a dead id behind, or every later
            // turn would skip `round` and stream into nothing.
            if (fresh) conversationId = uuid()

            // The server keeps the chat history, so each round sends only the
            // new message: the opening one for a fresh conversation, the tool
            // result (or the latest user turn) afterwards. Re-sending the whole
            // list would duplicate it.
            const messageToSend = continuing ? tail : lastUserMessage(messages)

            // Pictures ride on the *turn* message. `round` only stores what it
            // is given; an image part sent there lands in the history but the
            // model never sees it. A turn message carrying
            // `{type:"image_url", imageUrl:{url}}` is the shape the model does
            // read, so the bytes are uploaded first and only the link is sent.
            // Tool continuations carry no pictures: the opening turn already
            // put them in the server-side history.
            const images = continuing ? [] : lastUserImages(chat)
            let turnMessage = messageToSend
            if (images.length > 0) {
              const urls = []
              try {
                for (const img of images) urls.push(await uploadImage(token, img, conversationId))
              } catch (e) {
                return errorResponse(400, String(e?.message ?? e))
              }
              turnMessage = withImages(messageToSend, urls)
            }

            // `round` only ever succeeds on a fresh conversation. The server
            // keeps a conversation "running" after the first turn and answers
            // every later round with 1004010010 "会话正在执行中，无法创建新轮次"
            // (turn-end does not close it either), yet `turn` on its own keeps
            // working and stores the message. So the opening turn registers the
            // round, and later turns go straight to the stream.
            if (fresh) {
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
                if (QUOTA_GATE.test(round.text)) return quotaResponse(round.text)
                // `round` reports a dead token as 401 with its own envelope;
                // passing that through as a 502 would send the host retrying
                // instead of asking the user to sign in again.
                if (round.status === 401 || /passport auth failed|请重新登录/.test(round.text)) {
                  return signInError(`妙手登录态已失效：${round.text.slice(0, 300)}`)
                }
                // status 0 means the call never landed (network, timeout): going
                // on to open the stream would fail with a much less useful error
                return errorResponse(
                  502,
                  `妙手 round 失败：HTTP ${round.status} ${round.text.slice(0, 300)}`,
                  "api_error",
                )
              }

              // The round landed, so the conversation exists: from here on
              // later turns stream into it without another `round`.
              conversations.set(sessionKey, conversationId)

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
                      message: turnMessage,
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
                    // say it in the frame instead, with the same typing the
                    // non-streaming path would have used
                    const mapped = stepError(e)
                    const body = await mapped.json().catch(() => null)
                    const upstream = body?.error ?? {}
                    const error = {
                      message: upstream.message ?? String(e?.message ?? e),
                      ...(upstream.type ? { type: upstream.type } : {}),
                      ...(upstream.code ? { code: upstream.code } : {}),
                      ...(mapped.status === 402 ? { code: "insufficient_credits" } : {}),
                    }
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify({ error })}\n\n`),
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
                message: turnMessage,
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
              return stepError(e)
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
        // a model the table knows gets the list's rate, free mark and image
        // support, unless the user's own config already set one
        const known = Object.fromEntries(
          Object.entries(have).map(([id, m]) => {
            const l = live[id]
            if (!l) return [id, m]
            const wantsImage = l.image === true && !(m.modalities?.input ?? []).includes("image")
            return [
              id,
              {
                ...m,
                ...(wantsImage
                  ? { modalities: { ...m.modalities, input: ["text", "image"], output: ["text"] } }
                  : {}),
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
  lastUserImages,
  withImages,
  stepError,
}
