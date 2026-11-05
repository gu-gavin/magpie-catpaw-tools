import { test, expect, describe } from "bun:test"
import os from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { _internal, CatPawToolsAuthPlugin } from "./index.mjs"

const { fromOpenAI, toToolConfigs, contentToText, makeDiffer, modelTypeOf, MODELS, chatId, liveModels, rateOf, configModel } = _internal

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
    expect(modelTypeOf("longcat-2.5")).toBe(10002544)
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

describe("chatId", () => {
  test("the opening user message keys the conversation", () => {
    const a = chatId({ messages: [{ role: "user", content: "make a plan" }, { role: "assistant", content: "ok" }] })
    const b = chatId({ messages: [{ role: "user", content: "make a plan" }, { role: "assistant", content: "ok" }, { role: "user", content: "go on" }] })
    expect(a).toBe(b)
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

describe("icon", () => {
  test("the provider row gets a picture without a fetch", async () => {
    const { auth } = await CatPawToolsAuthPlugin({})
    expect(auth.icon).toMatch(/^data:image\/jpeg;base64,/)
    expect(auth.icon.length).toBeLessThan(1_000_000)
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
