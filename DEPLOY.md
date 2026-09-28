# 部署与维护

本目录部署两个服务：Next AI Draw.io（3000）和自建 draw.io（8080）。
局部编辑已经接入主应用的 `/api/scoped-edit`，无需独立模型服务或 8787 端口。

## 环境要求

- Linux、Bash、Python >= 3.9、curl、ss（iproute2）、sha256sum。
- Docker Engine >= 24 且可供当前用户使用；Compose >= 2.24.4，支持 `dockerfile_inline` 和 `!override`。
- 建议预留至少 6 GB 磁盘空间供镜像与构建缓存使用；实际需求随依赖变化。
- 端口 3000、8080 可用；构建机器能够访问 Docker Registry、Alpine 软件源和 npm 镜像源。
- 可用的模型账号；默认模板使用 DeepSeek，模型 ID 以提供方实际支持为准。

宿主机无需 Node.js、npm、PyYAML；Node 依赖在镜像中安装。
默认不安装系统软件，不改全局 npm 配置，不自动改已有 data/ 的权限。
`setup.sh --install-deps` 显式启用 Ubuntu 24.04 的缺失依赖安装。

## 一键环境检查与部署

```bash
./setup.sh
```

顺序为系统工具和版本检查 → Docker 权限及端口检查 → 首次模型配置 →
构建启动 → HTTP 就绪和插件加载校验 → 输出访问地址。
默认部署不执行局部编辑规则冒烟，也不调用模型。
最低版本为 Docker Engine 24、Compose 2.24.4、Python 3.9，脚本会实际比较版本。
磁盘空间不足建议的 6 GiB 时提醒；网络可用性以实际镜像构建与模型冒烟为准。

首次交互运行会询问 DeepSeek 模型 ID 和 API key（不回显），生成权限 600 的 .env。
已有配置原样保留。无人值守运行时先用 deploy.sh init 创建并填写 .env；
若配置缺失，脚本生成空模板并退出，不会挂起等待，也不会用空 key 继续部署。

| 命令 | 用途 |
| --- | --- |
| `./setup.sh --check` | 只读检查环境和已有配置；配置缺失或版本过低返回非零 |
| `./setup.sh --install-deps` | Ubuntu 24.04 下通过 apt 安装缺失依赖，然后部署 |
| `./setup.sh --with-ai` | 部署后额外实际调用聊天和局部编辑模型，消耗额度 |
| `./setup.sh --install-deps --with-ai` | 补齐依赖、部署并验证模型链路 |

依赖安装使用 Ubuntu 已配置的 APT 源，需要 root 或 sudo；不替换系统源、不自动升级已有软件，
不卸载现有包。缺失项对应 docker.io、docker-compose-v2、python3、curl、iproute2、coreutils。
新安装 Docker 后用 systemctl 启用服务；其它发行版、已有版本过低、现有 Docker 未启动或权限不足，
按提示由管理员处理。安装 Docker 不会自动把当前用户加入 docker 组，授权后需重新登录再运行。
国内 npm 源仍沿用 registry.npmmirror.com，系统 APT 源由机器管理员维护。

自动安装分支与现有 Docker 安装共存时，不替换 Docker 引擎；缺 Compose 时仅安装 Compose 包。
当前实测平台及未覆盖项见 deploy-report.md。

## 首次部署

使用完整部署包（包含定制后的 `upstream/`）。在包所在目录校验并解压：

```bash
sha256sum -c next-ai-draw-io-scoped-<时间戳>.tar.gz.sha256
tar -xzf next-ai-draw-io-scoped-<时间戳>.tar.gz
cd next-ai-draw-io
./deploy.sh init
```

编辑 `.env`，填写 `DEEPSEEK_API_KEY`，确认 `AI_MODEL`。不要把真实密钥写入 `.env.example`。
`init` 创建的配置权限为 600；配置已存在则保留。

```bash
./deploy.sh
```

不带参数等价于 `./deploy.sh deploy`：校验配置 → 生成插件入口 → 构建应用 →
准备固定 draw.io 镜像 → 后台启动 → 等待两个服务就绪 → 校验插件文件。
首次构建需要数分钟；依赖下载取决于网络。构建输出保存在 `logs/build.log`。
拉取或构建失败会以非零状态退出，不会宣称部署成功。

访问 <http://127.0.0.1:3000/>。模板中未设置访问码；
需要限制模型额度使用者时设置 `ACCESS_CODE_LIST` 并运行 `./deploy.sh up`。
后台 `/admin` 只有设置 `ADMIN_PASSWORD` 才启用，无预设账号密码。

## 常用命令

| 命令 | 用途与影响 |
| --- | --- |
| `./deploy.sh --help` | 查看命令 |
| `./deploy.sh environment` | 仅检查系统环境、版本、端口和磁盘，不要求 .env |
| `./deploy.sh doctor` | 只读检查环境、配置、源码、生成物和端口，不创建配置 |
| `./deploy.sh install` | 构建应用、准备 draw.io 镜像，验证 standalone 及局部编辑路由 |
| `./deploy.sh up` | 使用已有镜像启动并等待就绪；不自动重建应用 |
| `./deploy.sh deploy` | 构建并启动，适合源码修改后的更新 |
| `./deploy.sh status` | 两个服务的状态和地址；未就绪返回非零 |
| `./deploy.sh logs [服务]` | 跟随日志，服务名为 next-ai-draw-io 或 drawio |
| `./deploy.sh smoke` | 验证规则和选区 guard，调用聊天与局部编辑模型；消耗模型额度 |
| `./deploy.sh verify --skip-ai` | 验就绪、插件、规则、幂等、停止清理、重新启动；会短暂停服 |
| `./deploy.sh verify` | 同上，并调用模型验证两条业务链路 |
| `./deploy.sh plugin-check` | 重启和重建 draw.io 后验证插件；画布会短暂中断 |
| `./deploy.sh package` | 生成含定制源码的部署包及哈希清单，不包含凭据与运行数据 |
| `./deploy.sh down` / `reset` | 删除本项目容器及网络，保留 data/ 和镜像 |
| `./deploy.sh reset --purge` | 交互输入 DELETE 后删除 data/；非交互终端拒绝执行 |

`verify` 使用已有镜像；请先运行 `deploy` 或 `install`，以免验证的仍是旧应用。
`WAIT_TIMEOUT=360 ./deploy.sh up` 可以延长就绪等待时间。

## 配置变化如何生效

| 配置或文件 | 生效方式 |
| --- | --- |
| AI_PROVIDER、AI_MODEL、API key、ACCESS_CODE_LIST、ADMIN_PASSWORD | 修改 .env 后运行 `./deploy.sh up` |
| DRAWIO_PUBLIC_URL | 浏览器构建期地址，修改后运行 `./deploy.sh deploy` 重建应用 |
| AI_SCOPE_ENDPOINT | 插件直连后备地址/CSP，修改后运行 `./deploy.sh up` 更新入口，再刷新浏览器 |
| upstream/ 下源码 | `./deploy.sh deploy` |
| ai-scope.js | `./deploy.sh up` 会自动更新指纹，随后刷新浏览器 |
| 生成器模板 | 先 `python3 tools/gen-override.py`，再 `./deploy.sh deploy` |

AI_PROVIDER 决定服务端提供方，AI_MODEL 决定默认模型；前端模型设置可以覆盖服务端默认配置。
默认值来自部署模板，并非偷偷写入画布。换提供方时参考 `upstream/env.example` 和
`upstream/lib/ai-providers.ts` 配置对应 key；不能只更换模型名字而保留不兼容的提供方。

同网段访问：把 `DRAWIO_PUBLIC_URL` 改为 `http://<主机IP>:8080`，
`AI_SCOPE_ENDPOINT` 改为 `http://<主机IP>:3000`，再运行 `./deploy.sh deploy`。
这两个地址由浏览器访问，不能填 Docker 服务名。跨机、HTTPS 反代和子路径部署未在本次实测中覆盖。

## 生成物与版本

- `docker-compose.yml` 由 `tools/gen-override.py` 生成；上游 compose 在前、覆盖层在后叠加。
- `PreConfig.js` 和插件指纹由 `tools/gen_drawio_custom.py build` 生成，勿手改哈希。
- draw.io 固定为本机验证的 31.4.6 镜像 digest（见生成器与 image.lock.json），不跟随 latest 自动升级。
- Node 基础镜像仍为上游的 `node:24-alpine`，构建沿用上游 `npm install`，所以整个构建并非完全锁定。
- 国内 npm 源默认 `https://registry.npmmirror.com`，可用 NPM_REGISTRY 配置；未启用第三方 GitHub 加速。
- 应用使用 webpack 构建覆盖上游默认构建命令；源码功能改动见 `docs/ARCHITECTURE.md`。

PreConfig 通过只读挂载覆盖官方入口，插件挂在 `plugins/custom/`，不会覆盖官方插件。
draw.io entrypoint 可能打印无法写 PreConfig 的警告；这是此挂载方式的已知表现。
其运行期 SSL、context path 改写也会被跳过；本部署验证的是 8080 HTTP 访问。

## 数据与交付

`data/` 保存后台设置，需容器 UID 1001 可写。首次目录不存在时，脚本仅为新目录设置 UID；
已有目录不自动改权限。有权限报错时，先备份并核对目录属主，再由管理员调整。
绘图和会话包含浏览器侧存储；重要图形请从应用导出，不能仅靠备份 data/。

`./deploy.sh package` 采用交付文件清单，保留源码与上游 LICENSE，
排除 .env、data、logs、node_modules、.next、Git 历史和实验目录。
部署包不含 Docker 镜像，新机器仍需联网拉取和构建，不是离线安装包。
工作区中的历史原型不移动、不删除，历史部署说明放在 docs/history/。

## 常见问题

- **重新部署后局部修改不存在**：确认复制的是完整定制包。官方仓库没有本地新增的 scoped-edit API 与主窗口代理。
- **旧版编号/面板仍在**：先 up 刷新插件指纹，再刷新浏览器；必要时强制刷新。
- **模型请求失败**：运行 smoke；排查提供方、模型 ID、key、余额、网络和访问码。脚本不会打印密钥或将模型原始响应存入交付包。
- **Failed to fetch / 8787**：生产环境不使用原型服务；检查新插件是否加载、主页面是否为新构建、AI_SCOPE_ENDPOINT 是否可由浏览器访问。
- **端口冲突**：脚本会停止，先定位占用服务；当前交付固定 3000/8080，不支持仅用变量改端口。
- **更换机器后无法构建**：运行 doctor；确认 Docker Registry、Alpine 和 npm 源可达，以及 Compose 版本足够。
