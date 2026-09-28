// S3 实验二：真实产品页（Next.js app :3000）里的 drawio iframe 是否自动带上适配插件。
// 与 S1 spike-c 的区别：那时插件靠 docker cp 临时塞进容器，现在靠 compose 只读挂载，
// 而且 embed URL 里**没有** ?plugins=、没有 aiScopeDebug —— 完全是生产形态。
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const APP = process.env.APP_URL || "http://127.0.0.1:3000/";

const R = { app: APP, frames: [], ready: null, pluginJs: null, actionChannel: null, errors: [] };
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => R.errors.push(String(e.message).slice(0, 160)));
await page.addInitScript(() => {
    window.__msgs = [];
    window.addEventListener("message", (e) => {
        let m;
        try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (_) { return; }
        if (m && m.event) window.__msgs.push(m);
    });
});

await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
let frame = null;
for (let i = 0; i < 60 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes("embed=1"));
    if (!frame) await page.waitForTimeout(1000);
}
R.frames = page.frames().map((f) => f.url().slice(0, 80));
if (!frame) {
    console.log("没找到 drawio iframe：" + JSON.stringify(R.frames));
    console.log("S3_F_RESULT=" + JSON.stringify(R, null, 2));
    await browser.close();
    process.exit(1);
}
console.log("app 内 drawio frame: " + frame.url());
console.log("embed URL 里有没有 ?plugins= ：" + /[?&]plugins=/.test(frame.url()));
console.log("embed URL 里有没有 aiScopeDebug ：" + /aiScopeDebug/.test(frame.url()));

// 真实产品页收不到 aiScopeReady 就说明挂载没生效（插件没被注入）
try {
    await page.waitForFunction(() => window.__msgs.some((m) => m.event === "aiScopeReady"), null, { timeout: 45000 });
    R.ready = (await page.evaluate(() => window.__msgs.find((m) => m.event === "aiScopeReady"))) || null;
    console.log(">>> app 窗口收到 aiScopeReady：" + JSON.stringify(R.ready));
} catch (e) {
    R.errors.push("app 窗口没收到 aiScopeReady：" + e.message);
}

// 插件本体确实是从 drawio origin 取的、且内容正确
R.pluginJs = await frame.evaluate(async () => {
    const r = await fetch("plugins/custom/ai-scope.js");
    const t = await r.text();
    return { status: r.status, bytes: t.length, hasLoadPlugin: t.indexOf("Draw.loadPlugin") >= 0 };
});
console.log("插件 HTTP：" + JSON.stringify(R.pluginJs));

// 动作通道：用官方 embed 协议调一个只读动作，应该回一条 aiScope 事件
const n = await page.evaluate(() => window.__msgs.length);
await page.evaluate(() => {
    const f = document.querySelector("iframe");
    f.contentWindow.postMessage(JSON.stringify({ action: "invokeAction", actionName: "aiScopeProbe" }), "*");
});
await page.waitForTimeout(2000);
R.actionChannel = await page.evaluate((k) => window.__msgs.slice(k).filter((m) => m.event === "aiScope").map((m) => ({ event: m.event, reason: m.reason, count: m.count, ids: m.ids, version: m.version })), n);
console.log("invokeAction 通道：" + JSON.stringify(R.actionChannel));

console.log("\nS3_F_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
