import { describe, expect, it } from "vitest"
import { planScopedWrites } from "@/lib/scoped-edit"

const xml = `<mxfile><diagram><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="B" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`

const update = (id: string, value: string) =>
    `<mxCell id="${id}" value="${value}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>`

describe("scoped edit guard", () => {
    it("converts an in-scope update to a client-safe attribute write", () => {
        const result = planScopedWrites(
            xml,
            ["a"],
            [
                {
                    operation: "update",
                    cell_id: "a",
                    new_xml: update("a", "Changed"),
                },
            ],
        )
        expect(result.writes).toEqual([
            { cellId: "a", attrs: { value: "Changed" } },
        ])
    })

    it("rejects a model operation outside selectedIds", () => {
        expect(() =>
            planScopedWrites(
                xml,
                ["a"],
                [{ operation: "delete", cell_id: "b" }],
            ),
        ).toThrow("不在 selectedIds")
    })

    it("rejects deleting a selected vertex when its unselected edge would be affected", () => {
        expect(() =>
            planScopedWrites(
                xml,
                ["a"],
                [{ operation: "delete", cell_id: "a" }],
            ),
        ).toThrow("选区外元素 e")
    })
})
