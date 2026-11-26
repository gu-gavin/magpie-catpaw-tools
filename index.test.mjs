import { test, expect, describe } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { _internal, CatPawToolsAuthPlugin } from "./index.mjs"

const { fromOpenAI, toToolConfigs, contentToText, makeDiffer, modelTypeOf, MODELS, liveModels, rateOf, configModel } = _internal

describe("contentToText", () => {
  test("string passes through", () => {
    expect(contentToText("hello")).toBe("hello")
  })
  test("text parts are joined", () => {
    expect(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab")
  })
  test("null becomes empty", () => {
    expect(contentToText(null)).toBe("")
  })
})

describe("fromOpenAI", () => {
  test("system prompt is lifted out of the message list", () => {
    const { messages, systemPrompt } = fromOpenAI({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    })
    expect(systemPrompt).toBe("be terse")
    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe("user")
  })

  test("tool calls become tool_use with a JSON-string toolParams", () => {
    const { messages } = fromOpenAI({
      messages: [
        { role: "user", content: "read a file" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/x"}' } },
          ],
        },
      ],
    })
    const assistant = messages.find((m) => m.type === "assistant")
    expect(assistant.content[0]).toEqual({
      type: "tool_use",
      toolCallId: "call_1",
      toolName: "read_file",
      toolParams: '{"path":"/x"}',
    })
  })

  test("consecutive tool results merge into one tool message", () => {
    const { messages } = fromOpenAI({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "a", content: "1" },
        { role: "tool", tool_call_id: "b", content: "2" },
      ],
    })
    const tools = messages.filter((m) => m.type === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0].content).toHaveLength(2)
    expect(tools[0].content[1].toolCallId).toBe("b")
  })
})

describe("toToolConfigs", () => {
  test("enable and fromClient are always set", () => {
    const out = toToolConfigs([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ])
    expect(out[0]).toEqual({
      name: "read_file",
      enable: true,
      description: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      fromClient: true,
    })
  })

  test("enable is true even when description and schema are missing", () => {
    const out = toToolConfigs([{ function: { name: "bare" } }])
    expect(out[0]).toEqual({ name: "bare", enable: true, fromClient: true })
  })

  test("the server's own tools are sent with enable: false", () => {
    // it does not actually disable them (measured 2026-11-05); it is the only
    // lever there is, and no agent tool may take one of these names
    const out = toToolConfigs([])
    const byName = Object.fromEntries(out.map((c) => [c.name, c]))
    expect(byName.read_file).toEqual({ name: "read_file", enable: false })
    expect(byName.bash).toEqual({ name: "bash", enable: false })
    expect(out.every((c) => c.enable === false)).toBe(true)
  })

  test("a tool the agent defines wins over the same-named server tool", () => {
    const out = toToolConfigs([{ function: { name: "read_file", parameters: {} } }])
    const mine = out.filter((c) => c.name === "read_file")
    expect(mine).toHaveLength(1)
    expect(mine[0].enable).toBe(true)
    expect(mine[0].fromClient).toBe(true)
  })

  test("no name appears twice", () => {
    const out = toToolConfigs([{ function: { name: "bash" } }, { function: { name: "mine" } }])
    const names = out.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("makeDiffer", () => {
  test("cumulative frames yield only the new tail", () => {
    const d = makeDiffer()
    expect(d.text("m", "")).toBe(null)
    expect(d.text("m", "你")).toBe("你")
    expect(d.text("m", "你好")).toBe("好")
    expect(d.text("m", "你好")).toBe(null)
  })

  test("toolParams arriving in pieces are diffed the same way", () => {
    const d = makeDiffer()
    expect(d.params("c", '{"text":')).toBe('{"text":')
    expect(d.params("c", '{"text": "hi"')).toBe(' "hi"')
    expect(d.params("c", '{"text": "hi"}')).toBe("}")
  })

  test("a rewritten frame is resent whole rather than lost", () => {
    const d = makeDiffer()
    d.text("m", "abcdef")
    expect(d.text("m", "xyz")).toBe("xyz")
  })
})

describe("models", () => {
  test("every model declares a numeric type and a real context window", () => {
    for (const [id, m] of Object.entries(MODELS)) {
      expect(typeof m.type).toBe("number")
      expect(m.context).toBeGreaterThan(0)
      expect(m.output).toBeGreaterThan(0)
      void id
    }
  })

  test("modelType ids are the ones the gateway was measured to accept", () => {
    // read off POST /api/agent/maas/model-types on 2026-11-05
    expect(modelTypeOf("longcat-2.5")).toBe(107)
    expect(modelTypeOf("longcat-2.0")).toBe(77)
    expect(modelTypeOf("glm-5.3")).toBe(89)
    expect(modelTypeOf("glm-5.3-flash")).toBe(91)
    expect(modelTypeOf("glm-5.3-flashx")).toBe(98)
    expect(modelTypeOf("deepseek-v4.1-flash")).toBe(97)
    expect(modelTypeOf("deepseek-v4-pro")).toBe(64)
    expect(modelTypeOf("minimax-m3.1-flash")).toBe(10002518)
    expect(modelTypeOf("minimax-m3")).toBe(70)
    expect(modelTypeOf("kimi-k3.1-pro")).toBe(10002533)
    expect(modelTypeOf("kimi-k3")).toBe(83)
  })

  test("an unknown model falls back to LongCat instead of throwing", () => {
    expect(modelTypeOf("nope")).toBe(77)
  })
})

describe("images", () => {
  const { lastUserImages, withImages } = _internal

  test("only the newest user turn's pictures are collected", () => {
    const chat = {
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }, { type: "image_url", image_url: { url: "https://a/old.png" } }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "new" }, { type: "image_url", image_url: { url: "https://a/new.png" } }] },
      ],
    }
    expect(lastUserImages(chat)).toEqual(["https://a/new.png"])
  })

  test("a base64 image part becomes a data URI", () => {
    const chat = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
        },
      ],
    }
    expect(lastUserImages(chat)).toEqual(["data:image/png;base64,AAA"])
  })

  test("no pictures means no parts", () => {
    expect(lastUserImages({ messages: [{ role: "user", content: "plain" }] })).toEqual([])
  })

  // measured 2026-11-25: reusing the round's messageId makes the server rebuild
  // the message from the stored round, dropping the pictures
  test("the image-bearing turn gets a fresh messageId", () => {
    const msg = withImages({ type: "user", messageId: "same", content: [{ type: "text", text: "hi" }], finished: true }, ["https://a/x.png"])
    expect(msg.messageId).not.toBe("same")
    expect(msg.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image_url", imageUrl: { url: "https://a/x.png" } },
    ])
  })

  test("with no pictures the message is untouched", () => {
    const msg = { type: "user", messageId: "same", content: [{ type: "text", text: "hi" }], finished: true }
    expect(withImages(msg, [])).toBe(msg)
  })
})

describe("configModel image modality", () => {
  test("a model that reads pictures declares image input", () => {
    expect(configModel("longcat-2.5").modalities.input).toEqual(["text", "image"])
  })
  test("a text-only model does not", () => {
    expect(configModel("glm-5.3").modalities.input).toEqual(["text"])
  })
})

describe("lastUserMessage", () => {
  const { lastUserMessage } = _internal

  test("a continuing chat sends only its newest user turn", () => {
    const { messages } = fromOpenAI({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    })
    expect(lastUserMessage(messages).content[0].text).toBe("second")
  })

  test("the server keeps the history, so earlier turns are not resent", () => {
    const { messages } = fromOpenAI({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    })
    expect(messages).toHaveLength(3)
    expect(lastUserMessage(messages)).not.toBe(messages[0])
  })
})

describe("conversation store", () => {
  test("persists mappings across plugin host restarts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "catpaw-conversations-"))
    try {
      _internal.createConversationStore(dir).set("account/session", "conversation-1")
      expect(_internal.createConversationStore(dir).get("account/session")).toBe("conversation-1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("expires old mappings", () => {
    let now = 1_000
    const store = _internal.createConversationStore(undefined, { now: () => now, ttl: 100 })
    store.set("key", "conversation-1")
    now = 1_099
    expect(store.get("key")).toBe("conversation-1")
    now = 1_100
    expect(store.get("key")).toBeUndefined()
  })

  test("keeps only the newest mappings up to its cap", () => {
    let now = 1_000
    const store = _internal.createConversationStore(undefined, { now: () => now, max: 2 })
    store.set("first", "one")
    now++
    store.set("second", "two")
    now++
    store.set("third", "three")
    expect(store.get("first")).toBeUndefined()
    expect(store.get("second")).toBe("two")
    expect(store.get("third")).toBe("three")
  })
})

describe("icon", () => {
  test("the provider row gets a picture without a fetch", async () => {
    const { auth } = await CatPawToolsAuthPlugin({})
    expect(auth.icon).toMatch(/^data:image\/webp;base64,/)
    expect(auth.icon.length).toBeLessThan(1_000_000)
  })

  // magpie draws plugin icons as rounded squares — the other few hundred in its
  // icon cache have transparent corners with a radius near a fifth of the
  // width. A plain square source shows up as a hard tile beside them, so this
  // one is masked before it is encoded. Reading the header is enough to know
  // the alpha channel survived; there is no image decoder here to look at.
  test("the icon carries an alpha channel, so its corners can be round", async () => {
    const { auth } = await CatPawToolsAuthPlugin({})
    const bytes = Buffer.from(auth.icon.split(",", 2)[1], "base64")
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF")
    expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP")
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("VP8X") // extended, not plain VP8
    expect(bytes[20] & 0x10).toBe(0x10) // the alpha flag
    expect(bytes[24] + 1).toBe(256) // canvas width, stored as width - 1
  })

  // Discover draws a plugin's card from "magpie": { "icon": … } in package.json
  // and a puzzle piece when it is absent — the auth.icon above covers the
  // provider row only, so both have to be there and they should agree.
  test("the card gets the same picture as the provider row", async () => {
    const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
    const { auth } = await CatPawToolsAuthPlugin({})
    expect(pkg.magpie.icon).toBe(auth.icon)
  })
})

describe("liveModels", () => {
  // one row of each kind the gateway sends: a model the table knows, one it
  // cannot (added since the table was written), and the user's own model
  const rows = [
    {
      modelTypeId: 10002544,
      modelTypeName: "LongCat-2.5",
      supportImage: true,
      extendedInfo: { rateMultiplier: 0, marketingCopy: "限时免费" },
    },
    {
      modelTypeId: 999999,
      modelTypeName: "GLM-6 Turbo",
      extendedInfo: { rateMultiplier: "0.42x" },
    },
    { modelTypeId: -1, modelTypeName: "我的自建模型", provider: "USER_CUSTOM" },
  ]

  test("the vendor's list is keyed by the ids the table already uses", () => {
    expect(liveModels(rows)["longcat-2.5"]).toEqual({
      name: "LongCat-2.5",
      type: 10002544,
      image: true,
      rate: 0,
      free: true,
    })
  })

  test("a model the table doesn't know still arrives, vendor-named", () => {
    expect(liveModels(rows)["glm-6-turbo"]).toEqual({
      name: "GLM-6 Turbo",
      type: 999999,
      rate: 0.42,
    })
  })

  test("a custom model of the user's own isn't offered", () => {
    expect(Object.keys(liveModels(rows))).toHaveLength(2)
  })
})

describe("rateOf", () => {
  test("reads the client's multiplier, and says nothing when there is none", () => {
    expect(rateOf(0)).toBe(0)
    expect(rateOf("0.42x")).toBe(0.42)
    expect(rateOf("abc")).toBeUndefined()
    expect(rateOf(undefined)).toBeUndefined()
  })
})

describe("configModel", () => {
  test("a model the table cannot describe still gets limits", () => {
    const m = configModel("brand-new")
    expect(m.limit.context).toBe(1000000)
    expect(m.tool_call).toBe(true)
  })
})

describe("account model catalogs", () => {
  test("model types and availability stay scoped to their account", async () => {
    _internal.forgetLive()
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify([
      { modelTypeId: 901, modelTypeName: "Shared Model" },
      { modelTypeId: 903, modelTypeName: "Only A" },
    ]), { status: 200 })
    try {
      await _internal.liveListFor("account-a")
      globalThis.fetch = async () => new Response(JSON.stringify([
        { modelTypeId: 902, modelTypeName: "Shared Model" },
      ]), { status: 200 })
      await _internal.liveListFor("account-b")
      expect(modelTypeOf("shared-model", "account-a")).toBe(901)
      expect(modelTypeOf("shared-model", "account-b")).toBe(902)
      expect(_internal.isKnownModel("only-a", "account-a")).toBe(true)
      expect(_internal.isKnownModel("only-a", "account-b")).toBe(false)
    } finally {
      globalThis.fetch = real
      _internal.forgetLive()
    }
  })
})

describe("authCandidates", () => {
  const { authCandidates, authPath } = _internal

  // the env is global state; every test here puts it back
  function withEnv(vars, fn) {
    const saved = {}
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      return fn()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  test("an explicit auth path wins, and is trusted even before it exists", () => {
    withEnv(
      { CATPAW_AUTH_PATH: "/nowhere/auth.json", MEITUAN_AUTH_PATH: undefined, CATPAW_DATA_DIR: undefined },
      () => {
        expect(authCandidates()).toEqual(["/nowhere/auth.json"])
        expect(authPath()).toBe("/nowhere/auth.json")
      },
    )
  })

  test("the other catpaw plugin's env names still work", () => {
    withEnv({ CATPAW_AUTH_PATH: undefined, MEITUAN_AUTH_PATH: "/m/auth.json" }, () => {
      expect(authCandidates()).toEqual(["/m/auth.json"])
    })
    withEnv(
      { CATPAW_AUTH_PATH: undefined, MEITUAN_AUTH_PATH: undefined, MEITUAN_DATA_DIR: "/m/data" },
      () => {
        expect(authCandidates()[0]).toBe(path.join("/m/data", "auth.json"))
      },
    )
  })

  test("Windows reads %APPDATA%, which is where this app family stores it", () => {
    withEnv(
      { CATPAW_AUTH_PATH: undefined, MEITUAN_AUTH_PATH: undefined, CATPAW_DATA_DIR: undefined, APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
      () => {
        const want = path.join("C:\\Users\\x\\AppData\\Roaming", ".meituan-catpaw", "auth.json")
        expect(authCandidates()).toContain(want)
      },
    )
  })

  test("macOS and Linux fall back to the home directory", () => {
    withEnv(
      { CATPAW_AUTH_PATH: undefined, MEITUAN_AUTH_PATH: undefined, CATPAW_DATA_DIR: undefined, APPDATA: undefined, LOCALAPPDATA: undefined },
      () => {
        const want = path.join(os.homedir(), ".meituan-catpaw", "auth.json")
        expect(authCandidates()).toContain(want)
        expect(authPath()).toBe(want) // nothing else exists in this environment
      },
    )
  })
})

describe("usage identity", () => {
  test("the balance card names the account that supplied the token", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "catpaw-usage-"))
    const authPath = path.join(dir, "auth.json")
    writeFileSync(authPath, JSON.stringify({
      auth: { accessToken: "desktop-token" },
      account: { uid: "desktop", name: "Desktop User" },
    }))
    const savedPath = process.env.CATPAW_AUTH_PATH
    const savedToken = process.env.CATPAW_TOKEN
    const real = globalThis.fetch
    process.env.CATPAW_AUTH_PATH = authPath
    delete process.env.CATPAW_TOKEN
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 0,
      data: { availableCredits: 12.5, userPlan: { planName: "Trial" } },
    }), { status: 200 })
    try {
      const { auth } = await CatPawToolsAuthPlugin({})
      const web = await auth.usage(async () => ({ type: "oauth", source: "web", access: "web-token", name: "Web User" }))
      const manual = await auth.usage(async () => ({ type: "oauth", source: "manual", access: "manual-token" }))
      const desktop = await auth.usage(async () => ({ type: "oauth", source: "desktop", access: "ignored" }))
      expect(web.user).toBe("Web User")
      expect(manual.user).toBe("手动粘贴")
      expect(desktop.user).toBe("Desktop User")
      expect(web.windows).toEqual([{ name: "可用积分", balance: 12.5, unit: "credit" }])
    } finally {
      globalThis.fetch = real
      if (savedPath === undefined) delete process.env.CATPAW_AUTH_PATH
      else process.env.CATPAW_AUTH_PATH = savedPath
      if (savedToken === undefined) delete process.env.CATPAW_TOKEN
      else process.env.CATPAW_TOKEN = savedToken
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an invalid balance is an error rather than a question mark", async () => {
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 0,
      data: { availableCredits: "not-a-number" },
    }), { status: 200 })
    try {
      const { auth } = await CatPawToolsAuthPlugin({})
      const usage = await auth.usage(async () => ({ type: "oauth", source: "manual", access: "tok" }))
      expect(usage.error).toContain("有效的积分")
      expect(usage.signIn).toBe("kept")
      expect(usage.windows).toBeUndefined()
    } finally {
      globalThis.fetch = real
    }
  })
})

describe("rate limit", () => {
  const { noteRateLimit, rateLimitSecondsLeft, forgetRateLimit } = _internal

  async function callPlugin() {
    const { auth } = await CatPawToolsAuthPlugin({})
    const { fetch } = await auth.loader(async () => ({
      type: "oauth",
      source: "manual",
      access: "tok",
    }))
    return fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", messages: [{ role: "user", content: "hi" }] }),
    })
  }

  test("a request inside the cooldown is refused without going upstream", async () => {
    forgetRateLimit()
    const secs = noteRateLimit(60_000)
    expect(secs).toBeGreaterThan(0)
    expect(rateLimitSecondsLeft()).toBeGreaterThan(0)

    const res = await callPlugin()
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe(String(secs))
    expect((await res.json()).error.type).toBe("rate_limit_error")
    forgetRateLimit()
  })

  test("the window ends, and requests go through again", () => {
    forgetRateLimit()
    noteRateLimit(1) // a millisecond-long window rounds up to 1 second
    expect(rateLimitSecondsLeft()).toBeGreaterThanOrEqual(0)
    forgetRateLimit()
    expect(rateLimitSecondsLeft()).toBeLessThanOrEqual(0)
  })

  test("a 429 from the server opens the window instead of retrying", async () => {
    forgetRateLimit()
    const real = globalThis.fetch
    globalThis.fetch = async () =>
      new Response('{"code":429,"message":"too many requests"}', {
        status: 429,
        headers: { "content-type": "application/json" },
      })
    try {
      const res = await callPlugin()
      expect(res.status).toBe(429)
      expect(rateLimitSecondsLeft()).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = real
      forgetRateLimit()
    }
  })
})

describe("round", () => {
  // `round` only succeeds on a conversation's first turn. The server keeps the
  // conversation "running" forever after that (1004010010), so later turns skip
  // it and stream straight into `turn` — which keeps working and stores the
  // message. These tests pin both halves of that behaviour.
  function stub(handler) {
    const real = globalThis.fetch
    const seen = []
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url
      const path = url.replace(/^https?:\/\/[^/]+/, "")
      seen.push({ path, body: init?.body ? JSON.parse(init.body) : null })
      return handler(path, init)
    }
    return { seen, restore: () => { globalThis.fetch = real } }
  }

  // one plugin instance per test: the conversation map lives on it
  async function client(directory) {
    const { auth } = await CatPawToolsAuthPlugin({ directory })
    const { fetch } = await auth.loader(async () => ({ type: "oauth", source: "manual", access: "tok" }))
    return (messages, model = "longcat-2.0", headers = { "x-magpie-session": "test-session" }) =>
      fetch("https://x/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages }),
      })
  }

  const stream = (text) =>
    new Response(`data:${JSON.stringify({ message: { type: "assistant", messageId: "m", model: "x", content: [{ type: "text", text }] } })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })

  test("a dead token on round comes back as 401, not 502", async () => {
    _internal.forgetRateLimit()
    const s = stub(() =>
      new Response('{"unifyCode":1003010001,"code":401,"msg":"passport auth failed: 请重新登录"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    )
    try {
      const chat = await client()
      const res = await chat([{ role: "user", content: "hi" }])
      expect(res.status).toBe(401)
      expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
      expect((await res.json()).error.type).toBe("authentication_error")
    } finally {
      s.restore()
    }
  })

  test("only the first turn sends round; the next one goes straight to turn", async () => {
    _internal.forgetRateLimit()
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) {
        return new Response('{"unifyCode":0,"code":0,"data":{"conversationId":"c1"}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (path.endsWith("/conversation/event")) return new Response('{"unifyCode":0}', { status: 200 })
      return stream("收到")
    })
    try {
      const chat = await client()
      const first = [{ role: "user", content: "第一句" }]
      expect((await chat(first)).status).toBe(200)
      const roundsAfterFirst = s.seen.filter((r) => r.path.endsWith("/conversation/round")).length
      expect(roundsAfterFirst).toBe(1)

      // the same opening message keys the same conversation, so this is turn 2
      const second = [...first, { role: "assistant", content: "收到" }, { role: "user", content: "第二句" }]
      expect((await chat(second)).status).toBe(200)
      expect(s.seen.filter((r) => r.path.endsWith("/conversation/round")).length).toBe(roundsAfterFirst)
      expect(s.seen.filter((r) => r.path.endsWith("/conversation/turn")).length).toBe(2)
    } finally {
      s.restore()
    }
  })

  test("different sessions with the same opening message do not share a conversation", async () => {
    _internal.forgetRateLimit()
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":0}', { status: 200 })
      return stream("ok")
    })
    try {
      const chat = await client()
      const messages = [{ role: "user", content: "same opening" }]
      await chat(messages, "longcat-2.0", { "x-magpie-session": "session-a" })
      await chat(messages, "longcat-2.0", { "x-magpie-session": "session-b" })
      const rounds = s.seen.filter((r) => r.path.endsWith("/conversation/round"))
      const turns = s.seen.filter((r) => r.path.endsWith("/conversation/turn"))
      expect(rounds).toHaveLength(2)
      expect(new Set(turns.map((r) => r.body.conversationId)).size).toBe(2)
    } finally {
      s.restore()
    }
  })

  test("subagents of one session do not share a conversation", async () => {
    _internal.forgetRateLimit()
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":0}', { status: 200 })
      return stream("ok")
    })
    try {
      const chat = await client()
      const messages = [{ role: "user", content: "same opening" }]
      await chat(messages, "longcat-2.0", { "x-magpie-session": "lead", "x-magpie-subagent": "child-a" })
      await chat(messages, "longcat-2.0", { "x-magpie-session": "lead", "x-magpie-subagent": "child-b" })
      const turns = s.seen.filter((r) => r.path.endsWith("/conversation/turn"))
      expect(new Set(turns.map((r) => r.body.conversationId)).size).toBe(2)
    } finally {
      s.restore()
    }
  })

  test("requests without a session do not reuse a conversation", async () => {
    _internal.forgetRateLimit()
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":0}', { status: 200 })
      return stream("ok")
    })
    try {
      const chat = await client()
      const messages = [{ role: "user", content: "same opening" }]
      await chat(messages, "longcat-2.0", {})
      await chat(messages, "longcat-2.0", {})
      expect(s.seen.filter((r) => r.path.endsWith("/conversation/round"))).toHaveLength(2)
    } finally {
      s.restore()
    }
  })

  test("the same session on two accounts does not share a conversation", async () => {
    _internal.forgetRateLimit()
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":0}', { status: 200 })
      return stream("ok")
    })
    try {
      const { auth } = await CatPawToolsAuthPlugin({})
      let token = "account-a"
      const { fetch } = await auth.loader(async () => ({ type: "oauth", source: "manual", access: token }))
      const send = () => fetch("https://x/chat/completions", {
        method: "POST",
        headers: { "x-magpie-session": "shared-session" },
        body: JSON.stringify({ model: "longcat-2.0", messages: [{ role: "user", content: "same opening" }] }),
      })
      await send()
      token = "account-b"
      await send()
      const turns = s.seen.filter((r) => r.path.endsWith("/conversation/turn"))
      expect(new Set(turns.map((r) => r.body.conversationId)).size).toBe(2)
    } finally {
      s.restore()
    }
  })

  test("a restarted host resumes the persisted conversation", async () => {
    _internal.forgetRateLimit()
    const dir = mkdtempSync(path.join(os.tmpdir(), "catpaw-restart-"))
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":0}', { status: 200 })
      return stream("ok")
    })
    try {
      const first = await client(dir)
      const opening = [{ role: "user", content: "remember this" }]
      await first(opening)
      const second = await client(dir)
      await second([...opening, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }])
      expect(s.seen.filter((r) => r.path.endsWith("/conversation/round"))).toHaveLength(1)
      const turns = s.seen.filter((r) => r.path.endsWith("/conversation/turn"))
      expect(turns).toHaveLength(2)
      expect(new Set(turns.map((r) => r.body.conversationId)).size).toBe(1)
    } finally {
      s.restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failed round is not remembered, so a retry starts over", async () => {
    _internal.forgetRateLimit()
    let fail = true
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) {
        return fail
          ? new Response('{"code":500,"msg":"boom"}', { status: 500 })
          : new Response('{"unifyCode":0,"code":0,"data":{"conversationId":"c2"}}', { status: 200 })
      }
      if (path.endsWith("/conversation/event")) return new Response('{"unifyCode":0}', { status: 200 })
      return stream("好了")
    })
    try {
      const chat = await client()
      const messages = [{ role: "user", content: "会失败的第一句" }]
      expect((await chat(messages)).status).toBe(502)
      fail = false
      expect((await chat(messages)).status).toBe(200)
      expect(s.seen.filter((r) => r.path.endsWith("/conversation/round")).length).toBe(2)
    } finally {
      s.restore()
    }
  })

  test("an HTTP 200 round business error is not reported as success", async () => {
    _internal.forgetRateLimit()
    const s = stub(() => new Response('{"code":500,"msg":"boom"}', { status: 200 }))
    try {
      const res = await (await client())([{ role: "user", content: "hi" }])
      expect(res.status).toBe(502)
      expect((await res.json()).error.message).toContain("code=500")
    } finally {
      s.restore()
    }
  })

  test("round and SSE 401 errors mark the sign-in expired", async () => {
    _internal.forgetRateLimit()
    const round = stub(() => new Response('{"code":401,"msg":"token expired"}', { status: 200 }))
    try {
      const res = await (await client())([{ role: "user", content: "hi" }])
      expect(res.status).toBe(401)
      expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
    } finally {
      round.restore()
    }

    const sse = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":0}', { status: 200 })
      return new Response(`data: ${JSON.stringify({ error: { code: 401, message: "token expired" } })}\n\n`, { status: 200 })
    })
    try {
      const res = await (await client())([{ role: "user", content: "hi" }])
      expect(res.status).toBe(401)
      expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
    } finally {
      sse.restore()
    }
  })

  test("round 402 and SSE 429 keep their quota and rate-limit semantics", async () => {
    _internal.forgetRateLimit()
    const quota = stub(() => new Response('{"code":402,"msg":"payment required"}', { status: 200 }))
    try {
      const res = await (await client())([{ role: "user", content: "hi" }])
      expect(res.status).toBe(402)
      expect((await res.json()).error.type).toBe("insufficient_quota")
    } finally {
      quota.restore()
    }

    const limited = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":0}', { status: 200 })
      return new Response(`data: ${JSON.stringify({ error: { code: 429, message: "too many requests" } })}\n\n`, { status: 200 })
    })
    try {
      const res = await (await client())([{ role: "user", content: "hi" }])
      expect(res.status).toBe(429)
      expect(res.headers.get("retry-after")).toBeTruthy()
      expect(_internal.rateLimitSecondsLeft()).toBeGreaterThan(0)
    } finally {
      limited.restore()
      _internal.forgetRateLimit()
    }
  })

  test("an event failure stops before turn", async () => {
    _internal.forgetRateLimit()
    const s = stub((path) => {
      if (path.endsWith("/conversation/round")) return new Response('{"code":0}', { status: 200 })
      if (path.endsWith("/conversation/event")) return new Response('{"code":500,"msg":"boom"}', { status: 500 })
      return stream("should not run")
    })
    try {
      const res = await (await client())([{ role: "user", content: "hi" }])
      expect(res.status).toBe(502)
      expect(s.seen.some((r) => r.path.endsWith("/conversation/turn"))).toBe(false)
    } finally {
      s.restore()
    }
  })

  test("upstream Retry-After overrides the default cooldown", async () => {
    _internal.forgetRateLimit()
    const s = stub(() => new Response('{"code":429,"msg":"too many requests"}', {
      status: 429,
      headers: { "retry-after": "120" },
    }))
    try {
      const res = await (await client())([{ role: "user", content: "hi" }])
      expect(res.status).toBe(429)
      expect(res.headers.get("retry-after")).toBe("120")
    } finally {
      s.restore()
      _internal.forgetRateLimit()
    }
  })
})
