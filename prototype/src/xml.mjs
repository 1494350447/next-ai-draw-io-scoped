// 极简 XML 解析器 —— 为"按字节偏移做外科替换"而生。
//
// 为什么不用现成的解析器：Phase 1 的验收条件是"**未选中元素的 XML 逐字节不变**"。
// 任何"解析 → 重新序列化整篇"的做法都会重排属性、改引号、动空白，这条就守不住。
// 所以这里要的是**保偏移**的解析：每个节点记下它在原文里的 [start,end)，每个属性值记下
// [valueStart,valueEnd)，改动只落在这些区间上，其余字节原样带过。
//
// 覆盖面：mxGraphModel 实际用到的子集（声明/注释/CDATA/起始·结束·自闭合标签/单双引号属性/实体）。
// 不覆盖：DTD、命名空间前缀语义、混合内容的文本节点（本项目不需要）。

// 元素名与属性名的结束字符不同：属性名还要在 "=" 前停下（否则会读到下一个属性名里）。
const ELEM_NAME_END = /[\s/>]/;
const ATTR_NAME_END = /[\s=/>]/;

/** 解码 XML 实体（只处理 mxGraphModel 里会出现的几种）。 */
export function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X"
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        switch (body) {
            case "lt": return "<";
            case "gt": return ">";
            case "quot": return '"';
            case "apos": return "'";
            case "amp": return "&";
            default: return whole;
        }
    });
}

/** 编码属性值：与 drawio 的习惯一致（换行写成 &#10;，其余用实体）。 */
export function encodeAttr(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/\r?\n/g, "&#10;");
}

/**
 * 从一段 <mxCell> 片段里取出它**声明**的引用 id：parent / source / target。
 *
 * 为什么要有这个函数：模型产出的 add/update 是整段 mxCell，而"这段 XML 连到谁"只有解析了才知道。
 * 服务端要在两个地方用它（都属"语义"，不该下沉到插件）：
 *   · `guardOps`：add 的端点若在作用域外，等于借着新元素改了别处 —— 必须拦；
 *   · `opsToWrites`：端点在图里根本不存在时，插件解出来只能得到 null 端点（浮动线），必须拒。
 * 只读属性、不做语义解释；解析失败一律返回空对象（让上层给出更准确的报错）。
 */
export function cellRefsFromXml(text) {
    const refs = {};
    let node;
    try { node = parseXml(text).root; } catch (e) { return refs; }
    let inner = node;
    if (inner && inner.name !== "mxCell") inner = (inner.children || []).find((c) => c.name === "mxCell") || inner;
    if (!inner || inner.name !== "mxCell" || !inner.attrs) return refs;
    for (const key of ["parent", "source", "target"]) {
        const attr = inner.attrs.get(key);
        if (attr && attr.value) refs[key] = String(attr.value);
    }
    return refs;
}

/**
 * 解析 XML，返回 { root, nodes }。
 * 节点结构：{ name, attrs: Map<name,{value,raw,valueStart,valueEnd,quote}>,
 *            children, parent, start, openEnd, end, selfClosing }
 *   start     —— '<' 的位置
 *   openEnd   —— 起始标签 '>' 之后的位置（自闭合节点此时 end === openEnd）
 *   end       —— 整个节点之后的位置
 */
export function parseXml(text) {
    let i = 0;
    const n = text.length;
    const nodes = [];
    const stack = [];
    let root = null;

    const fail = (msg) => { throw new Error(`${msg}（偏移 ${i}）`); };

    while (i < n) {
        const lt = text.indexOf("<", i);
        if (lt < 0) break;
        i = lt;
        if (text.startsWith("<!--", i)) { const e = text.indexOf("-->", i); i = e < 0 ? n : e + 3; continue; }
        if (text.startsWith("<![CDATA[", i)) { const e = text.indexOf("]]>", i); i = e < 0 ? n : e + 3; continue; }
        if (text.startsWith("<?", i)) { const e = text.indexOf("?>", i); i = e < 0 ? n : e + 2; continue; }
        if (text.startsWith("<!", i)) { const e = text.indexOf(">", i); i = e < 0 ? n : e + 1; continue; }

        if (text.startsWith("</", i)) {
            const e = text.indexOf(">", i);
            if (e < 0) fail("结束标签未闭合");
            const name = text.slice(i + 2, e).trim();
            const node = stack.pop();
            if (!node) fail(`多余的结束标签 </${name}>`);
            if (node.name !== name) fail(`结束标签不匹配：期望 </${node.name}>，实际 </${name}>`);
            node.end = e + 1;
            i = e + 1;
            continue;
        }

        let p = i + 1;
        const nameStart = p;
        while (p < n && !ELEM_NAME_END.test(text[p])) p++;
        const name = text.slice(nameStart, p);
        if (!name) fail("标签名为空");

        const attrs = new Map();
        let selfClosing = false;
        for (;;) {
            while (p < n && /\s/.test(text[p])) p++;
            if (p >= n) fail(`标签 <${name}> 未闭合`);
            if (text[p] === "/") {
                selfClosing = true;
                p++;
                while (p < n && /\s/.test(text[p])) p++;
                if (text[p] !== ">") fail(`自闭合标签 <${name}/> 格式错误`);
                p++;
                break;
            }
            if (text[p] === ">") { p++; break; }

            const aStart = p;
            while (p < n && !ATTR_NAME_END.test(text[p])) p++;
            const aName = text.slice(aStart, p);
            if (!aName) fail(`标签 <${name}> 的属性名解析失败`);
            while (p < n && /\s/.test(text[p])) p++;
            if (text[p] !== "=") {          // 无值属性（XML 里少见，容错处理）
                attrs.set(aName, { value: "", raw: "", valueStart: p, valueEnd: p, quote: null });
                continue;
            }
            p++;
            while (p < n && /\s/.test(text[p])) p++;
            const quote = text[p];
            if (quote === '"' || quote === "'") {
                const valueStart = p + 1;
                const valueEnd = text.indexOf(quote, valueStart);
                if (valueEnd < 0) fail(`属性 ${aName} 的值未闭合`);
                attrs.set(aName, {
                    value: decodeEntities(text.slice(valueStart, valueEnd)),
                    raw: text.slice(valueStart, valueEnd),
                    valueStart, valueEnd, quote,
                });
                p = valueEnd + 1;
            } else {
                const valueStart = p;
                while (p < n && !/[\s/>]/.test(text[p])) p++;
                attrs.set(aName, {
                    value: decodeEntities(text.slice(valueStart, p)),
                    raw: text.slice(valueStart, p),
                    valueStart, valueEnd: p, quote: null,
                });
            }
        }

        const node = { name, attrs, children: [], parent: null, start: i, openEnd: p, end: p, selfClosing };
        const parent = stack[stack.length - 1];
        if (parent) { node.parent = parent; parent.children.push(node); }
        else if (!root) root = node;
        else fail("出现了多个根元素");
        nodes.push(node);
        if (selfClosing) node.end = p;
        else stack.push(node);
        i = p;
    }

    if (stack.length) throw new Error(`标签 <${stack[stack.length - 1].name}> 没有结束`);
    if (!root) throw new Error("没有解析出任何元素");
    return { root, nodes, text };
}

/** 把若干区间替换应用到原文；区间可乱序、可重叠（重叠时报错）。 */
export function applyPatches(text, patches) {
    if (!patches.length) return text;
    const sorted = [...patches].sort((a, b) => b.start - a.start);
    let out = text;
    let lastStart = Infinity;
    for (const patch of sorted) {
        if (patch.end > lastStart) throw new Error("补丁区间重叠，先合并再应用");
        out = out.slice(0, patch.start) + patch.text + out.slice(patch.end);
        lastStart = patch.start;
    }
    return out;
}

/** 设置属性值：已存在则只换值（保留原引号风格），不存在则插到起始标签末尾。 */
export function setAttr(text, node, name, value) {
    const attr = node.attrs.get(name);
    if (attr) {
        return { start: attr.valueStart, end: attr.valueEnd, text: encodeAttr(value) };
    }
    const insertAt = node.selfClosing ? node.openEnd - 2 : node.openEnd - 1;
    return { start: insertAt, end: insertAt, text: ` ${name}="${encodeAttr(value)}"` };
}

/** 取节点"整段"在原文本里的切片（含子节点）。 */
export function nodeText(text, node) {
    return text.slice(node.start, node.end);
}
