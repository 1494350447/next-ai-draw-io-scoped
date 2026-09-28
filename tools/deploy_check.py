#!/usr/bin/env python3
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:3000"
XML = """<mxfile><diagram><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="before" style="rounded=1;fillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="untouched" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="100" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(path, payload, access_code):
    headers = {"content-type": "application/json"}
    if access_code:
        headers["x-access-code"] = access_code
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=240) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def main():
    config = json.load(sys.stdin)
    environment = config["services"]["next-ai-draw-io"]["environment"]
    mode = sys.argv[1]
    if mode == "config":
        require(set(config["services"]) == {"drawio", "next-ai-draw-io"}, "Compose 服务不匹配")
        for key in ("AI_PROVIDER", "AI_MODEL"):
            require(str(environment.get(key) or "").strip(), f".env 缺少 {key}")
        providers_source = (ROOT / "upstream/lib/ai-providers.ts").read_text()
        provider_block = providers_source.split("export const PROVIDER_ENV_VARS:", 1)[1].split("}", 1)[0]
        providers = dict(re.findall(r'^\s+(\w+):\s*(null|"[^"]+"),', provider_block, re.M))
        provider = str(environment["AI_PROVIDER"]).strip()
        require(provider in providers, "AI_PROVIDER 不在当前源码支持的提供方中")
        key = providers[provider].strip('"')
        if key != "null":
            require(str(environment.get(key) or "").strip(), f".env 缺少 {key}")
        print("[*] 配置检查通过（未输出密钥）")
        return
    access_code = next(
        (code.strip() for code in (environment.get("ACCESS_CODE_LIST") or "").split(",") if code.strip()), ""
    )
    payload = {"xml": XML, "selectedIds": ["a"], "aliases": {"①": "a", "第1个": "a"}, "instruction": "变绿"}
    if mode == "scoped":
        if access_code:
            status, _body = request("/api/scoped-edit", payload, "")
            require(status == 401, "局部编辑访问码校验未生效")
        status, body = request("/api/scoped-edit", payload, access_code)
        require(status == 200, f"局部编辑返回 HTTP {status}；检查访问码及应用日志")
        result = json.loads(body)
        writes = result.get("writes", [])
        require(result.get("channel") == "rule" and result.get("ready"), "局部编辑快速规则未生效")
        require(len(writes) == 1 and writes[0]["cellId"] == "a", "规则写回范围不符合选区")
        require("fillColor=#2f9e63" in writes[0].get("attrs", {}).get("style", ""), "规则未返回预期颜色")
        payload["selectedIds"] = ["missing-cell"]
        status, _body = request("/api/scoped-edit", payload, access_code)
        require(status == 422, "无效选区未被拒绝")
        print("[*] 局部编辑冒烟通过：规则写回、选区限制、无效选区拒绝（不调用模型）")
    elif mode == "ai":
        print("[*] 正在验证聊天及局部编辑模型链路（会消耗模型额度）", flush=True)
        chat_payload = {
            "messages": [{"id": "deploy-smoke", "role": "user", "parts": [
                {"type": "text", "text": "画一个最简单的流程框图：只有一个矩形，里面写 hello。"}
            ]}],
            "xml": "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/></root></mxGraphModel>",
        }
        status, body = request("/api/chat", chat_payload, access_code)
        require(status == 200, f"聊天接口返回 HTTP {status}；检查模型配置和日志")
        events = [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ") and line[6:] != "[DONE]"]
        require(not any(event.get("type") == "error" for event in events), "聊天流返回错误；检查应用日志")
        require(any(event.get("type") == "tool-input-available" and event.get("toolName") == "display_diagram"
                    and event.get("input", {}).get("xml") for event in events), "聊天未生成 display_diagram XML")
        payload["instruction"] = "将①的文字内容替换为 deployment-ok，保留其余属性和其它元素。"
        status, body = request("/api/scoped-edit", payload, access_code)
        require(status == 200, f"局部编辑模型返回 HTTP {status}；检查模型配置和日志")
        result = json.loads(body)
        writes = result.get("writes", [])
        require(result.get("channel") == "generative" and result.get("ready"), "局部编辑模型未生成写回")
        require(writes and all(write["cellId"] == "a" for write in writes), "局部编辑模型写回越界")
        require(any(write.get("attrs", {}).get("value") == "deployment-ok" for write in writes), "局部编辑模型未生成预期文字")
        print("[*] 模型冒烟通过：聊天生成 XML，局部编辑生成选区内文字修改")
    else:
        raise RuntimeError("不支持的检查模式")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError, OSError) as error:
        print(f"[!] {error}", file=sys.stderr)
        sys.exit(1)
