const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")
const { test } = require("node:test")
const vm = require("node:vm")

function loadPlugin() {
    const messages = []
    const listeners = new Set()
    const timers = new Map()
    let requests = 0
    const parent = { postMessage: (message) => messages.push(message) }
    const window = {
        parent,
        location: { origin: "https://example.test", search: "?aiScopeDebug=1" },
        addEventListener: (event, listener) => listeners.add(listener),
        removeEventListener: (event, listener) => listeners.delete(listener),
    }
    const ui = {
        editor: { graph: { getSelectionModel: () => ({ addListener() {} }) } },
        actions: { addAction() {} },
        menus: { createPopupMenu() {} },
    }
    vm.runInNewContext(readFileSync(resolve(__dirname, "../drawio-custom/plugins/ai-scope.js"), "utf8"), {
        window,
        location: window.location,
        Draw: { loadPlugin: (callback) => callback(ui) },
        mxEvent: { CHANGE: "change" },
        setTimeout: (callback, delay) => { timers.set(callback, delay); return callback },
        clearTimeout: (callback) => timers.delete(callback),
        fetch: () => { requests += 1; throw new Error("Unexpected direct request") },
    })
    return { window, parent, listeners, timers, messages, requests: () => requests }
}

test("slow parent responses do not trigger a second API request", async () => {
    const plugin = loadPlugin()
    const result = plugin.window.__aiScope.callInstruct("<xml/>", ["selected"], "变绿", {})
    const request = plugin.messages.find((message) => message.type === "aiScopeProxyRequest")
    assert.ok(request)
    assert.equal([...plugin.timers.values()].some((delay) => delay <= 5000), false)
    const listener = [...plugin.listeners][0]
    listener({ source: {}, data: { type: "aiScopeProxyResponse", requestId: request.requestId, ok: true } })
    assert.equal(plugin.listeners.size, 1)
    listener({ source: plugin.parent, data: { type: "aiScopeProxyResponse", requestId: request.requestId, ok: true, status: 200, body: { ready: true } } })
    assert.equal((await result).body.ready, true)
    assert.equal(plugin.requests(), 0)
    assert.equal(plugin.listeners.size, 0)
    assert.equal(plugin.timers.size, 0)
})

test("timeout reports failure without retrying or leaving listeners", async () => {
    const plugin = loadPlugin()
    const result = plugin.window.__aiScope.callInstruct("<xml/>", ["selected"], "变绿", {})
    const rejected = assert.rejects(result, /未自动重复提交/)
    for (const callback of plugin.timers.keys()) callback()
    await rejected
    assert.equal(plugin.requests(), 0)
    assert.equal(plugin.listeners.size, 0)
    assert.equal(plugin.timers.size, 0)
})
