import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/lib/chromium/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(process.env.PROTO_URL || "http://127.0.0.1:8787/", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("#tree .row", { timeout: 15000 });
for (const sample of ["small-flow", "aws-demo", "cat-demo"]) {
    await page.selectOption("#sample", sample);
    await page.waitForTimeout(1200);
    const t = await page.evaluate(() => {
        const el = [...document.querySelectorAll("#svg rect[data-id]")].pop();
        const b = el.getBoundingClientRect();
        const svg = document.querySelector("#svg");
        const inv = svg.getScreenCTM().inverse();
        const w = (x, y) => { const p = svg.createSVGPoint(); p.x = x; p.y = y; return p.matrixTransform(inv); };
        const a = w(b.left, b.top), c = w(b.right, b.bottom);
        return { id: el.dataset.id, screen: [b.left, b.top, b.right, b.bottom].map(Math.round), ctmWorld: [Math.round(a.x), Math.round(a.y), Math.round(c.x - a.x), Math.round(c.y - a.y)] };
    });
    // 拖出该元素的屏幕包围盒，并在"松手前"读出应用算出来的框
    await page.mouse.move(t.screen[0], t.screen[1]);
    await page.mouse.down();
    await page.mouse.move((t.screen[0] + t.screen[2]) / 2, (t.screen[1] + t.screen[3]) / 2, { steps: 3 });
    await page.mouse.move(t.screen[2], t.screen[3], { steps: 3 });
    await page.waitForTimeout(120);
    const box = await page.evaluate(() => {
        const last = document.querySelector("#svg").lastElementChild;
        return last?.tagName === "rect" && !last.dataset.id
            ? { x: Math.round(+last.getAttribute("x")), y: Math.round(+last.getAttribute("y")), w: Math.round(+last.getAttribute("width")), h: Math.round(+last.getAttribute("height")) }
            : null;
    });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const roots = await page.evaluate(() => Number((document.querySelector("#b-scope").textContent.match(/roots\s*(\d+)/) || [])[1] ?? -1));
    console.log(sample, JSON.stringify({ aimed: t.id, elemScreen: t.screen, ctmWorld: t.ctmWorld, drawnBox: box, roots }));
}
await browser.close();
