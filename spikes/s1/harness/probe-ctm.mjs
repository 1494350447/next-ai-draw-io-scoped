import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/lib/chromium/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(process.env.PROTO_URL || "http://127.0.0.1:8787/", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("#tree .row", { timeout: 15000 });
for (const sample of ["small-flow", "aws-demo", "cat-demo"]) {
    await page.selectOption("#sample", sample);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
        const svg = document.querySelector("#svg");
        const b = svg.getBoundingClientRect();
        const ctm = svg.getScreenCTM();
        const vb = svg.viewBox.baseVal;
        const cs = getComputedStyle(svg);
        return {
            rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
            client: [svg.clientWidth, svg.clientHeight],
            cssBox: [cs.width, cs.height],
            viewBox: [vb.x, vb.y, vb.width, vb.height],
            ctm: [ctm.a, ctm.d, ctm.e, ctm.f],
            // 元素内像素 (0,0) 与 (w,h) 对应的世界坐标（用 CTM 逆变换，权威）
            worldAtTL: (() => { const p = svg.createSVGPoint(); p.x = b.left; p.y = b.top; const q = p.matrixTransform(ctm.inverse()); return [Math.round(q.x), Math.round(q.y)]; })(),
            worldAtBR: (() => { const p = svg.createSVGPoint(); p.x = b.right; p.y = b.bottom; const q = p.matrixTransform(ctm.inverse()); return [Math.round(q.x), Math.round(q.y)]; })(),
            codeAtBR: [Math.round(b.width * (vb.width / b.width) + vb.x), Math.round(b.height * (vb.width / b.width) + vb.y)],
        };
    });
    console.log(sample, JSON.stringify(r));
}
await browser.close();
