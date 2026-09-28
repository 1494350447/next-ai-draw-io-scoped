import { describe, expect, it } from "vitest"
import { scopedModelContext } from "@/lib/scoped-edit"
import { parseScopedInstruction, planScopedRule } from "@/lib/scoped-rules"

const xml = `<mxfile><diagram><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" style="rounded=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="B" style="rounded=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="200" y="80" width="80" height="60" as="geometry"/></mxCell>
<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`

describe("scoped deterministic rules", () => {
    it("recognizes shape changes without a model call", () => {
        expect(parseScopedInstruction("变成梯形")).toMatchObject({
            matched: true,
            command: "style",
        })
        const result = planScopedRule(xml, ["a"], "变成梯形")
        expect(result.writes).toEqual([{
            cellId: "a",
            attrs: { style: "rounded=1;fillColor=#dae8fc;shape=trapezoid;perimeter=trapezoidPerimeter;direction=north;" },
        }])
    })

    it("changes only selected vertices for a color request", () => {
        const result = planScopedRule(xml, ["a"], "变绿")
        expect(result.writes).toHaveLength(1)
        expect(result.writes[0]).toMatchObject({ cellId: "a" })
        expect(result.writes[0].attrs?.style).toContain("fillColor=#2f9e63")
    })

    it("calculates alignment writes from the selected siblings", () => {
        const result = planScopedRule(xml, ["a", "b"], "左对齐")
        expect(result.writes).toEqual([{ cellId: "b", attrs: { x: "10" } }])
    })

    it("leaves unfamiliar language for the generative channel", () => {
        expect(planScopedRule(xml, ["a"], "把它改得更像一个数据库节点")).toMatchObject({
            matched: false,
            writes: [],
        })
    })

    it("shrinks generative context to selected cells and required endpoints", () => {
        const expanded = xml.replace(
            "</root>",
            '<mxCell id="unrelated" value="Do not send" vertex="1" parent="1"><mxGeometry x="500" y="500" width="20" height="20" as="geometry"/></mxCell></root>',
        )
        const context = scopedModelContext(expanded, ["a"])
        expect(context.xml).toContain('id="a"')
        expect(context.xml).toContain('id="e"')
        expect(context.xml).toContain('id="b"')
        expect(context.xml).not.toContain("Do not send")
        expect(context.readOnlyIds).toEqual(["1", "0", "e", "b"])
    })
})
