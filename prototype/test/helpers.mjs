import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const samplePath = (name) => path.join(HERE, "..", "samples", `${name}.xml`);
export const sample = (name) => readFileSync(samplePath(name), "utf8");
export const SAMPLES = ["small-flow", "aws-demo", "cat-demo"];

/** 造一张 n 个顶点 + n-1 条边的链式图（cols 列网格布局），用来验证"图越大作用域收益越明显" */
export function synthDiagram(n, cols = 20) {
    const cells = [];
    for (let i = 1; i <= n; i++) {
        const col = (i - 1) % cols;
        const row = Math.floor((i - 1) / cols);
        cells.push(
            `<mxCell id="v${i}" value="节点 ${i}" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=14;" vertex="1" parent="1">` +
            `<mxGeometry x="${col * 160}" y="${row * 120}" width="120" height="60" as="geometry"/></mxCell>`,
        );
    }
    for (let i = 1; i < n; i++) {
        cells.push(`<mxCell id="e${i}" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=classic;strokeWidth=2;strokeColor=#545B64;" edge="1" parent="1" source="v${i}" target="v${i + 1}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
    }
    return `<mxfile host="app" version="31.4.6"><diagram id="synth" name="合成图">` +
        `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100">` +
        `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel></diagram></mxfile>`;
}
