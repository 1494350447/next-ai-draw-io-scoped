# 服务器部署

默认两个容器，浏览器只访问主应用入口。Next.js 在内部网络将 `/drawio/*` 代理到 `http://drawio:8080/*`；draw.io 不发布宿主机端口。内部服务名固定，不需要配置公网地址。

## IP 与端口

`.env` 中设置：

```dotenv
APP_BIND_ADDRESS=0.0.0.0
APP_PORT=3000
COMPOSE_PROJECT_NAME=next-ai-draw-io
NEXT_PUBLIC_BASE_PATH=
DRAWIO_PUBLIC_URL=
AI_SCOPE_ENDPOINT=
```

填写模型配置后执行 `./deploy.sh deploy`，浏览器访问 `http://服务器IP:3000/`。外部只需放通应用端口。更换服务器 IP 不需要重建；修改 `APP_PORT` 或监听 IP 后运行 `./deploy.sh up`。

## 域名与 HTTPS

宿主机已有 Nginx/Caddy/宝塔时，设置 `APP_BIND_ADDRESS=127.0.0.1`，将外部入口的全部路径转发到应用。域名和 TLS 证书交给反代管理。下面的 Nginx `location` 放入已配置证书的 HTTPS `server`：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 180s;
    client_max_body_size 20m;
}
```

`20m` 是入口上传限额示例，可按实际附件需求调整。反代超时需要覆盖模型等待时间；不要缓存 API 响应。前面还有 CDN/负载均衡时，也要检查该层的流式响应和超时限制。默认同源模式不需要把域名写入构建参数。

若反代本身在容器中，应接入应用的 Docker 网络并代理 `next-ai-draw-io:3000`，不能使用反代容器自己的 `127.0.0.1`。共享网络中的多实例应使用唯一网络别名，避免同名服务冲突。可用额外 Compose 覆盖文件管理网络；不要直接修改生成的覆盖层。

公网使用时配置 `ACCESS_CODE_LIST`，在主页面设置里填写访问码。服务器密钥保留在 `.env` 或后台配置中。

## 子路径

例如部署到 `https://example.com/tools/diagram/`：

```dotenv
NEXT_PUBLIC_BASE_PATH=/tools/diagram
```

执行 `./deploy.sh deploy`。前缀必须由 `/` 开头，无尾斜杠；允许字母、数字、下划线、连字符及多层路径。Next.js 的路径前缀是构建期配置，修改后需要重建。

反代应保留前缀。例如 Nginx 使用 `location /tools/diagram/`，仍配置 `proxy_pass http://127.0.0.1:3000;`，不要在该 upstream 地址后追加 `/` 来剥离前缀。浏览器访问：

| 内容 | 地址 |
| --- | --- |
| 主应用 | `/tools/diagram/zh` |
| 画布 | `/tools/diagram/drawio/index.html` |
| 插件 | `/tools/diagram/drawio/plugins/custom/ai-scope.js` |
| 局部编辑 | `/tools/diagram/api/scoped-edit` |

语言切换、页面导航及刷新也必须保留前缀。部署脚本自动从 Compose 解析前缀，检查同样的路径。

## 多实例

每个实例使用独立项目目录、`.env`、`data/`、生成的插件配置、Compose 项目名和宿主端口。例如另一份目录设置 `COMPOSE_PROJECT_NAME=drawio-team-b`、`APP_PORT=3301`。

修改项目名会创建新实例，不会停止或迁移旧实例；停旧实例应在旧目录、旧项目名下执行 `./deploy.sh down`。不要在同一目录中仅切换项目名来部署多套，因为这会共享数据和插件配置。

服务器数据位于 `data/`，图形和会话还使用浏览器存储。更换访问 origin 后浏览器存储不自动迁移，重要图形请提前导出。

## 从旧版升级

1. 保留 `.env` 和 `data/`，替换或合并项目源码。
2. 普通部署清空 `DRAWIO_PUBLIC_URL`、`AI_SCOPE_ENDPOINT`；移除旧的 `localhost:8080`、`服务器IP:8080` 配置。
3. 按需填写应用端口、监听地址和子路径。
4. 执行 `./deploy.sh deploy`，再执行 `./deploy.sh status`。

`up` 只启动已有镜像；脚本会拒绝缺少新构建记录或前缀/画布地址不匹配的旧镜像。源码修改仍须运行 `deploy`，配置一致不等于源码版本一致。

## 独立画布与调试

`DRAWIO_PUBLIC_URL` 可指定独立、可由浏览器访问的完整画布入口，例如 `https://canvas.example.com/index.html`，改变后重建。该画布必须部署本项目的插件及 PreConfig；官方公共画布没有本项目的局部编辑插件。

嵌入画布仍通过主应用转发局部编辑请求，不需要跨域直连。HTTPS 主应用应使用 HTTPS 画布。直接打开独立画布时，可用 `AI_SCOPE_ENDPOINT=https://app.example.com/tools/diagram` 指定应用根地址；该模式不自动获取主页面访问码或模型选择，设置访问码后推荐从主应用使用。

默认入口检查验证本项目内部画布；独立画布还必须从浏览器另行验证。

本机调试若确实需要直接访问 8080，可临时叠加调试配置：

```bash
docker compose --project-directory "$PWD" --env-file .env \
  -f upstream/docker-compose.yml -f docker-compose.yml \
  -f docker-compose.debug.yml up -d drawio
```

这只发布 `127.0.0.1:8080`；运行正常 `./deploy.sh up` 会撤销调试端口。

## 验证

每次部署验证：应用 API、同源画布 HTML、PreConfig 与插件哈希、官方插件资源。检查不会调用模型。

```bash
python3 -m unittest discover -s tests -v
node --test tests/plugin-channel.test.cjs
./deploy.sh status
```

浏览器发布验收脚本为 `tests/server-browser.cjs`，需 Node.js、Playwright 和 Chromium。安装依赖可在 `upstream/` 执行 `npm ci` 及 `npx playwright install chromium`，随后在项目根目录执行：

```bash
NODE_PATH="$PWD/upstream/node_modules" APP_URL=http://127.0.0.1:3000 \
  node tests/server-browser.cjs
```

`APP_URL` 包含部署前缀（如 `https://example.com/tools/diagram`）；若配置访问码，用 `TEST_ACCESS_CODE` 提供。可用 `CHROME_PATH` 指定已有浏览器。脚本用独立浏览器上下文验证画布、插件、超过五秒的规则请求、选区写回与导出，不调用模型，不修改现有浏览器会话。

发布矩阵应包含：IP/端口、更换端口、域名 HTTPS、子路径、访问码、慢请求。公网 DNS、证书及安全组还需在目标服务器检查。本机代理模拟测试不代表任意云平台均已验证。
