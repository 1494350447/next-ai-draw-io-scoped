import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getApiEndpoint, getAssetUrl } from "@/lib/base-path"
import { proxy } from "../../proxy"

afterEach(() => vi.unstubAllEnvs())

describe("deployment URLs", () => {
    it.each(["", "/diagram", "/tools/diagram"])(
        "keeps canvas and API under prefix %s on any public origin",
        (prefix) => {
            vi.stubEnv("NEXT_PUBLIC_BASE_PATH", prefix)
            for (const origin of [
                "http://192.0.2.10:3301",
                "https://draw.example.com",
            ]) {
                expect(
                    new URL(getAssetUrl("/drawio/index.html"), origin).href,
                ).toBe(`${origin}${prefix}/drawio/index.html`)
                expect(
                    new URL(getApiEndpoint("/api/scoped-edit"), origin).href,
                ).toBe(`${origin}${prefix}/api/scoped-edit`)
            }
        },
    )

    it("preserves scheme, host, prefix and query on language redirects", () => {
        const request = new NextRequest(
            "https://draw.example.com:8443/tools/diagram/?test=1",
            {
                nextConfig: { basePath: "/tools/diagram" },
                headers: { "accept-language": "zh" },
            },
        )
        expect(proxy(request)?.headers.get("location")).toBe(
            "https://draw.example.com:8443/tools/diagram/zh/?test=1",
        )
    })

    it("does not language-redirect canvas assets under a base path", () => {
        const request = new NextRequest(
            "https://draw.example.com/diagram/drawio/js/bootstrap.js",
            { nextConfig: { basePath: "/diagram" } },
        )
        expect(proxy(request)).toBeUndefined()
    })
})
