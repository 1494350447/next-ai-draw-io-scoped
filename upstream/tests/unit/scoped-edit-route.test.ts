import { beforeEach, describe, expect, it, vi } from "vitest"

const { generateText, getAIModel } = vi.hoisted(() => ({
    generateText: vi.fn(),
    getAIModel: vi.fn(),
}))

vi.mock("ai", () => ({ generateText }))
vi.mock("@/lib/ai-providers", () => ({ getAIModel }))
vi.mock("@/lib/model-request", () => ({ resolveModelRequest: vi.fn() }))
vi.mock("@/lib/dynamo-quota-manager", () => ({
    checkAndIncrementRequest: vi.fn(),
    isQuotaEnabled: () => false,
    recordTokenUsage: vi.fn(),
}))

const xml = `<mxfile><diagram><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`

describe("POST /api/scoped-edit", () => {
    beforeEach(() => {
        generateText.mockReset()
        getAIModel.mockReset()
    })

    it("returns a deterministic write before resolving a model", async () => {
        const { POST } = await import("@/app/api/scoped-edit/route")
        const response = await POST(new Request("http://localhost/api/scoped-edit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ xml, selectedIds: ["a"], instruction: "变绿" }),
        }))
        const body = await response.json()
        expect(response.status).toBe(200)
        expect(body.channel).toBe("rule")
        expect(body.writes[0].attrs.style).toContain("fillColor=#2f9e63")
        expect(getAIModel).not.toHaveBeenCalled()
        expect(generateText).not.toHaveBeenCalled()
    })
})
