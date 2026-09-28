import { DOMParser, type Element, XMLSerializer } from "@xmldom/xmldom"
import type { DiagramOperation } from "@/components/chat/types"

const serializer = new XMLSerializer()

export class ScopeError extends Error {}

function reject(message: string): never {
    throw new ScopeError(message)
}

function parseXml(xml: string) {
    if (!xml || xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
        reject("XML 为空、过大或包含不支持的声明")
    }
    try {
        return new DOMParser({
            onError: () => reject("XML 格式不合法"),
        }).parseFromString(xml, "text/xml")
    } catch {
        return reject("XML 格式不合法")
    }
}

function elements(element: Element) {
    return Array.from(element.childNodes).filter(
        (node): node is Element => node.nodeType === 1,
    )
}

function cellXml(xml: string, id: string) {
    const cell = parseXml(xml).documentElement
    if (
        cell?.tagName !== "mxCell" ||
        cell.getAttribute("id") !== id ||
        cell.getElementsByTagName("mxCell").length
    ) {
        return reject(`操作 ${id} 必须包含一个 id 完全一致的 mxCell`)
    }
    const children = elements(cell)
    if (
        children.length !== 1 ||
        children[0].tagName !== "mxGeometry" ||
        children[0].getAttribute("as") !== "geometry"
    ) {
        reject(`操作 ${id} 缺少完整 mxGeometry 或包含不支持的子节点`)
    }
    for (const geometry of [
        children[0],
        ...Array.from(children[0].getElementsByTagName("*")),
    ]) {
        if (
            !["mxGeometry", "mxPoint", "mxRectangle", "Array"].includes(
                geometry.tagName,
            )
        )
            reject("不支持的几何子节点")
        for (const key of ["x", "y", "width", "height"]) {
            const value = geometry.getAttribute(key)
            if (
                value !== null &&
                (!Number.isFinite(Number(value)) ||
                    Math.abs(Number(value)) > 1e7 ||
                    ((key === "width" || key === "height") &&
                        Number(value) < 0))
            ) {
                reject(`操作 ${id} 包含无效几何值 ${key}`)
            }
        }
    }
    return cell
}

function normalized(element: Element): string {
    return JSON.stringify({
        name: element.tagName,
        attrs: Array.from(element.attributes)
            .map((attr) => [attr.name, attr.value])
            .sort(),
        children: elements(element).map(normalized),
    })
}

export function scopedContext(xml: string, selectedIds: string[]) {
    const document = parseXml(xml)
    const models = document.getElementsByTagName("mxGraphModel")
    if (models.length !== 1)
        return reject("请提交当前页面的未压缩 mxGraphModel")
    const root = elements(models[0]).find((node) => node.tagName === "root")
    if (!root) return reject("当前页面缺少 root")
    const cells = new Map<string, Element>()
    for (const node of elements(root)) {
        const cell =
            node.tagName === "mxCell"
                ? node
                : elements(node).find((child) => child.tagName === "mxCell")
        const id = cell?.getAttribute("id") || node.getAttribute("id")
        if (!id || !cell || cells.has(id))
            return reject("图形存在缺失或重复 cell id")
        cells.set(id, cell)
    }
    const allowed = new Set(selectedIds)
    if (!allowed.size || allowed.size > 200)
        return reject("请选择 1 到 200 个元素")
    for (const id of allowed) {
        const cell = cells.get(id)
        if (
            !cell ||
            (cell.getAttribute("vertex") !== "1" &&
                cell.getAttribute("edge") !== "1")
        )
            reject(`选区 ${id} 不存在或不可编辑`)
    }
    const parentIds = new Set<string>()
    for (const id of allowed) {
        const cell = cells.get(id)
        if (!cell) reject(`选区 ${id} 不存在`)
        const parentId = cell.getAttribute("parent")
        if (parentId) parentIds.add(parentId)
        if (cell.getAttribute("vertex") === "1") parentIds.add(id)
    }
    return { cells, allowed, parentIds }
}

export function scopedModelContext(xml: string, selectedIds: string[]) {
    const { cells, allowed } = scopedContext(xml, selectedIds)
    const related = new Set<string>(allowed)
    const addAncestors = (id: string) => {
        let current = cells.get(id)?.getAttribute("parent") || ""
        while (current && cells.has(current)) {
            related.add(current)
            current = cells.get(current)?.getAttribute("parent") || ""
        }
    }
    for (const id of allowed) addAncestors(id)
    for (const [id, cell] of cells) {
        const source = cell.getAttribute("source") || ""
        const target = cell.getAttribute("target") || ""
        if (cell.getAttribute("edge") === "1" && (allowed.has(source) || allowed.has(target))) {
            related.add(id)
            if (source) related.add(source)
            if (target) related.add(target)
        }
    }
    const body = [...cells]
        .filter(([id]) => related.has(id))
        .map(([, cell]) => serializer.serializeToString(cell))
        .join("\n")
    return {
        xml: `<mxGraphModel><root>\n${body}\n</root></mxGraphModel>`,
        selectedIds: [...allowed],
        readOnlyIds: [...related].filter((id) => !allowed.has(id)),
        parentIds: [...new Set([...allowed].map((id) => cells.get(id)?.getAttribute("parent") || "").filter(Boolean))],
    }
}

export function planScopedWrites(
    xml: string,
    selectedIds: string[],
    operations: DiagramOperation[],
) {
    const { cells, allowed, parentIds } = scopedContext(xml, selectedIds)
    if (!operations.length || operations.length > 200)
        reject("模型没有产生操作或操作数量过多")
    const touched = new Set<string>()
    const deleted = new Set<string>()
    const additions = new Map<string, Element>()
    const writes: Array<{
        cellId: string
        attrs?: Record<string, string>
        structural?: { kind: "add" | "delete"; xml?: string; parentId?: string }
    }> = []
    for (const operation of operations) {
        const id = operation.cell_id
        if (!id || touched.has(id)) reject(`操作目标 ${id} 为空或重复`)
        touched.add(id)
        if (operation.operation !== "add" && !allowed.has(id))
            reject(`越界：${id} 不在 selectedIds 内`)
        if (operation.operation === "delete") {
            deleted.add(id)
            continue
        }
        if (!operation.new_xml) reject(`操作 ${id} 缺少 new_xml`)
        const next = cellXml(operation.new_xml, id)
        if (operation.operation === "add") {
            if (cells.has(id)) reject(`新增 id ${id} 已存在`)
            const parentId = next.getAttribute("parent")
            if (!parentId || !parentIds.has(parentId) || !cells.has(parentId))
                reject(`越界：新增父容器 ${parentId} 不在选区上下文中`)
            if (
                (next.getAttribute("vertex") === "1") ===
                (next.getAttribute("edge") === "1")
            )
                reject("新增元素必须是顶点或连线之一")
            for (const key of ["source", "target"]) {
                const reference = next.getAttribute(key)
                if (reference && !allowed.has(reference))
                    reject(`越界：新增元素引用 ${reference}`)
            }
            additions.set(id, next)
            writes.push({
                cellId: id,
                structural: {
                    kind: "add",
                    xml: serializer.serializeToString(next),
                    parentId,
                },
            })
            continue
        }
        if (operation.operation !== "update") reject("未知操作")
        const previous = cells.get(id)
        if (!previous) reject(`操作 ${id} 的目标不存在`)
        const keys = new Set(
            [
                ...Array.from(previous.attributes),
                ...Array.from(next.attributes),
            ].map((attr) => attr.name),
        )
        for (const key of keys) {
            if (
                !["style", "value"].includes(key) &&
                previous.getAttribute(key) !== next.getAttribute(key)
            )
                reject(`update ${id} 不允许改变 ${key}；请保留结构和元数据`)
        }
        const attrs: Record<string, string> = {}
        for (const key of ["style", "value"]) {
            const value = next.getAttribute(key) || ""
            if (value !== (previous.getAttribute(key) || "")) attrs[key] = value
        }
        const nextGeometry = elements(next)[0]
        const previousGeometry = elements(previous).find(
            (node) => node.tagName === "mxGeometry",
        )
        if (
            !previousGeometry ||
            normalized(previousGeometry) !== normalized(nextGeometry)
        ) {
            if (
                !previousGeometry ||
                nextGeometry.getAttribute("relative") !==
                    previousGeometry.getAttribute("relative")
            )
                reject(`update ${id} 不允许改变几何类型`)
            for (const key of ["x", "y", "width", "height"]) {
                const value = nextGeometry.getAttribute(key)
                if (value !== null) attrs[key] = value
            }
        }
        if (Object.keys(attrs).length) writes.push({ cellId: id, attrs })
    }
    let expanded = true
    while (expanded) {
        expanded = false
        for (const [id, cell] of cells) {
            const parentDeleted = deleted.has(cell.getAttribute("parent") || "")
            const terminalDeleted = ["source", "target"].some((key) =>
                deleted.has(cell.getAttribute(key) || ""),
            )
            if (!deleted.has(id) && (parentDeleted || terminalDeleted)) {
                if (terminalDeleted && !allowed.has(id))
                    reject(
                        `删除将影响选区外元素 ${id}，请同时选中相关子元素和连线`,
                    )
                deleted.add(id)
                expanded = true
            }
        }
    }
    for (const [id, cell] of additions) {
        if (
            ["parent", "source", "target"].some((key) =>
                deleted.has(cell.getAttribute(key) || ""),
            )
        )
            reject(`新增 ${id} 引用了本次将删除的元素`)
    }
    for (const id of deleted) {
        if (writes.some((write) => write.cellId === id))
            reject(`元素 ${id} 同时被修改和删除`)
        writes.push({ cellId: id, structural: { kind: "delete" } })
    }
    return { writes, allowedIds: [...allowed] }
}
