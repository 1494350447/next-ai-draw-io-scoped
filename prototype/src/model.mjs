// mxGraphModel -> 可查询的图模型（cells / 父子关系 / 样式 / 几何）。
// 解析用 src/xml.mjs 的保偏移解析器，所以每个 cell 都能映射回原文的属性区间：
// 后面所有写操作都是"改某个属性区间"，未选中元素的字节天然不变。
import { createHash } from "node:crypto";
import { parseXml, nodeText } from "./xml.mjs";

export function sha256(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** "rounded=1;fillColor=#fff;" -> Map（保持顺序；无值 flag 记为 ""） */
export function parseStyle(style) {
    const map = new Map();
    for (const part of String(style || "").split(";")) {
        const s = part.trim();
        if (!s) continue;
        const eq = s.indexOf("=");
        if (eq < 0) map.set(s, "");
        else map.set(s.slice(0, eq), s.slice(eq + 1));
    }
    return map;
}

export function serializeStyle(map) {
    const parts = [];
    for (const [k, v] of map) parts.push(v === "" ? k : `${k}=${v}`);
    return parts.length ? parts.join(";") + ";" : "";
}

const num = (v, fallback = 0) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
};

/**
 * 解析一份 diagram XML。
 * 支持 <mxfile><diagram>...</diagram></mxfile> 与裸 <mxGraphModel>；
 * diagram 内容必须是明文 XML（压缩过的 base64 载荷会明确报错，不静默出错数据）。
 */
export function parseDiagram(text) {
    const parsed = parseXml(text);
    const mxfile = parsed.root.name === "mxfile" ? parsed.root : null;
    const diagramNode = mxfile
        ? mxfile.children.find((c) => c.name === "diagram")
        : (parsed.root.name === "diagram" ? parsed.root : null);
    if (diagramNode && diagramNode.children.length === 0 && diagramNode.attrs.has("id")) {
        const inner = nodeText(text, diagramNode).replace(/^<diagram[^>]*>|<\/diagram>$/g, "").trim();
        if (inner && !inner.startsWith("<")) {
            throw new Error("这个 diagram 的内容是压缩载荷，原型只支持明文 XML（drawio 里勾选“未压缩”另存即可）");
        }
    }
    const modelNode = (diagramNode ? diagramNode.children.find((c) => c.name === "mxGraphModel") : null)
        || (parsed.root.name === "mxGraphModel" ? parsed.root : null);
    if (!modelNode) throw new Error("没找到 <mxGraphModel>");

    const rootNode = modelNode.children.find((c) => c.name === "root");
    if (!rootNode) throw new Error("<mxGraphModel> 里没有 <root>");

    const cells = new Map();
    const order = [];

    const buildCell = (node) => {
        let wrapper = null;
        let inner = node;
        if (node.name === "object" || node.name === "UserObject") {
            wrapper = node;
            inner = node.children.find((c) => c.name === "mxCell");
            if (!inner) return null;
        } else if (node.name !== "mxCell") {
            return null;
        }
        const attr = (name) => {
            const a = (wrapper && wrapper.attrs.get(name)) || inner.attrs.get(name);
            return a ? a.value : undefined;
        };
        const id = attr("id");
        if (id === undefined) return null;

        const geoNode = inner.children.find((c) => c.name === "mxGeometry");
        const geoAttr = (name) => (geoNode && geoNode.attrs.get(name) ? geoNode.attrs.get(name).value : undefined);
        const styleText = attr("style") ?? "";
        const cell = {
            id,
            node: wrapper ?? inner,        // 承载 id 的那层（写 value/label 用）
            cellNode: inner,               // 承载 style/vertex/edge 的那层
            wrapper,
            value: attr("label") ?? attr("value") ?? "",
            style: styleText,
            styleMap: parseStyle(styleText),
            isVertex: inner.attrs.get("vertex")?.value === "1",
            isEdge: inner.attrs.get("edge")?.value === "1",
            parent: attr("parent") ?? null,
            source: attr("source") ?? null,
            target: attr("target") ?? null,
            geometryNode: geoNode,
            geometry: geoNode
                ? {
                    x: num(geoAttr("x"), 0),
                    y: num(geoAttr("y"), 0),
                    width: num(geoAttr("width"), 0),
                    height: num(geoAttr("height"), 0),
                    relative: geoAttr("relative") === "1",
                }
                : null,
            childIds: [],
        };
        if (id === "0") cell.isRoot = true;
        if (id === "1" || cell.parent === "0") cell.isLayer = id !== "0";
        if (geoNode) {
            cell.geometry.hasX = geoNode.attrs.has("x");
            cell.geometry.hasY = geoNode.attrs.has("y");
            cell.geometry.hasW = geoNode.attrs.has("width");
            cell.geometry.hasH = geoNode.attrs.has("height");
        }
        return cell;
    };

    for (const node of rootNode.children) {
        const cell = buildCell(node);
        if (!cell) continue;
        cells.set(cell.id, cell);
        order.push(cell.id);
    }
    for (const cell of cells.values()) {
        if (cell.parent && cells.has(cell.parent)) cells.get(cell.parent).childIds.push(cell.id);
    }

    /** 子孙（含 edge 的端点不算子孙，只有 parent 链算） */
    const descendants = (id, acc = []) => {
        const cell = cells.get(id);
        if (!cell) return acc;
        for (const childId of cell.childIds) {
            acc.push(childId);
            descendants(childId, acc);
        }
        return acc;
    };
    const ancestors = (id) => {
        const acc = [];
        let cur = cells.get(id)?.parent;
        while (cur && cells.has(cur)) {
            acc.push(cur);
            cur = cells.get(cur).parent;
        }
        return acc;
    };
    const edgesOf = (id) => [...cells.values()].filter(
        (c) => c.isEdge && (c.source === id || c.target === id),
    );
    return {
        text,
        parsed,
        mxfile,
        diagramNode,
        modelNode,
        rootNode,
        cells,
        order,
        get: (id) => cells.get(id),
        descendants,
        ancestors,
        edgesOf,
        isContainer: (id) => (cells.get(id)?.childIds.length ?? 0) > 0,
        isDescendantOf: (id, ancestorId) => descendants(ancestorId).includes(id),
        checksum: sha256(text),
        pageId: diagramNode?.attrs.get("id")?.value ?? null,
        pageName: diagramNode?.attrs.get("name")?.value ?? null,
    };
}

/** 展示用：给一个 cell 起个短标签 */
export function labelOf(cell) {
    const value = String(cell.value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (value) return value.length > 24 ? value.slice(0, 24) + "…" : value;
    if (cell.isEdge) return `→ ${cell.source ?? "?"}→${cell.target ?? "?"}`;
    return `(${cell.style.split(";")[0] || "无样式"})`;
}
