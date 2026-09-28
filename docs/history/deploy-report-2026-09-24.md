# 历史部署实测报告（2026-09-24，当前报告见根目录 deploy-report.md）

- 上游：`https://github.com/DayuanJiang/next-ai-draw-io` @ `027cd88`（2026-09-01，`--depth 1`）
- 宿主：Ubuntu 24.04.5 / Docker 29.1.3 / Compose 2.40.3 / node v24.21.0（宿主侧仅用于脚本自身）
- 部署路径：**compose 覆盖层**（上游自带 `docker-compose.yml`，复用 + `-f` 叠加）
- 工作目录：`/home/sunhaha/deploy/next-ai-draw-io`
- 实测时间：2026-09-24
- 结论：**部署成功**。两个容器常驻运行，就绪判定 200，服务端模型链路端到端产出真实图示 XML。

## 1. 已实测通过

### 1.1 构建（`./deploy.sh install`）

| 命令 | 观察到的结果 | 判定依据 |
| --- | --- | --- |
| `./deploy.sh install` | 退出码 0，耗时约 128s | `next-ai-draw-io Built` |
| 容器内 `npm install` | `added 1459 packages in 42s` | `logs/build.log:70` |
| 镜像源生效 | `RUN npm config set registry "https://registry.npmmirror.com"` → 打印 `https://registry.npmmirror.com` | `logs/build.log:51-52`；`grep -o 'https://registry\.[a-z.]*' logs/build.log \| sort \| uniq -c` → `2 https://registry.npmmirror.com`，**没有**官方 registry 命中 |
| 选源依据 | 同一份 `next@16.0.7`：官方源 43.4s、npmmirror 8.9s（容器内实测） | 差距 4.9×，据此固定镜像源 |
| `next build` | `✓ Compiled successfully in 8.3s`；`✓ Generating static pages (35/35)` | `logs/build.log:143,151` |
| 产物冒烟（install 末步） | 镜像内 `/app/server.js` 与 `/app/.next/static` 均存在 | `./deploy.sh install` 打印"产物冒烟通过" |
| drawio 镜像 | `jgraph/drawio:latest` 拉取完成，38.5s | `logs/pull.log` |

构建容器的网络也单独量过：容器内直连官方 npm registry 可用（3.28s/包），npmmirror 0.59s/包；
两个源都通，选了快的那个（`china-mirrors.md` 要求"先量再选"）。

### 1.2 启动与就绪（`./deploy.sh up`）

| 检查 | 结果 |
| --- | --- |
| 容器 | `next-ai-draw-io-next-ai-draw-io-1` Up、`next-ai-draw-io-drawio-1` Up，`restarts=0` |
| 端口 | `0.0.0.0:3000->3000/tcp`、`0.0.0.0:8080->8080/tcp` |
| 就绪判定 | `GET http://127.0.0.1:3000/api/config -> 200`（判定地址出处：`upstream/app/api/config/route.ts`，无鉴权、返回 JSON） |
| 落地页 | `GET /` → `307 Location: /en/`；`GET /en` → `200`，42411 字节 |
| 自建 drawio 可达 | `GET http://127.0.0.1:8080/ -> 200` |
| 应用日志 | `✓ Ready in 0ms`、`[Langfuse] telemetry disabled`（未配 Langfuse，属正常） |

**构建期注入的关键项已生效**：客户端 chunk `/_next/static/chunks/0ursrgqcauof8.js` 里
`drawioBaseUrl` 的默认值被固化为 `http://localhost:8080`（即自建 drawio 容器），不是官方 CDN。
（chunk 里另有 2 处 `embed.diagrams.net` 来自 `react-drawio` 库自身的 URL 默认参数与 origin
白名单判断，不是应用的生效地址。）

### 1.3 业务可用性（不止"HTTP 活着"）

`./deploy.sh smoke` 真实调用 `POST /api/chat`，用 `.env` 里的 DeepSeek key 走完整链路：

| 证据 | 内容 |
| --- | --- |
| HTTP | `200`，响应为 UI message stream |
| 模型真实思考 | 流里有 `reasoning-delta` 事件（`"The user wants a simple flowchart..."`） |
| 真实产出图示 | `tool-input-available`，`toolName: display_diagram`，`input.xml` 是合法 draw.io XML |
| 结束原因 | `{"type":"finish","finishReason":"tool-calls","messageMetadata":{"totalTokens":5019}}` |
| 非缓存 | 连跑 3 次，`totalTokens` 分别为 5019 / 5028 / 5029，XML 几何参数与 tool call id 每次不同；仓库内置缓存（`upstream/lib/cached-responses.ts`）只匹配英文示例提示词，本次用的是中文提示词 |
| 额度真被扣 | DeepSeek 余额 `37.84 → 37.62 CNY`（服务端确实用了这把 key） |
| 耗时 | 单次约 1.0–1.4s（DeepSeek-V4.1-Flash） |

### 1.4 幂等、清理与常驻

| 检查 | 结果 |
| --- | --- |
| 幂等 | 连续两次 `up`：容器 ID 集合不变，未重建（`./deploy.sh verify` 内的显式断言） |
| 清理 | `down` 后 `docker compose ps -q` 为空、宿主 3000 端口释放、`data/` 保留 |
| 重新拉起 | `up` 后再次 `GET /api/config -> 200` |
| 常驻性 | 两个容器是由 docker daemon 管理的长期进程，跨越十余次独立 shell 会话（每次工具调用都是新 shell）始终 Up，`RestartCount=0` |
| 完整闭环 | `./deploy.sh verify` 退出码 0：体检 → 启动 → 就绪 → 幂等 → 业务冒烟 → 停止清理检查 → 重新拉起 |

### 1.5 密钥与产物边界

| 检查 | 结果 |
| --- | --- |
| 镜像是否带 `.env` | 否（`ls -a /app \| grep -c '^\.env$'` → 0，`.dockerignore` 排除了 `.env`） |
| 镜像是否含 key 明文 | 否（全盘 `grep -rl "sk-517...75" /app` 无命中） |
| 工作目录内是否泄漏 | 只有 `.env` 本身（`chmod 600`，已在 `.gitignore`）；`logs/` 无命中 |
| 上游文件是否被改 | 未改（`git -C upstream status --porcelain` 为空） |

### 1.6 原生模块/产物是否真的被加载

容器路径下运行时进程没有加载任何 `.node`：

```bash
docker exec ... sh -c "grep -o '/[^ ]*\.node' /proc/19/maps | sort -u"   # 无输出
```

按 `verification.md` 的三层判定，这属于**第 3 类：惰性未加载**，不是缺失：

- 磁盘上产物齐全：镜像内存在 `/app/node_modules/@img/sharp-linux-x64`、`@img/sharp-linuxmusl-x64`、
  `@img/sharp-libvips-linux*-x64`（libvips 预编译产物，随 npm 包发布，**不依赖本机编译**）。
- 这些包只在首次用到图片处理（`next/image` 优化）时才 `require`，本次冒烟没触发。
- 构建期用的 `esbuild` / `lightningcss` / `@tailwindcss/oxide` 不在运行时镜像里，符合预期
  （multi-stage 构建只把 standalone 产物带进 runner 阶段）。

## 2. 未能验证

| 项 | 卡在哪 | 需要什么条件 |
| --- | --- | --- |
| arm64 平台构建与运行 | 本机是 x86_64 | 一台 arm64 机器，或 `docker buildx` + qemu |
| 从第二台机器访问（局域网） | 只有本机在执行环境内 | 第二台设备；构建期地址注入本身已单独验证（见 3.1） |
| 换宿主端口（非 3000/8080） | 需要额外一份 `!override` 端口文件，本次未接线 | 按 `DEPLOY.md` FAQ 接线后实测 |
| `ADMIN_PASSWORD` 后台面板与设置保存 | 默认关闭，未启用 | `sudo chown -R 1001:1001 data` 后启用再验证 |
| `ACCESS_CODE_LIST` 访问码链路 | 未启用 | 填一户访问码后从 UI 验证 |
| 上游其它部署路径（Vercel / Cloudflare Workers / EdgeOne / Electron 桌面版 / MCP server） | 超出本技能范围 | 单独评估 |
| SSE 长响应（推理模型跑满几分钟） | 冒烟用的是最小提示词 | 用长提示词压一次，观察反代/超时行为 |

## 3. 已知风险

| 风险 | 实测证据 | 影响 / 处理 |
| --- | --- | --- |
| `data/` 不可被容器写 | 宿主 `data/` 为 `root:root 755`（compose 创建）；容器内 `uid=1001(nextjs)` `touch /app/data/...` → `Permission denied` | 不影响运行与聊天；启用后台面板前 `sudo chown -R 1001:1001 data` |
| 无任何访问门槛 | `.env` 中 `ACCESS_CODE_LIST` / `ADMIN_PASSWORD` 为空，`/api/config` 返回 `accessCodeRequired:false` | 任何能连到 3000 端口的人都能消耗服务端 key 的额度。对外暴露前务必设访问码或加反代鉴权 |
| 密钥以明文存于 `.env` | `chmod 600`，仅本用户可读 | 不要提交、不要贴日志；轮换时改完 `./deploy.sh up` |
| 浮动 tag | `node:24-alpine`、`jgraph/drawio:latest` 均未固定 digest | 上游 tag 移动会导致下次构建内容变化；要可复现需固定 digest |
| drawio 镜像体积 | 1.35 GB（应用镜像仅 351 MB） | 磁盘占用主要在 drawio 与构建缓存 |
| 构建缓存占用 | 本机 build cache 4.8 GB（含其它项目缓存） | `docker builder prune` 可回收，代价是下次构建变慢 |
| 上游 Turbopack 警告 | `Encountered unexpected file in NFT list`（2 处，指向 `next.config.ts` → `lib/server-model-config.ts`） | 上游自身问题，构建仍成功；如打包体积异常再回看 |
| npm 12 拦截 install script | `9 packages have install scripts not yet covered by allowScripts` | 见 §4 偏离表第 3 行；实测不影响运行与出图 |
| 3000/8080 是常用端口 | 部署前检测为空闲，部署后由本项目占用 | 与本机其它服务冲突时按 FAQ 换端口 |

## 4. 与官方流程的偏离表

| 偏离项 | 原因 | 影响 |
| --- | --- | --- |
| 用 `dockerfile_inline` 复制了一份上游 Dockerfile，只多 3 行（npm registry + 跳过测试用二进制） | 上游 Dockerfile 没有 registry 入口；实测 BuildKit **不会**把未声明的 `--build-arg` 注入成环境变量（`NPM_CONFIG_REGISTRY` 传了也不会出现在 `env` 里） | 上游 Dockerfile 变更后需重跑 `tools/gen-override.py`；`deploy.sh doctor` 已内置漂移检测（剥离注入段后与 `upstream/Dockerfile` 逐字节比对） |
| 新增 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` | 避免构建期额外下载约 500 MB 测试用浏览器 | 只影响仓库自带 e2e 测试；`next build` 不跑测试，应用运行无关 |
| 9 个包的 install script 未执行 | npm 12 默认拦截（上游 CI 用同样的 `npm install`，行为一致，非本部署引入） | 逐项核过：`esbuild`/`sharp`/`unrs-resolver`/`workerd` 的预编译产物都由 `optionalDependencies` 平台包提供，不依赖 postinstall；运行时未加载 `.node`，`next build` 与出图均正常。若将来依赖某个 install script 生成的产物，会在 install 期产物冒烟或业务冒烟暴露 |
| 覆盖层把 `build.args` 从列表改成映射（`!override`） | 需要注入 registry 与 `NEXT_PUBLIC_SELFHOSTED`；上游是列表格式，类型不一致 | 无功能影响；承载了"自建实例不显示赞助文案"的意图 |
| 未使用官方预构建镜像 `ghcr.io/dayuanjiang/next-ai-draw-io:latest`（已确认存在） | 官方镜像把 `NEXT_PUBLIC_DRAWIO_BASE_URL` 固化为 `https://embed.diagrams.net`（`Dockerfile:26` 的默认值，CI 只覆盖了 `NEXT_PUBLIC_SHOW_ABOUT_AND_NOTICE`），在国内不可靠；上游 compose 的设计就是本地构建并指向自建 drawio | 首次部署多花约 2 分钟构建、351 MB 镜像；换来 drawio 完全自建 |
| `deploy.sh` 额外提供 `smoke` 子命令，`verify` 内含业务冒烟 | 契约要求"就绪 ≠ 业务可用"；本项目就绪判定只能证明 HTTP 活着 | 无；`verify --skip-ai` 可关掉模型调用 |
| 覆盖层不重复声明 `ports` | compose 对 `ports` 是拼接语义，重复声明会让同一宿主端口绑定两次并报错（避开了这个坑） | 换端口需要额外的 `!override` 文件，该方案未实测 |

## 5. 部署假设表（最终版）

| 假设 | 证据 | 初始置信度 | 实测结论 |
| --- | --- | --- | --- |
| 仓库自带 compose，可直接复用 | `upstream/docker-compose.yml:1` | 高 | ✅ 确认。两服务 `drawio` + `next-ai-draw-io` 按预期拉起 |
| 应用必须配 provider + key，否则功能不可用 | `upstream/env.example:5,86`；`upstream/lib/ai-providers.ts:740,748,1072` | 高 | ✅ 确认。缺 `AI_MODEL` 会直接抛 `AI_MODEL environment variable is required`（`ai-providers.ts:745`） |
| `AI_MODEL` 必须是 provider 侧真实模型 ID | `GET https://api.deepseek.com/models` 实测返回 `deepseek-flash`/`deepseek-v4-pro` | 高 | ✅ 确认。"DeepSeek v4.1 flash" 对应 `deepseek-flash`（`name: DeepSeek-V4.1-Flash`） |
| 就绪判定可用 `GET /api/config` | `upstream/app/api/config/route.ts:3`（无鉴权返回 JSON） | 高 | ✅ 确认。稳定返回 200；`/` 走 307 跳转，不适合直接做判定 |
| `NEXT_PUBLIC_DRAWIO_BASE_URL` 是构建期变量，官方镜像里固化为官方 CDN | `upstream/Dockerfile:26`、`upstream/.github/workflows/docker-build.yml`（只覆盖 `NEXT_PUBLIC_SHOW_ABOUT_AND_NOTICE`） | 高 | ✅ 确认。自建构建后客户端 chunk 里是 `http://localhost:8080` |
| 端口 3000/8080 由上游写死 | `upstream/docker-compose.yml:4,11` | 高 | ✅ 确认。且 compose 对 ports 是拼接语义，覆盖层不能简单改端口 |
| `./data` 卷持久化后台设置 | `upstream/docker-compose.yml:16`、`upstream/lib/admin/settings.ts:24` | 高 | ⚠️ 部分确认。挂载与读取路径正确，但宿主目录 `root:root 755` 导致容器内 uid 1001 **写不进去**（只有后台面板保存设置需要写） |
| 上游 Dockerfile 可在本机无 C 编译器环境构建 | `upstream/Dockerfile:1`（多阶段 alpine） | 中 | ✅ 确认。原生产物全部来自预编译平台包，构建全程未触发 node-gyp |
| 需要 healthcheck 或迁移步骤 | 全仓库 compose 无 `healthcheck`，无迁移入口 | — | ✅ 确认**没有**：就绪只能靠"容器存活 + 端口监听 + HTTP 语义"组合判定 |
| 首次启动需要初始化/迁移 | — | 低 | ✅ 证伪。无需迁移，启动即 `Ready`，`data/settings.json` 缺失被正常忽略（非 ENOENT 才报错，`settings.ts:45`） |
