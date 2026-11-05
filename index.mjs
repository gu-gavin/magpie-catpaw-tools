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
      // The official 妙手 mark, inlined so the provider row has a picture with
      // nothing to fetch. magpie takes an https:// URL or a data: URI here;
      // auth.icon wins over the shared "magpie": { "icon": … } in package.json,
      // which carries the same string for the Discover card.
      icon:
        "data:image/jpeg;base64,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",

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
