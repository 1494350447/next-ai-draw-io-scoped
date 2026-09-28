import type { Element } from "@xmldom/xmldom"
import { planScopedWrites, scopedContext } from "@/lib/scoped-edit"

type Attrs = Record<string, string>

export type ScopedWrite = {
    cellId: string
    attrs?: Attrs | null
    structural?: {
        kind: "add" | "delete"
        xml?: string
        parentId?: string
        value?: string
        style?: string
        x?: number
        y?: number
        width?: number
        height?: number
    } | null
}

type Rule = {
    why: string
    pattern: RegExp
    parse?: (match: RegExpExecArray, text: string) => RuleResult | null
    result: RuleResult
}

type RuleResult = {
    command: "style" | "align" | "distribute" | "size" | "move" | "square" | "add" | "delete"
    params?: Record<string, unknown>
}

type CellInfo = {
    id: string
    element: Element
    parent: string | null
    vertex: boolean
    edge: boolean
    value: string
    style: string
    geometry: { x: number; y: number; width: number; height: number } | null
}

type GeometryCell = CellInfo & { geometry: NonNullable<CellInfo["geometry"]> }

const colors: Record<string, string> = {
    红: "#ff0000", 红色: "#ff0000", 橙: "#ffa94d", 橙色: "#ffa94d",
    黄: "#ffe066", 黄色: "#ffe066", 绿: "#2f9e63", 绿色: "#2f9e63",
    蓝: "#3b7dd8", 蓝色: "#3b7dd8", 青: "#15aabf", 青色: "#15aabf",
    紫: "#9775fa", 紫色: "#9775fa", 粉: "#f783ac", 粉色: "#f783ac",
    灰: "#adb5bd", 灰色: "#adb5bd", 黑: "#000000", 黑色: "#000000",
    白: "#ffffff", 白色: "#ffffff",
}

const colorPattern = new RegExp(`(${Object.keys(colors).join("|")})`)
const numberPattern = "([0-9]+(?:\\.[0-9]+)?)"
const moveVerb = "(?:平移|移动|移|挪|走|拖|偏)?"

function result(command: RuleResult["command"], params: Record<string, unknown> = {}): RuleResult {
    return { command, params }
}

const rules: Rule[] = [
    {
        why: "新增元素（抄选区的样式与尺寸，放在选区右侧）",
        pattern: /(?:新增|添加|加一(?:个|条)|画一(?:个|条)|旁边加|再来一(?:个|条)|复制一(?:个|条))/,
        parse: (_match, text) => /框|矩形|方框|方块/.test(text) ? result("add", {
            label: /["“「']([^"”」']{1,12})["”」']/.exec(text)?.[1],
        }) : null,
        result: result("add"),
    },
    {
        why: "删除选中元素",
        pattern: /(?:删除|删掉|移除|不要了|去掉)/,
        parse: (_match, text) => /边框|描边|轮廓|颜色|线条|文字|字体|样式|阴影|圆角|虚线|箭头|填充/.test(text) ? null : result("delete"),
        result: result("delete"),
    },
    { why: "垂直居中", pattern: /垂直居中|纵向居中/, result: result("align", { mode: "middle" }) },
    { why: "水平居中", pattern: /水平居中|横向居中/, result: result("align", { mode: "center" }) },
    { why: "左对齐", pattern: /左对齐|靠左|贴左|对齐(?:到)?左/, result: result("align", { mode: "left" }) },
    { why: "右对齐", pattern: /右对齐|靠右|贴右|对齐(?:到)?右/, result: result("align", { mode: "right" }) },
    { why: "顶对齐", pattern: /顶对齐|上对齐|靠上|贴顶/, result: result("align", { mode: "top" }) },
    { why: "底对齐", pattern: /底对齐|下对齐|靠下|贴底/, result: result("align", { mode: "bottom" }) },
    { why: "居中", pattern: /居中|对中/, result: result("align", { mode: "center" }) },
    { why: "对齐（未指定方向 → 左对齐）", pattern: /对齐/, result: result("align", { mode: "left" }) },
    { why: "水平等距分布", pattern: /(?:水平|横向)[^,，。;；]{0,6}(?:等距|均分|分布|均匀)/, result: result("distribute", { axis: "x" }) },
    { why: "垂直等距分布", pattern: /(?:垂直|纵向)[^,，。;；]{0,6}(?:等距|均分|分布|均匀)/, result: result("distribute", { axis: "y" }) },
    { why: "等大小", pattern: /等大|一样大|统一大小|大小一致|大小一样|一样大小/, result: result("size", { mode: "both" }) },
    { why: "等宽", pattern: /等宽|(?:宽度|宽)(?:一致|一样|相同|统一)|(?:统一|一致|相同)宽度/, result: result("size", { mode: "width" }) },
    { why: "等高", pattern: /等高|(?:高度|高)(?:一致|一样|相同|统一)|(?:统一|一致|相同)高度/, result: result("size", { mode: "height" }) },
    {
        why: "向右移动", pattern: new RegExp(`(?:向|往)?右(?:边)?${moveVerb}\\s*${numberPattern}`),
        parse: (match) => result("move", { dx: Number(match[1]), dy: 0 }), result: result("move"),
    },
    {
        why: "向左移动", pattern: new RegExp(`(?:向|往)?左(?:边)?${moveVerb}\\s*${numberPattern}`),
        parse: (match) => result("move", { dx: -Number(match[1]), dy: 0 }), result: result("move"),
    },
    {
        why: "向下移动", pattern: new RegExp(`(?:向|往)?下(?:边)?${moveVerb}\\s*${numberPattern}`),
        parse: (match) => result("move", { dx: 0, dy: Number(match[1]) }), result: result("move"),
    },
    {
        why: "向上移动", pattern: new RegExp(`(?:向|往)?上(?:边)?${moveVerb}\\s*${numberPattern}`),
        parse: (match) => result("move", { dx: 0, dy: -Number(match[1]) }), result: result("move"),
    },
    {
        why: "改字号", pattern: new RegExp(`(?:字号|字体大小|字体)\\s*(?:调整|调|设|改|变|缩放)?\\s*(?:到|为|成)?\\s*${numberPattern}`),
        parse: (match, text) => result("style", { props: { fontSize: match[1] }, targets: /连线|箭头|边线/.test(text) ? "writable" : "vertices" }), result: result("style"),
    },
    { why: "加粗", pattern: /加粗|粗体|字体加粗/, result: result("style", { props: { fontStyle: "1" }, targets: "vertices" }) },
    { why: "斜体", pattern: /斜体/, result: result("style", { props: { fontStyle: "2" }, targets: "vertices" }) },
    {
        why: "变成正方形（宽高取长边）", pattern: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:正方形|正方)/,
        result: result("square"),
    },
    {
        why: "换成梯形", pattern: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:梯形)/,
        result: result("style", { props: { shape: "trapezoid", perimeter: "trapezoidPerimeter", direction: "north" }, targets: "vertices" }),
    },
    {
        why: "换成数据库形状（圆柱）", pattern: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:数据库|圆柱|柱状)/,
        result: result("style", { props: { shape: "cylinder3" }, targets: "vertices" }),
    },
    {
        why: "换成菱形", pattern: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:菱形|判断框|条件框)/,
        result: result("style", { props: { shape: "rhombus" }, targets: "vertices" }),
    },
    {
        why: "换成椭圆/圆形", pattern: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:椭圆|圆形)/,
        result: result("style", { props: { shape: "ellipse" }, targets: "vertices" }),
    },
    { why: "圆角", pattern: /圆角/, result: result("style", { props: { rounded: "1" }, targets: "vertices" }) },
    { why: "虚线", pattern: /虚线/, result: result("style", { props: { dashed: "1" } }) },
    { why: "阴影", pattern: /阴影|投影/, result: result("style", { props: { shadow: "1" }, targets: "vertices" }) },
    { why: "半透明", pattern: /半透明|透明度|透明/, result: result("style", { props: { opacity: "50" }, targets: "vertices" }) },
    {
        why: "线宽", pattern: new RegExp(`(?:线宽|边框(?:粗细|宽度))\\s*(?:到|为)?\\s*${numberPattern}`),
        parse: (match) => result("style", { props: { strokeWidth: match[1] } }), result: result("style"),
    },
]

export type ParsedScopedInstruction = {
    matched: boolean
    why: string
    command?: RuleResult["command"]
    params?: Record<string, unknown>
}

export function parseScopedInstruction(input: string): ParsedScopedInstruction {
    const text = String(input ?? "").trim()
    if (!text) return { matched: false, why: "指令是空的" }
    const color = colorPattern.exec(text)
    if (color && /变|改|刷|换|调|设|弄|涂/.test(text)) {
        const prop = /描边|边框|轮廓/.test(text) ? "strokeColor" : /文字|字体|文本/.test(text) ? "fontColor" : "fillColor"
        return {
            matched: true,
            why: `颜色 → ${prop}=${colors[color[1]]}`,
            command: "style",
            params: { props: { [prop]: colors[color[1]] }, targets: prop === "strokeColor" ? "writable" : "vertices" },
        }
    }
    for (const rule of rules) {
        const match = rule.pattern.exec(text)
        if (!match) continue
        const parsed = rule.parse ? rule.parse(match, text) : rule.result
        if (!parsed) continue
        return { matched: true, why: rule.why, command: parsed.command, params: parsed.params }
    }
    return { matched: false, why: "没有命中确定性规则（这类改动需要模型）" }
}

function children(element: Element) {
    return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1)
}

function geometryOf(element: Element) {
    const geometry = children(element).find((node) => node.tagName === "mxGeometry")
    if (!geometry) return null
    const value = (name: string) => Number(geometry.getAttribute(name) || 0)
    return { x: value("x"), y: value("y"), width: value("width"), height: value("height") }
}

function cellInfo(element: Element): CellInfo {
    return {
        id: element.getAttribute("id") || "",
        element,
        parent: element.getAttribute("parent") || null,
        vertex: element.getAttribute("vertex") === "1",
        edge: element.getAttribute("edge") === "1",
        value: element.getAttribute("value") || "",
        style: element.getAttribute("style") || "",
        geometry: geometryOf(element),
    }
}

function styleMap(style: string) {
    const map = new Map<string, string>()
    for (const part of style.split(";")) {
        const index = part.indexOf("=")
        if (index > 0) map.set(part.slice(0, index), part.slice(index + 1))
        else if (part) map.set(part, "")
    }
    return map
}

function serializeStyle(map: Map<string, string>) {
    return [...map].map(([key, value]) => value ? `${key}=${value}` : key).join(";") + (map.size ? ";" : "")
}

function escapeXml(value: string) {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function writeStyle(cell: CellInfo, props: Record<string, string>): Attrs | null {
    const map = styleMap(cell.style)
    for (const [key, value] of Object.entries(props)) map.set(key, value)
    const style = serializeStyle(map)
    return style === cell.style ? null : { style }
}

function numeric(value: number) {
    return String(Math.round(value))
}

function geometryTargets(cells: CellInfo[]): GeometryCell[] {
    return cells.filter((cell): cell is GeometryCell => cell.vertex && Boolean(cell.geometry))
}

function groups(cells: CellInfo[]) {
    const grouped = new Map<string, GeometryCell[]>()
    for (const cell of geometryTargets(cells)) {
        const key = cell.parent || ""
        grouped.set(key, [...(grouped.get(key) || []), cell])
    }
    return [...grouped.values()]
}

function geometryWrites(cells: CellInfo[], command: string, params: Record<string, unknown>) {
    const writes: ScopedWrite[] = []
    const put = (cell: CellInfo, attrs: Record<string, number>) => {
        const changed: Attrs = {}
        for (const [key, value] of Object.entries(attrs)) {
            const current = cell.geometry?.[key as "x" | "y" | "width" | "height"]
            if (current !== value) changed[key] = numeric(value)
        }
        if (Object.keys(changed).length) writes.push({ cellId: cell.id, attrs: changed })
    }
    if (command === "move") {
        for (const cell of geometryTargets(cells)) put(cell, {
            x: cell.geometry.x + Number(params.dx || 0), y: cell.geometry.y + Number(params.dy || 0),
        })
        return writes
    }
    if (command === "square") {
        for (const cell of geometryTargets(cells)) {
            const side = Math.max(cell.geometry.width, cell.geometry.height)
            put(cell, { width: side, height: side })
        }
        return writes
    }
    for (const group of groups(cells)) {
        if (command === "align") {
            const left = Math.min(...group.map((cell) => cell.geometry.x))
            const top = Math.min(...group.map((cell) => cell.geometry.y))
            const right = Math.max(...group.map((cell) => cell.geometry.x + cell.geometry.width))
            const bottom = Math.max(...group.map((cell) => cell.geometry.y + cell.geometry.height))
            const mode = String(params.mode)
            for (const cell of group) {
                const g = cell.geometry
                if (mode === "left") put(cell, { x: left })
                if (mode === "center") put(cell, { x: (left + right - g.width) / 2 })
                if (mode === "right") put(cell, { x: right - g.width })
                if (mode === "top") put(cell, { y: top })
                if (mode === "middle") put(cell, { y: (top + bottom - g.height) / 2 })
                if (mode === "bottom") put(cell, { y: bottom - g.height })
            }
        }
        if (command === "distribute" && group.length >= 3) {
            const axis: "x" | "y" = params.axis === "y" ? "y" : "x"
            const ordered = [...group].sort((a, b) => a.geometry[axis] - b.geometry[axis])
            const start = ordered[0].geometry[axis]
            const last = ordered[ordered.length - 1].geometry
            const end = last[axis] + last[axis === "x" ? "width" : "height"]
            const occupied = ordered.reduce((sum, cell) => sum + cell.geometry[axis === "x" ? "width" : "height"], 0)
            const gap = (end - start - occupied) / (ordered.length - 1)
            let cursor = start
            for (const cell of ordered) {
                put(cell, axis === "x" ? { x: cursor } : { y: cursor })
                cursor += cell.geometry[axis === "x" ? "width" : "height"] + gap
            }
        }
        if (command === "size" && group.length >= 2) {
            const reference = [...group].sort((a, b) => (b.geometry.width * b.geometry.height) - (a.geometry.width * a.geometry.height))[0]
            for (const cell of group) {
                if (cell.id === reference.id) continue
                const attrs: Record<string, number> = {}
                if (params.mode === "width" || params.mode === "both") attrs.width = reference.geometry.width
                if (params.mode === "height" || params.mode === "both") attrs.height = reference.geometry.height
                put(cell, attrs)
            }
        }
    }
    return writes
}

export function planScopedRule(xml: string, selectedIds: string[], instruction: string) {
    const parsed = parseScopedInstruction(instruction)
    if (!parsed.matched || !parsed.command) return { matched: false, why: parsed.why, writes: [] as ScopedWrite[], warnings: [] as string[] }
    const context = scopedContext(xml, selectedIds)
    const cells = [...context.allowed].map((id) => {
        const element = context.cells.get(id)
        if (!element) throw new Error(`选区 ${id} 不存在`)
        return cellInfo(element)
    })
    const params = parsed.params || {}
    const warnings: string[] = []
    let writes: ScopedWrite[] = []
    if (["align", "distribute", "size", "move", "square"].includes(parsed.command)) {
        writes = geometryWrites(cells, parsed.command, params)
        if (parsed.command === "distribute" && geometryTargets(cells).length < 3) warnings.push("等距分布至少需要选中 3 个有位置的元素")
        if (parsed.command === "size" && geometryTargets(cells).length < 2) warnings.push("等尺寸至少需要选中 2 个有尺寸的元素")
    } else if (parsed.command === "style") {
        const props = (params.props || {}) as Record<string, string>
        const targets = params.targets === "vertices" ? cells.filter((cell) => cell.vertex) : cells
        for (const cell of targets) {
            const attrs = writeStyle(cell, props)
            if (attrs) writes.push({ cellId: cell.id, attrs })
        }
    } else if (parsed.command === "delete") {
        const planned = planScopedWrites(xml, selectedIds, selectedIds.map((cell_id) => ({ operation: "delete" as const, cell_id })))
        writes = planned.writes.filter((write) => context.allowed.has(write.cellId)).map((write) => ({ cellId: write.cellId, structural: { kind: "delete" as const } }))
    } else if (parsed.command === "add") {
        const source = geometryTargets(cells)[0]
        if (!source) warnings.push("没有可参照的顶点，无法新增框")
        else {
            const parentId = source.parent || "1"
            if (!context.parentIds.has(parentId) || !context.cells.has(parentId)) throw new Error(`新增父容器 ${parentId} 不在选区上下文中`)
            let id = "ai-add-1"
            while (context.cells.has(id)) id = `ai-add-${Number(id.slice(7)) + 1}`
            const x = Math.round(Math.max(...geometryTargets(cells).map((cell) => cell.geometry.x + cell.geometry.width)) + 60)
            const y = Math.round(source.geometry.y)
            const style = source.style
            const value = typeof params.label === "string" ? params.label : "新建"
            const node = `<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parentId)}"><mxGeometry x="${x}" y="${y}" width="${source.geometry.width}" height="${source.geometry.height}" as="geometry"/></mxCell>`
            writes.push({ cellId: id, structural: { kind: "add", xml: node, parentId, value, style, x, y, width: source.geometry.width, height: source.geometry.height } })
        }
    }
    return { matched: true, why: parsed.why, writes, warnings }
}
