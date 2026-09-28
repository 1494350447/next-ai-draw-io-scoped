// S1 spike 验证 A：走**产品真实集成路径**——父页面 iframe 内嵌 drawio embed，
// 插件由 drawio 侧的 js/PreConfig.js 注入（?plugins= 已实测不通），选区通过 postMessage 回传父页面。
// 结果从 window.R 读，不需要任何外部接收器。
import { chromium } from "playwright";

// alpine 的 chromium 真身在 /usr/lib/chromium/chromium（/usr/bin/chromium 是包装脚本）
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const URL_SPIKE = process.env.SPIKE_URL || "http://127.0.0.1:8080/spike.html";

const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

page.on("console", (m) => console.log(`[page:${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[reqfail]", r.url(), r.failure() && r.failure().errorText));

let resp;
try {
    resp = await page.goto(URL_SPIKE, { waitUntil: "domcontentloaded", timeout: 45000 });
} catch (e) {
    console.log("GOTO_FAIL:", e.message);
    process.exit(2);
}
console.log("http status:", resp && resp.status());

// 先确认插件文件本身被 drawio 以正确 MIME 提供（同源加载的前提）
const pluginHttp = await page.evaluate(async () => {
    const r = await fetch("/plugins/custom/ai-scope.js");
    const t = await r.text();
    return { status: r.status, type: r.headers.get("content-type"), len: t.length, head: t.slice(0, 40) };
});
console.log("PLUGIN_HTTP=" + JSON.stringify(pluginHttp));

try {
    await page.waitForFunction(() => window.R && (document.title === "DONE" || window.R.errors.length), null, { timeout: 70000 });
} catch (e) {
    console.log("WAIT_TIMEOUT:", e.message);
}

const out = await page.evaluate(() => ({
    R: window.R,
    title: document.title,
    iframeSrc: (document.getElementById("f") || {}).src || null,
    frameGlobals: (() => {
        try {
            const w = document.getElementById("f").contentWindow;
            return { hasAiScope: !!w.__aiScope, drawioVersion: w.__aiScope ? w.__aiScope.version() : null, hasDraw: !!w.Draw };
        } catch (e) { return { error: String(e) }; }
    })(),
    text: document.getElementById("out").textContent.slice(-2500),
}));

console.log("\n----- harness 输出尾部 -----\n" + out.text);
console.log("iframe src: " + out.iframeSrc);
console.log("frameGlobals: " + JSON.stringify(out.frameGlobals));
console.log("\nSPIKE_A_RESULT=" + JSON.stringify(out.R, null, 2));

await browser.close();
