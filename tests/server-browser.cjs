const assert = require("node:assert/strict")
const { chromium } = require("playwright")

const appUrl = (process.env.APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "")
const accessCode = process.env.TEST_ACCESS_CODE || ""
const fixture = '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="selected" value="Selected" style="rounded=1;fillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell><mxCell id="untouched" value="Untouched" style="rounded=1;fillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="400" y="120" width="160" height="70" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'

async function main() {
    const browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    })
    try {
        const context = await browser.newContext({
            ignoreHTTPSErrors: process.env.TEST_IGNORE_HTTPS_ERRORS === "1",
            viewport: { width: 1400, height: 900 },
        })
        await context.addInitScript((code) => {
            if (code) localStorage.setItem("next-ai-draw-io-access-code", code)
            window.__deploymentMessages = []
            window.addEventListener("message", (event) => {
                try {
                    const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data
                    if (data?.event) window.__deploymentMessages.push(data)
                } catch {}
            })
        }, accessCode)
        const page = await context.newPage()
        let scopedRequests = 0
        const brokenResources = []
        const pageErrors = []
        const requests = []
        const navigations = []
        page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame()) navigations.push(frame.url())
        })
        page.on("pageerror", (error) => pageErrors.push(error.message))
        page.on("requestfailed", (request) => pageErrors.push(`${request.url()}: ${request.failure()?.errorText}`))
        page.on("console", (message) => {
            if (message.type() === "error") pageErrors.push(message.text())
        })
        page.on("request", (request) => requests.push(request.url()))
        page.on("response", (response) => {
            if (response.url().includes("/drawio/") && response.status() >= 400) {
                brokenResources.push(`${response.status()} ${response.url()}`)
            }
        })
        await page.route("**/api/scoped-edit", async (route) => {
            scopedRequests += 1
            await new Promise((resolve) => setTimeout(resolve, 6000))
            const response = await route.fetch()
            await route.fulfill({ response })
        })
        const entry = await page.goto(`${appUrl}/`, { waitUntil: "domcontentloaded" })
        assert.equal(entry.status(), 200, `Application entry failed: ${page.url()}`)
        const iframe = page.locator('iframe[src*="embed=1"]')
        await iframe.waitFor({ state: "attached", timeout: 60000 }).catch(async (error) => {
            console.error(JSON.stringify({ url: page.url(), pageErrors, brokenResources, navigations: navigations.slice(-8), requests: requests.slice(-8) }))
            throw error
        })
        const initialSource = await iframe.getAttribute("src")
        assert.equal(new URL(initialSource).origin, new URL(appUrl).origin)
        assert.equal(new URL(initialSource).pathname, `${new URL(appUrl).pathname.replace(/\/$/, "")}/drawio/index.html`)
        await page.waitForFunction(() => window.__deploymentMessages.some((message) => message.event === "aiScopeReady"), null, { timeout: 60000 }).catch(async (error) => {
            const states = await Promise.all(page.frames().map(async (frame) => ({ url: frame.url(), state: await Promise.race([frame.evaluate(() => ({ ready: document.readyState, draw: typeof Draw, editor: typeof EditorUi, text: document.body?.innerText.slice(0, 400) })).catch(() => null), new Promise((resolve) => setTimeout(() => resolve("evaluation timed out"), 3000))]) })))
            console.error(JSON.stringify({ pageErrors: pageErrors.slice(-12), brokenResources, states }))
            throw error
        })
        await iframe.evaluate((element) => { element.src += "&aiScopeDebug=1" })
        const frame = await (await iframe.elementHandle()).contentFrame()
        await frame.waitForFunction(() => !!window.__aiScope, null, { timeout: 60000 })
        assert.equal(await frame.evaluate(() => window.__aiScope.endpoint()), appUrl)
        await page.evaluate((xml) => {
            const element = document.querySelector('iframe[src*="embed=1"]')
            element.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), new URL(element.src).origin)
        }, fixture)
        await frame.waitForFunction(() => !!window.__aiScope.graph.getModel().getCell("selected"))
        await frame.evaluate(() => {
            const scope = window.__aiScope
            scope.graph.setSelectionCell(scope.graph.getModel().getCell("selected"))
            scope.openInstruct(null)
        })
        await frame.locator("#aiScopeInstructPanel textarea").fill("变绿")
        await frame.locator('[data-role="ai-scope-run"]').click()
        await frame.waitForFunction(() => window.__aiScope.graph.getModel().getCell("selected").style.includes("fillColor=#2f9e63"), null, { timeout: 30000 })
        assert.equal(scopedRequests, 1, "Slow requests must not be retried")
        const untouched = await frame.evaluate(() => {
            const cell = window.__aiScope.graph.getModel().getCell("untouched")
            return { value: cell.value, style: cell.style, x: cell.geometry.x }
        })
        assert.deepEqual(untouched, { value: "Untouched", style: "rounded=1;fillColor=#ffffff;", x: 400 })
        await page.evaluate(() => {
            const element = document.querySelector('iframe[src*="embed=1"]')
            element.contentWindow.postMessage(JSON.stringify({ action: "export", format: "xml" }), new URL(element.src).origin)
        })
        await page.waitForFunction(() => window.__deploymentMessages.some((message) => message.event === "export" && typeof message.data === "string" && message.data.length > 0))
        assert.ok((await frame.evaluate(() => window.__aiScope.xmlOf())).includes("#2f9e63"))
        assert.deepEqual(brokenResources, [])
        assert.equal(requests.some((url) => url.startsWith("https://embed.diagrams.net/")), false)
        assert.equal(requests.some((url) => new URL(url).port === "8080"), false)
        if (accessCode) {
            const response = await context.request.post(`${appUrl}/api/scoped-edit`, { data: { xml: fixture, selectedIds: ["selected"], instruction: "变绿" } })
            assert.equal(response.status(), 401)
        }
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.waitForFunction(() => window.__deploymentMessages.some((message) => message.event === "aiScopeReady"), null, { timeout: 60000 })
        console.log(JSON.stringify({ appUrl, iframe: initialSource, scopedRequests, protected: !!accessCode, resources: "ok", writeback: "ok", export: "ok", reload: "ok" }))
    } finally {
        await browser.close()
    }
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
