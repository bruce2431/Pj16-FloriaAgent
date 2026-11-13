# 内置网关服务层（gateway）

> 本文件属 `docs/` 文档库。
> 网关 = `src/gateway/localGateway.ts`（node:http + ws），随 `feature('PRIVATE_GATEWAY')`（默认开）编译进 exe；`/server on` detached spawn 自身 exe 以 `--gateway` 独立进程长驻，CLI 退出不影响网关。flag 审计 → [build.md](build.md)；web 界面链路定案 → [web-ui.md](web-ui.md)；术语 → [glossary.md](glossary.md)。改动本文件覆盖的任一链路时必须同步更新本文。

## 1. API 前缀与端点总览

端点全挂 `/gateway/<端点>`：health（响应带 `boot` = 本网关进程启动时刻；前端据此区分「同网关刷新」与「换了网关」，见 web-ui.md §58）/ activate / shutdown / eject / sessions / plugins / models / models/catalog / model / model-report / wsession[/stop] / diagnostics / session[/rename / .queued] / backend / project / file / file-cache / conversation / activity / events。根 `/api` 撤空（不保留旧路径、无兼容双挂）。**不变量**：网关与 `/backend/<label>/` 代理页面共享同一 origin，端点若挂根，被代理页面写死的绝对路径会误打网关自身；前缀化后写错只 404，永不误伤网关（「故意打网关」的预览页显式用 `/gateway/*`）。CLI 侧 `gatewayClient`/`conversationDisplay`/`server`、前端 `app.js`/`sw.js` 同此前缀。**唯一例外**：`readyPath` 缺省 `/api/system_stats` 是项目后端（ComfyUI）自身 API，勿迁移。总门鉴权 `startsWith('/gateway/')`（health/activate 公开），sw 缓存排除同步 `/gateway/`。

**文件缓存 `file-cache`（附件与粘贴图片共用一条链）**：`<会话启动根>/.claude/file-cache/<dirKey>/`，`dirKey` = 会话 uuid（`getSessionId()` 的目录名；与 sid 解码所得同源），无会话归属（首页首送前上传）= `_pending`。**`dirKey` 不编码项目**，读写都必须带 `sid`（或 `project` label）让网关解析出会话启动根。

- **统一上传 `POST /gateway/upload?sid=&project=&workFile=&kind=image|file&slot=&name=`**：body = 原始字节（上限 20 MB，超限 413），只负责收字节 / 命名 / 落盘 / 鉴权；落点目录与正文引用由槽位（slot）决定。
  - 上下文：`project` = findProjects 命中的 label，未知 **404**；`sid` 两种形态都可（完整 base64url(jsonl 路径) 或 web 路由 hash 的裸 uuid，`resolveUploadSession` 解析），显式给出但解析不到 **400**；`workFile` 必须项目内已存在文件（越界 403 / 不存在 400）；document 槽位缺 workFile → 400（槽位声明 `fallback:"session"` 除外）。任何上下文错误都不静默落到网关自身根。
  - 命名：前端只传原始 `name`；`sanitizeEntryName` → `-YYYYMMDDHHMMSS` 时间戳 → 同名 `-1/-2` 独占序号（`flag:'wx'`，并发同名不覆盖）全在网关。响应区分 `originalName`（清洗后原名）与 `name`（最终落盘名）。
  - 槽位解析序：显式 `slot`（未知 400）→ 项目 `<项目根>/.claude/file-upload.json` 声明（priority 降序、同序按声明顺序；扩展名与 kind 同时命中）→ 内置 `document-markdown`（`.md/.markdown`）→ 内置 `session`（`reference` 恒空）。有 workFile 但无文档槽位：声明 `fallback:"reject"` → 400，否则回落 session 并回 `fallback:true, fallbackReason:"no-document-slot"`。
  - 落点：session 作用域 = `<会话启动根>/.claude/file-cache/<会话uuid|_pending>/`（sid 优先，无 sid 时带 project 落该项目根 `_pending`，两者不一致以 sid 为准并写网关日志）；document 作用域 = `dirname(项目内 workFile)/<slot.storage.directory>/`。
  - 响应恒含 `{ok, slot, scope, originalName, name, storedPath, relativePath, reference, url, size, fallback}`（`fallbackReason` 仅回落时出现），**不返回绝对路径**。`reference` 由 `reference.format` 生成：`markdown`（image → `![名](路径)` / file → `[名](路径)`，路径 `encodeURI`）、`latex-includegraphics`（`\includegraphics{路径}`，TeX 特殊字符单独转义）、`template`（≤512 字符、恰一处 `{{$path}}`）、`none`（恒空）。`pathPrefix` 只改引用路径、不改物理目录。
  - **声明 schema**（`.claude/file-upload.json`，`version:1`）：`{version, fallback?, slots:[{id, priority, match:{workFileExtensions, uploadKinds}, storage:{scope:'session'|'document', directory}, reference:{format, template?, pathBase?, pathPrefix?}, fallback?}]}`。整份非法即忽略并写日志，单条非法丢该条：id `^[a-z][a-z0-9-]{0,31}$` 且不得占用内置 `session`/`document-markdown`；priority 整数 −10000..10000；扩展名 `^\.[a-z0-9]{1,10}$`；`directory` 项目相对、非绝对、无反斜杠、无 `.`/`..` 段；`pathBase` 仅允许 `workFileDirectory`。
  - **兼容写口**（保留一个版本周期）`POST /gateway/file-cache?name=&sid=&project=`：内部转调同一落盘（不二次加戳），返回旧格式 `{ok, name, rel, size}`，sid 非法按旧语义回落 project / 网关根。
- **读** `GET /gateway/file-cache/<dirKey>/<key>?sid=<会话hash>[&project=<label>]`：基址解析序 sid（`resolveUploadSession`）→ project label → 网关自身根；`key` 为完整文件名（附件）或纯数字 id（粘贴图片，按 `<id>.` 前缀在目录内解析扩展名）。禁 `/`、`\`、`..`；命中即回 `Cache-Control: private, no-cache` + 按扩展名 MIME，未命中 404。
- **清理** `cleanupOldFileCaches()`（`src/utils/fileCache.ts`）：只扫 `getProjectRoot()/.claude/file-cache`（各项目只清自己的），删非当前会话目录、跳过 `_pending`，全空则移除基目录。
- **图片侧**：CLI `processUserInput → storeImages` 落同一目录（`<id>.<ext>`，`imageStore.getImageStoreDir()` = `getSessionFileCacheDir(getSessionId())`，基址 `getProjectRoot()`），无独立 image-cache 目录、无第二套清理。
- **文件占位相对化**：`[文件:<路径>]` 占位仍按会话 cwd 相对化（abs → rel，跨盘回绝对），与缓存目录位置无关；wsession 响应附 `cwd` 供新会话首送使用（`readSession` 记录缺失分支同样从 id 编码路径派生 cwd）。前端入口 = + 浮窗「上传文件」行（web-ui.md §23）。

**安全加固**：HTTP 数据接口与 WS 升级一致要 token——`/gateway/*`（除 health）与 `/preview/*` 一律校验，失败 401；CLI 侧上报（`conversationDisplay.ts`）经 `src/utils/gatewayToken.ts` 读 token 附加；前端所有数据请求/EventSource/预览 iframe 带凭据（token 门锁定态不发请求、解锁后补拉）。

## 2. 认证：token 出 URL + cookie 票证 + 设备配对

**机制**：首链带 `?token=<hex>`（CLI `/server on` 打印的 localUrl/lanUrl 即首链）→ 网关 `handleRequest` 开头 query token 命中即种 `floria_auth` HttpOnly cookie（Path=/、SameSite=Lax、1 年；票证 `randomBytes(24)` 落盘便携根 `.claude/gateway/tickets` JSON 数组，`gatewayToken.ts` 存取，上限 64）；此后 `/gateway/*`、`/preview/*` 与 WS 升级改「query token 或 cookie 票证二选一」——浏览器 URL 不再带 token（`hideGate()` 清 query）。

**设备认证配对**：授权只走手动配对——①设备未授权 → 前端门显示**设备请求码**（8 位 hex，localStorage `floria-device-code` 持久、同设备恒定）；②PC `/server auth add <请求码>` 加入授权名单（票证=码本身，`.claude/gateway/tickets` {id,created} 数组，上限 64）；③设备端门态每 2.5s 轮询 `GET /gateway/activate?code=`（公开端点，防枚举靠码熵；命中 → 种 HttpOnly floria_auth 1 年）→ 自动 connect 进门过渡动画。`/server auth` 列设备、`auth off <n>` 撤销。**无任何 token 授权通道**：query token 仅剩 CLI 内部 gateway-token（上报/WS/关闭，不种 cookie）；/server on/status 不打印 token。

**设备匹配语义**：token 是钥匙、cookie 是每台设备自己记住的钥匙——token 轮换（`/server off` 清盘后再启换新）不影响已授权设备；`/server off` 清盘时同步清票证与 custom token（全设备掉线）。

**gateway/token 稳定密钥**：token 改「读盘-or-创建」（`startLocalGateway` 与 `/server on` spawn 链同序：显式覆盖 > 读盘 > 随机），仅 `/server off` 清盘后轮换；落盘时机在 **listen 成功回调**（否则多进程抢起网关时 bind 失败者会覆盖盘上胜者 token → 全部 CLI `/clients` 注册 401：侧栏无状态 / web 误 spawn resume / 消息悬空 / session-delta 断流）。**不变量**：「盘上 token/port 恒描述现网关，只有端口持有者可发布」。CLI 侧 `gatewayClient` 每轮探测重读盘上 token（3s TTL），对齐后 ≤10s 自动重连，无需重启进程。

**前端门控**：`needToken()` =「`GATEWAY && !gateVerified`」（gateVerified 声明提前）；`initGateway` 统一先 `connect()`（cookie 有效 WS 直过 → `hideGate` 直进空态，无效 onclose 回 token 门）；门内输入 token 先 HTTP 预验证（种 cookie）再 connect；`apiUrl` 仍附加 gToken（空串无害，网关看 cookie）。

**访问地址（mDNS 自广播 `floria.local`）**：同 WiFi/热点设备一律 `http://floria.local:<port>/`，换网络/换 IP 免配置免重授权（授权按设备码恒定）；**仅支持 Apple/Windows**（`/server` 只输出该唯一地址、不列 IP 直连；Android `.local` 解析差不支持）。本机 hosts `127.0.0.1 floria.local` → 本机走 hosts、远程走 mDNS（floria.com 是公网真实注册域名，勿用作别名）。**红线：该 hosts 条目只允许存在于网关所在机**（解析到自身，经 `0.0.0.0` 监听可达）；其它设备一律靠 mDNS，在非网关设备上写 `127.0.0.1 floria.local` 会使其把域名解析到自身、页面恒打不开（网关代码从不读写 hosts，此条纯人工，**勿在客户端抄用**）。

**设备自报类型 hint**：iPadOS Safari 桌面模式 UA 与 macOS 全同，网关按 UA 判设备恒显示 Mac——iPad 判定只能前端做（`navigator.platform==='MacIntel' && maxTouchPoints>1`，app.js `deviceHint()`），随 activate 轮询与 WS 连接 query `device=` 上报，网关记 `.claude/gateway/devices` 的 `hint`（`touchGatewayTicket` 第 4 参），`/server auth` 展示 hint 优先于 UA 判定（存量票证 WS 重连即补齐）。

## 3. 局网零配置 mDNS 应答器

`localGateway.ts` 手写最小应答器（~150 行，无新依赖；bun compile 下 dgram 多播 bind/addMembership/send 可用）：HTTP listen 成功且 host=`0.0.0.0` 时 UDP 5353 入多播组 224.0.0.251（逐局域网接口入组，WiFi/热点并存全覆盖），应答 `floria.local` 的 A/ANY 查询——A 记录实时读全部局域网 IPv4（过滤 169.254/198.18/100.64-127 虚拟段，TTL 300s）；**应答双发：多播组 + 单播回源**（AP 的 IGMP snooping/多播抑制常丢多播回程；mDNS 应答幂等收两份无害）；5353 被占/入组失败静默放弃回落 IP 直连（自动路径禁抢端口）；`stopLocalGateway` 一并 `mdnsStop`。首次可能触发 Windows 防火墙 UDP 5353 入站放行提示（允许一次）。

**socket 绑定真实 LAN 地址**：监听 socket `bind(5353, mdnsLanAddrs()[0])` 而非 0.0.0.0——Windows 下「socket 绑特定单播地址时多播默认出接口=该地址所属接口，压过 224.0.0.0/4 路由 metric」，否则 Meta/Clash TUN（198.18.0.1，默认路由 metric 最小）在线时应答整个被吸进隧道（查询入站正常、应答从未上 WLAN 空气）；bun 的 `setMulticastInterface` 在 Windows 无效（不抛错不生效），bind 具体地址实测有效；`mdnsHandleQuery` 另补 QR 位检查（无参 addMembership 落默认接口，自听回环应答会成反馈循环）。无 LAN 地址回退 0.0.0.0。

**网络切换自愈**：bind/入组按启动时网卡定，换网后旧 bind 地址失效 → 新网段查询收不到；`mdnsWatch` 每 30s 读网卡与 socket 集合 **diff 增量增删**（关消失接口的 socket、补新接口，`mdnsPendingBinds` 占位防 bind 异步期重复发起）——必须增量化：热点 IP 每分钟抖动，全量 stop/start 会把健康接口一起拆掉、服务网段出现无人应答窗口；无地址（断网抖动瞬间）不动，避免降级 0.0.0.0 被 TUN 吸走多播。

**单播 announce（吞多播网络的替代路径）**：iPhone 热点/AP 隔离网络吞 mDNS 多播 → 设备查询到不了 PC，补主动推送 `mdnsAnnounceOne`：对每个 LAN IP 的 socket 向同子网全部主机地址（`mdnsSubnetPeers` 枚举，排除网络/广播/自身；网段总地址数>512 跳过——校园网 /16 是 AP 隔离环境，单播同样不通）单播发送。**格式 = legacy unicast response**：header QR=1 AA=1 ID=0 QD=1 AN=1 + floria.local A IN 问题段 + 0xc00c 压缩指针 A 记录、TTL 300s、目的端口 5353；CLASS=0x0001，RFC 6762 §18.11 单播应答禁 cache-flush 位 0x8001（iOS 严格实现会拒收，新鲜度靠重发）；带问题段走常规应答通道。触发四路：socket bind 成功 **3 连发（0s/1s/2s，RFC 6762 §8.3 announce ≥2 次语义）**、60s 周期单发（TTL 之半无断档）、watch 网络切换重建后新 socket bind 即推、**收到任一 mDNS 查询即对该源单播回推一份**（30s/源节流表 `mdnsAnnounceSeen`，含 _companion-link 等系统查询——覆盖设备亮屏/入网瞬间先发系统查询的黄金窗口）。

**定向 announce 推送（直连客户端自愈闭环）**：AP 隔离下设备与 PC 单播互通但查询到不了 PC、查询回推收不到查询——`mdnsPushToReachableClient`：handleRequest 每请求取 remoteAddress（归一化 IPv4/滤回环/`mdnsSameSubnet` 同网段判定），命中即向该客户端**定向单播推 legacy announce 3 连发**（30s/IP 节流与查询回推共用 `mdnsAnnounceSeen`），iPad 直连一次即建立解析；定向推不受 >512 限制。**取证日志**：收到查询落盘「mDNS 查询到达：IP:port（QD=n）」+节流内「单播回推 announce → IP」（gateway.log）。

**应答三不变量（曾致「floria.local 概率性打不开」，探针 `20260916212639-mDNS域名概率性失败根修/mdns-packet-probe.ts` 可复验）**：
① 问题段一律以 `MDNS_NAME_ENC` **内联全名重编码**（A 记录统一走 `mdnsAddrRecord`），**绝不复制原字节**——打包查询里的压缩指针复制到新包会指向错位、整个应答被设备丢弃（主根因）；QU 位按 §5.4 清除。
② legacy 查询（源端口 ≠5353，Windows/Node 解析器）按 RFC 6762 §6.7 **必须回显查询 ID**，5353 → ID=0。
③ 单播 announce 无问题段时属 unsolicited，mDNSResponder 多数直接丢弃——补 RFC 6762 §8.3 **多播 announce**（`mdnsMulticastAnnouncePacket`：QD=0 + 内联全名 + class 0x8001 cache-flush）60s 周期推送，使设备缓存永不过期；单播枚举路径保留=吞多播热点/AP 网络的拓扑适配，非兜底。**TTL 300s**：配合 60s 保活正常网络下设备不再重查询；IP 变化旧缓存最多多留几分钟，由 30s watch 重绑覆盖。

**实测结论与判定口径**：iPhone 热点下设备经 `floria.local` 直连可用（换网自愈：接口变化→重绑→重新公告，网关进程未重启）；日志「mDNS 定向推（直连客户端 X）」行即域名解析与 TCP 全通。**客户端隔离网络（BIT 校园网 bit-web 型）判定口径**：ping 通 + ARP 邻居多 ≠ 单播可达（ICMP 常被设备防火墙丢弃）；判据 = 日志有无「mDNS 定向推（直连客户端 X）」行 + `netstat` 8124 有无非回环连接——两者皆零即「包没到 PC」，直接跳网络层。

## 4. 项目预览页机制

点管理视图项目胶囊一律进预览（`openProjectPreview(label, hasPreview)`）——若 `<工作区根>/<项目>/.claude/preview/` 存在（`findProjects` 探测 `hasPreview`，`/gateway/sessions` 会话附 `preview` 标志），在消息区渲染 iframe 加载 `GET /preview/<项目>/*`（默认 index.html，label 须命中 findProjects 且 hasPreview、resolve 须落 preview 目录内防越界）；无预览内返回按钮——退出预览全靠侧栏导航，`route()` 每次导航统一清 `__backendHeartbeat`；**无后端且无 `.claude/preview/` 时显示空态占位「该项目暂无预览」，不再提供宿主内置默认页**（2026-10-18 删除 `/default-preview/*` 路由与 `web/default-preview/` 资源）。真预览页由项目自己维护（自包含静态网页，可带相对 css/js），网关只做静态托管。`GET /gateway/project?label=` 保留（work 侧栏文件树消费其 `files`；响应仍带 README/会话元信息，是既有形状）。文件树由 `walkProjectTree` 扫项目根，跳过点开头条目与 `SKIP_TREE_DIRS`；**不设深度上限、不设每层 cap**（单层条目全返），只受 `TREE_BUDGET = 8000` 总节点约束（预算全局共享、沿树递减）。遍历为**广度优先**：先给每层所有目录铺开直接子项再下钻，单个巨型目录吃预算时只牺牲最深处的尾部，同级目录不会变成空壳。条目序 = 目录在前、名称按自然序（`localeCompare` 带 `numeric`，`SubPj2` 排在 `SubPj10` 前）。**label decode 防护**：`/preview/<label>` 的 `decodeURIComponent` 必须包 try-catch（decode 失败保留原文 → 404）——畸形 % 序列（如 `%ZZ`）未捕获 URIError 会崩掉整个网关进程；新增同类路由照 `/backend` 同款防护。

## 5. 远程宿主同源反代 /backend/<label>/

**动机**：iframe 直连 `http://127.0.0.1:<port>/` 只在本机浏览器成立——远程宿主上 127.0.0.1 指向设备自身 → 连接拒绝；`/preview/*` 静态兜底因子资源不带 query token 全 401，不可用。

- **路由**：`/backend/<label>/<path>?<query>` → `http://127.0.0.1:<port>/<path>?<query>`。rest/search 原样透传（保留原始 %xx 编码，不二次解码重组，防中文路径双重编码错乱）；`proxyBackendRequest` 双向流式管道（媒体大文件不落盘），请求侧剥 hop-by-hop + host + cookie（不向项目后端泄露 floria_bp 票证），响应侧剥 hop-by-hop + 上游 set-cookie（防作用域泄漏），Location 改写回 `/backend` 前缀。后端仍只绑回环。（旧 /bp/ 保留解析兼容不再生成。）
- **鉴权**：不靠 query token（页面内相对子请求必裸奔）。`/gateway/backend` 成功响应种 `HttpOnly` cookie `floria_bp`（Path=/backend、SameSite=Lax、24h）；票证存网关内存 Map（含 label 白名单，多项目并行预览互不顶掉，sweep 过期）。`/backend/*` 凭 cookie + 白名单放行，否则 401；label 须命中 findProjects 且 hasBackend，否则 404。
- **前端分流**：`openProjectPreview` 按 `location.hostname ∉ {127.0.0.1, localhost}` 判远程宿主 → iframe 用 `/backend/<label>/`（cookie 由上一拍 `/gateway/backend` 响应种下，子请求自动携带）；本机直连零开销。心跳 60s `GET /gateway/backend`（保 lastActive + 续票证）。
- **配套约束**：**经 /backend 代理的项目前端 API 一律相对路径**（根绝对路径 `/delete` 等在 /backend 前缀下会指回网关根 404）。

**断连联动收尸**：`proxyBackendRequest` 四道防线——①req 'aborted'/'close'(complete===false) → destroy 上游；②res 'close'（响应中途 writableEnded=false）→ destroy 上游；③上游 socket 180s 静默超时（按静默计非总时长）→ 504；④异常路径落请求级取证日志 `/backend <label><path> 转发中止: <原因>`。只监听 'error' 不够：隧道抖动/刷新页只触发 'aborted'/'close'，pipe 不传播断开 → 上游 socket 永挂 → 后端线程永久阻塞。配套 server 侧 `connection` 对 'end'（对端 FIN）回应 FIN——CLOSE_WAIT 不再积压。

**上传串行队列**：`proxyBackendRequest` 对 POST/PUT/PATCH（带 body）按 backend label 走 `bpForwardQueues` 串行队列逐个转发、GET/HEAD 直通（媒体大文件下载不走队列）——并发带 body 请求经 Bun node:http 兼容层 pipe 泵会卡死（重试全 400、降级串行后全 200）；转发中止取证日志带 aborted/close 来源区分与已收/声明字节数，upReq 创建推迟到轮到转发时。

## 6. Web 容器后端进程标准（preview.json backend）

> 预览页不止静态 HTML——项目 `.claude/preview/preview.json` 声明 `backend` 字段 → 网关懒加载 **spawn 后端进程**、前端 iframe **直连后端端口**（仿 Hugging Face Spaces）。实例：Pj14-AI动画制作 官方 ComfyUI 前端 + 真实 ComfyUI 后端。

### 6.1 preview.json 的 backend 字段

```json
{
  "name": "pj14-animation-workbench",
  "version": "3.0.0",
  "backend": {
    "cmd": [".venv/Scripts/python.exe", "main.py", "--port", "{port}", "--listen", "127.0.0.1", "--cpu"],
    "cwd": "../../comfyui-backend",
    "port": 0,
    "idleMinutes": 10,
    "readyPath": "/api/system_stats"
  }
}
```

- `cmd`：spawn 命令数组；`cmd[0]` 相对路径按 `cwd` resolve（node spawn 只按进程 cwd 解析，须手动 resolve）。占位符 spawn 时由 `expandBackendCmdArg` 替换：`{port}`=实际分配端口，`{previewDir}`=`<项目>/.claude/preview`，`{projectRoot}`=项目根（previewDir 上两级）。**不变量：后端 argv 的路径来源只有 preview.json 与 previewDir —— 项目无需自备 launcher 脚本去算根目录。**
- `cwd`：相对 preview.json 所在目录。
- `port`：`0` = 网关从 8130 起探测顺延（上限 8160）；显式端口则固定。
- `idleMinutes`：后端无活跃持续该时长被空闲回收（默认继承 `GATEWAY_IDLE_MINUTES`=10 分钟）。
- `readyPath`：就绪探测路径（默认 `/api/system_stats`，项目后端自身 API，非网关前缀）。
- 同一份 `backend` 段也可写在 `.claude/preview/<id>/card.json`（卡级后端）与 `preview.json` 的 `cards[i].backend`（应用卡后端），字段与解析全同（`parseBackendCfg` 单一解析器）；卡级 `cwd` 相对**卡目录**，缺省 = preview 目录。

### 6.2 网关机制（localGateway.ts）

- `findProjects` 读 `<项目>/.claude/preview/preview.json`，有 `backend` → 项目附 `hasBackend` + `backendCfg`。
- `GET /gateway/backend?label=[&card=<id>]`（受 token 保护）：带 `card` ⇒ 用该卡自身 `backend`（卡须 `enabled`，否则 404 `no backend for card`）；不带 ⇒ 项目级 backend。ensureBackend（未起则 spawn）→ `{url, port, pid, name, alreadyRunning}`；无 backend → 404。
- **进程分键**：项目级 = `label`，卡级 = `label::<cardId>`（`backendProcesses`/`backendPending`/`backends.json` 同键），同项目多卡后端并行互不顶掉。
- spawn：占位符展开（`expandBackendCmdArg`）→ cmd[0] resolve 到 cwd → `spawn`（env 加 PORT，日志落盘**该项目自己的** `<项目>/.claude/preview/backend.log`，5MB 截断轮转）；就绪探测窗口 120×200ms（容忍 ~22s 冷启动）。
- **解释器解析 = 工作区内置便携 runtime**（`backendRuntimeDirs()`）：spawn 把 `<portableRoot>/.claude/runtime/{python,python/Scripts,node}` 前置进子进程 `PATH`，故 `cmd[0]` 裸名（`python`/`node`）命中的是内置 runtime 而非机器级安装或系统 PATH（目录不存在时该 PATH 条目被系统静默忽略）——工作区整体拷走即可用。**不变量：preview 后端不依赖机器 PATH 状态。**
- spawn 失败（缺解释器 ENOENT 等）经 `child.on('error')` 记入 `spawnError` → 就绪探测循环即时退出 → 抛给路由回 500 JSON（网关不退出）。**不变量：单个后端配置失败不得终止网关进程。**
- **就绪探测用原生 net socket**（`backendReady`）：编译产物 node:http 的 request 对 aiohttp/Python 后端会挂起，net 直连写 HTTP 头读响应状态（200/404 即就绪）。
- 生命周期：`stopLocalGateway` 遍历 killAllBackends（child.kill + taskkill /F /T /PID 兜底）+ 停回收 timer；空闲回收每 60s（仅 `--gateway` 模式）。
- **`/backend/<label>/<首段>/…` 反代按首段选后端**：首段命中「已启用且有 backend」的卡（pane 卡 id / 应用卡 path 首段）⇒ 走该卡后端（键 `label::<id>`）；否则回落项目级后端。
- **开机自动拉起**：`--gateway` 模式 `server.listen` 后读全局根 `<工作区根>/.claude/preview`（card.json 卡 + preview.json 应用卡），对 `enabled && backend` 的逐个 `ensureBackend`（键 `全局根 · 散装对话::<id>`）；失败只写日志，不影响网关。
- 前端两级加载：① `/gateway/backend` 命中 → iframe 直连 + 60s 心跳防误回收；② 静态 preview；两者皆无 → 空态占位。卡有自身 `backend` 时第一级请求带 `card`，卡无 backend ⇒ 直接静态（回落项目级 backend 的旧链只用于**项目级**后端场景）。

### 6.3 后端进程生命周期解耦

**后端进程不随网关关停**：`/server off/restart`、空闲自动退出、网关被硬杀均不 kill 后端——注册表落盘 `.claude/gateway/backends.json`（label→{pid,port,startedAt}），网关重启后 `ensureBackend` 按注册表**收养**存活进程（isPidAlive + readyPath 就绪即接管，child=null 走 pid 判活/killTree）；后端仅由空闲回收（idleMinutes，缺省 30min，预览页 60s 心跳保活）与用户手动关闭管理。`/gateway/backend` 响应带 `alreadyRunning`（进程已在册存活）→ 前端不渲染「正在启动」覆盖层，iframe 直挂秒开。**不变量**：网关 stop 一律 killAllBackends 会造成每次重启后端冷启动、硬杀来不及 kill 会造成后端孤儿占端口（下次 spawn 端口漂移）——两者均由本解耦消除。

### 6.4 安全

- 后端只监听 `127.0.0.1`（ComfyUI `--listen` 默认）；后端 URL 获取须过网关 token（`/gateway/backend` 属 `/gateway/*` 自动受保护）。
- 后端文件写路径由后端自身约束（如 ComfyUI `--input-directory`/`--output-directory`），粘贴图片落到项目内目录。

### 6.5 preview.json 的 cards 字段（卡片级外部调用，卡片化二期）

同一份 `preview.json` 的**第二种能力申报**（与 `backend` 并列，不是新机制）：项目声明自己有哪些「卡片」可供 Floria web 主区调用渲染。渲染与协议细节见 web-ui.md §42。

```json
{ "cards": [ { "id": "books", "title": "书稿列表", "icon": "folder",
               "path": "cards/books.html", "host": "view", "tab": true } ] }
```

- `GET /gateway/preview-cards?label=<label>` → `{ label, cards:[…], quoteActions:[…], previewCards:[…] }`（**同一端点一次取三份申报**，见 §6.6/§6.7）。label 未命中 / 无 preview → 404；有 preview 但 `cards` 缺失 → `[]`（空集是正常态，非错误）。**label 范围含全局根**（`全局根 · 散装对话`）：全局项的 preview 目录 = `<工作区根>/.claude/preview/`（`findProjects` 对该项 `hasPreview` 探此目录），与项目项共用同一条解析链——工作区根的卡片申报即落此处（web-ui.md §42「常驻应用卡」）。
- 解析：`readPreviewJson(previewDir)` 是 `preview.json` 的**单一解析入口**（`readBackendCfg` 与 `readPreviewCards` 共用；`JSON.parse` 带 `try/catch`，坏 JSON / 顶层非对象一律返回 null ⇒ 空集，不抛到 `findProjects`）。`readPreviewCards` 逐条校验：`id` 匹配 `/^[a-zA-Z0-9_-]{1,32}$/` 且不重复（重复保首次）、`title` 非空、`host === 'view'`、`isPreviewRelPath(path)` 为真；不合格项**整条丢弃**（不猜、不补默认值、不回落）。`icon` 非空串即留（trim 后截 200 字符）；形态有两种——`@floria/web` 图标表键，或 **preview 目录内相对图片路径**（相对卡页所在目录，如 `logo.svg` / `icons/logo.png`），由前端 `core/icon-spec.js` 的白名单解析，两者都不命中回落 `plug`。
- `repo`（可选，2026-10-30）：上游 GitHub 仓库地址，供插件卡「应用」详情页展示与编辑（web-ui.md §42）。`readPreviewCards` 只做 `trim()` + 截 500 字符透传，**不校验 URL 形态**——链接化判定在前端（仅 `http(s)://` 才渲成 `<a>`，其余按纯文本）。**写回链**：前端读 `GET /gateway/file?label=<全局根>&path=.claude/preview/preview.json`（取 ETag 毫秒 mtime 作基线）→ 改该卡 `repo` → `POST /gateway/file/write`（带 `baseMtime`，冲突 409 不覆盖）。网关不为表单新增写端点，复用既有文件读写。
- `isPreviewRelPath`：preview 目录内相对路径 —— 拒绝对路径 / 反斜杠 / `?` / 空段 / `.` `..` 段 / 解码后越界 / 非法 `%` 序列；允许尾随 `#片段`。**同款规则在前端 `engine/ext-decl.js` `isExtPath` 再写一份**——两条外部输入（网关读的 `preview.json` / 不过网关的 `postMessage`）各自守门，不是重复实现。
- 卡片资源**不需要新路由**：`/preview/<label>/<path>` 已托管 preview 目录内任意文件（`resolve` + `startsWith(pvDir+sep)` 越界防护 + 鉴权）；**同一条路由的 label 亦含全局根**（全局项 `pvDir` = `<工作区根>/.claude/preview`），故工作区根卡片页经 `/preview/全局根 · 散装对话/<path>` 托管。
- 解析行为真值表见 `probes/probe-web-ext-cards.ts`（从源码提取函数体、剥 TS 类型后直接跑，不另起网关）。

### 6.6 preview.json 的 quoteActions 字段（浮窗动作申报，2026-09-28）

同一份 `preview.json` 的**第三种能力申报**（与 `backend`、`cards` 并列）：项目声明要在宿主选中引用浮窗（web-ui §47/§48）里追加哪些动作行。

```json
{ "quoteActions": [ { "id": "vocab", "title": "生成单词卡", "icon": "plug" } ] }
```

- `GET /gateway/preview-cards?label=<label>` → `{ label, cards:[…], quoteActions:[…], previewCards:[…] }`（同一端点，不新增路由）。
- 解析：`readPreviewQuoteActions(previewDir)` 复用同一 `readPreviewJson` 单一解析入口。逐条校验：`id` 匹配 `/^[a-zA-Z0-9_-]{1,32}$/` 且不重复（重复保首次）、`title` 非空；不合格项整条丢弃（不猜不补）。`icon` 非空串即留（是否合法由前端 `I` 表判定，缺省回落 `plug`）。段缺失 = 空集（正常态）。
- **动作是纯数据**：无 `path`、不指向文件——宿主只渲染动作行，点击把 `id` 回发预览页（`floria-quote-action`），**执行逻辑留在项目页面自己的运行上下文**（要调项目自己的 API 与页面状态）。
- 前端对应件 `engine/ext-decl.js` `normQuoteActions()`（同款字段校验，与 `isExtPath` 之于 `isPreviewRelPath` 同理由：两条外部输入各自守门）。

### 6.7 预览工作区多卡片（`.claude/preview/<id>/card.json`，2026-10-18）

**一张卡 = preview 目录下一个子目录**（`.claude/preview/<id>/`），卡自包含（自己的页面、脚本、资源），元信息在该目录的 `card.json`：

```json
{ "title": "PDF", "icon": "plug", "entry": "index.html", "order": 10, "default": true,
  "repo": "https://github.com/owner/card-repo",
  "backend": { "name": "PDF 服务", "cmd": ["python", "server.py"], "readyPath": "/" } }
```

- 网关扫描 `readPreviewPaneCards(previewDir)`：只认**直接子目录**且含 `card.json`；`id` = 目录名（`/^[a-zA-Z0-9_-]{1,32}$/`）。字段校验：`title` 非空（缺失整条丢弃）、`entry` 缺省 `index.html` 且须为 `isPreviewRelPath` 安全相对路径、目标文件必须存在、`order` 数字（缺省 100，升序）、`default` 布尔、`repo` 字符串（trim 后截 500 字符，缺省 `''`）、`icon` = 图标表键或**卡目录内相对图片路径**（`logo.svg` / `icons/logo.png`，前端 `core/icon-spec.js` 解析，不命中回落 `plug`）。排序 = `order` 再 `id`；**至多一张 default**（首张为准），有卡表而未标 default 时前端回落排序首张。
- **启用态**：卡目录内 `.disabled` 存在 = 停用（判据常量 `CUSTOMIZATION_DISABLED_MARKER`，与插件/技能同一载体）。`readPreviewPaneCards` 恒返回**全部**卡（停用卡仍要在 work 插件页列出），每卡带 `enabled`；`preview.json` 的 `cards` 同规则（`enabled` 取 `<preview>/<path 首段>/.disabled`）。
- 响应随 `/gateway/preview-cards` 的 `previewCards` 字段下发（与 `cards`/`quoteActions` 同一请求、同一生命周期）。`[]` = 无卡表 ⇒ 该项目沿用传统单页预览（`/preview/<label>/index.html`），旧项目零改动。
- 下发字段（`publicPreviewCard`）：`{id,title,icon,entry|path,order,default,enabled,repo,backend:<bool>,backendName}`；**cmd/cwd/port/readyPath 不下发**（后端进程只由网关管理）。`repo` = 卡片上游仓库地址（GitHub https），供插件卡「应用」详情展示与版本探测。响应另带 `hasIndex`（该项目 preview 根是否有 `index.html`）与 `indexEnabled`（`<preview>/.disabled` 是否不存在），前端据此区分「传统单页预览」与「仅有卡」，并让传统页在管理页可启停。
- **`GET /gateway/repo-version?repo=<GitHub URL>`**：探测上游版本 → `{version, source, error?}`（`source` = `release`/`tag`/`package.json`/`commit`）。仅接受 `https://github.com/<owner>/<repo>`（严格两段）；依次回退 `releases/latest` → 最新 tag → `raw.githubusercontent.com/.../HEAD/package.json` 的 `version` → 默认分支最新提交的短 SHA（前 7 位）；成功缓存 10 分钟、失败 1 分钟；超时 8s。凭据取 `GITHUB_PERSONAL_ACCESS_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN` 环境变量，缺省读便携根 `.claude/plugins/github/.mcp.json` 的 `mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN`（私有仓库可读，60s 缓存）。失败回 `{version:'', error}` 而非 5xx，前端显示 `—`/错误态。
- **`GET /gateway/repo-readme?repo=<GitHub URL>`**：取上游 README 供应用详情「介绍」渲染 → `{name, text, error?}`（正文截断 80k 字符）。先 `repos/{owner}/{repo}/readme`（`Accept: application/vnd.github.raw`，与上条共用凭据 ⇒ 私有库可读），失败回退 `raw.githubusercontent.com/.../HEAD/{README.md,readme.md,README.mdx}`；成功缓存 10 分钟、失败 1 分钟，超时 8s。仅接受严格两段 GitHub 地址，失败回 `{text:'', error}`。
- **启停端点 `POST /gateway/preview-cards/enable`**（`{label, card, enabled:bool}`）：定位卡目录（pane 卡 = `<preview>/<card>`；应用卡 = `<preview>/<path 首段>`；保留 id `__index__` = 传统单页预览，`.disabled` 落 preview 根，仅在该根有 `index.html` 时成立），须落在 preview 根内，写/删 `.disabled`；响应 `{ok,label,card,enabled}`。停用卡不产生工具栏页签、不预热也不拉起其服务器；停用传统页即工具栏「预览」页签消失、无卡时预览区回空态。
- **卡页资源不需要新路由**：`/preview/<label>/<id>/<entry>` 与后端代理 `/backend/<label>/<id>/<entry>` 均已支持嵌套路径；网关只做卡表发现，不改托管规则。
- 前端契约（tab 条渲染、切卡、卡↔宿主消息）见 web-ui.md §58「预览多卡片」。

### 6.8 预览页的 `elements` 字段（可 @ 元素申报，2026-11-13）

预览页可声明「可 @ 元素」，宿主在底栏 `+` 工具栏首屏出现「元素」入口、@ 跨类搜索也可命中；元素选中后**落地形态完全由声明决定**，宿主不解释语义。两处声明源同时扫描（同一份预览目录）：

```json
// .claude/preview/preview.json（项目级）
{ "elements": [ { "id": "fig", "name": "插图", "desc": "插入 figure 环境", "icon": "dshImage",
                  "insert": { "type": "text", "text": "\\begin{figure}\n\n\\end{figure}" } } ] }
// .claude/preview/<card>/card.json（卡级，另带该卡 title 作为来源标记）
{ "title": "Report", "entry": "index.html", "elements": [ /* 同上 */ ] }
```

- 端点 `GET /gateway/mention-elements[?label=<项目>]` → `{ label, elements:[{id,name,desc,icon,card,insert}] }`；有 label 按 `findProjects` 定位项目根（`dir/../..`）的 `.claude/preview`，不存在 → 404 `{error:'project not found'}`；无 label = 便携根 `.claude/preview`（全局上下文）。
- 解析 `readMentionElements(previewDir)`：`preview.json` 顶层 `elements[]` 在前，各**已启用**卡（目录无 `.disabled`）的 `card.json` `elements[]` 随后，`card` = 卡 `title`（顶层声明 = `''`）。逐条校验，不合格整条丢弃：`id` 匹配 `/^[a-zA-Z0-9_-]{1,64}$/` 且跨来源不重复（重复保首次并写日志）、`name` 非空、`desc` trim 后截 200 字符。
- `insert` 是四选一（未知类型丢该条）：`{"type":"text","text":"…"}` 原文写入输入栏；`{"type":"token","token":"[@…:…]"}` 令牌原文写入（含义交后端/插件）；`{"type":"path","path":"<项目根相对路径>","pathType":"file"|"dir"}` 按文件/目录引用落地（路径须为 `isPreviewRelPath` 安全相对路径，正斜杠、不得绝对/含 `.`、`..`）。
- `icon` = `@floria/web` 图标表键（前端不命中回落 `chip`）。前端数据层 `inputbar/toolbar/elements.js`（按上下文缓存，与项目技能缓存同范式），入口/搜索 `toolbar/entries.js`，落地 `inputbar/mention.js`（见 web-ui.md §44）。

## 7. web 独立会话进程链

web 独立会话 = 本地可见交互 REPL 窗口（`/clients` 注册，不再 headless 管道），与普通 CLI 同路径、同样可被远程审批。**会话落盘按来源**：「笔」新建（无 project）→ 全局根 `@WrokSpace/.claude/projects/`（projectScope:'global'）；「项目 +」新建（有 project）→ 该项目根 `.claude/projects/`；不落 Pj16 项目根。落盘位置与 exe 来源无关（cwd 由 `webSessionProjectRoot` 路由）。

**弹窗行为：启动链脱离默认终端委托（defterm），网关直调 `wt.exe -w last nt`**：spawn 不带任何 `-WindowStyle`（`Minimized`=WT 拒绝托管→回落独立 conhost 黑窗；`Hidden`=进程启动但窗口不可见；只有无 flag 才并入 WT，代价=并入时新标签激活 WT 窗口可能抢焦点）；不再信任 defterm（25H2 更新弄坏其激活链且委托键屡遭系统更新重置），四件配套：①`spawnWebSession` 改 `spawn('wt.exe', ['-w','last','nt','-d',cwd,exe,...args])` 直并最近 WT 窗口（无窗自动开新窗）；②CLI 入口自检护栏（cli.tsx main 顶部）——交互式 TTY 且无 `WT_SESSION` 且未自举过（`FLORIA_IN_WT`）且非 bun 源码直跑 → 交接到 WT 后本进程退出（双击 exe 防 conhost 黑窗；wt 不可用留宿主运行）：**交接参数由「有无可见 WT 窗口」探针决定**（`bun:ffi` 调 user32 `FindWindowW('CASCADIA_HOSTING_WINDOW_CLASS')` + `IsWindowVisible`，探测不可用按「无实例」处理）——有窗口 `wt.exe -w last nt -d …` 并入成新标签，无窗口裸 `nt -d …`，**不可一律 `-w last`**（WindowsTerminal 未运行时 `-w last` 先开一枚默认窗口、再为命令行开一枚 = 冷启动双窗）；**退出时机也由该探针把关**：等到屏幕上确有可见 WT 窗口才退（上限 `WT_WINDOW_WAIT_MS`=20s），因为 wt.exe 的 `'spawn'` 只代表中转进程被创建（实测 68ms）而 WT 窗口 1471ms 才可见，父进程早退会让黑窗先消失、窗口后出现，空窗期被读成「没启动」→ 双击两次（探针 probes/probe-wt-window-wait.ts、probe-wt-handoff.ts）。不变量=每交互进程至多自举一次（WT 正常标签自带 `WT_SESSION`，VSCode 等自带宿主终端不接管）；③真实 CLI pid 改由 cli-hello 上报补填（wt 自身即退拿不到 pid：gatewayClient 握手带 process.pid，网关 spawn 在途经 `cliHelloPids` 暂存、注册成功取走填入 webSessions；`WebSessionProc.child` 字段删除，stopWebSession 只用 p.pid）；④网关启动端口落盘 `.claude/gateway/port`（gatewayToken.ts 三件套 save/load/clear，TTL 3s）——并入已存在 WT 窗口时新标签继承旧环境、env 传不到 CLI 子进程，`baseUrl()` env 缺失时读盘发现再回退 8124。spawn 失败判定：wt exit 非 0 且未注册即 reject（无中转进程可杀），注册超时 20s。**spawn 链两处（spawnWebSession + cli.tsx main 自举块）不得带 `windowsHide: true`**——SW_HIDE 随 STARTUPINFO 被新开的 WindowsTerminal.exe 继承=首窗创建即隐藏、父进程即退，二次启动命中已存窗才可见（「启动两次」现象）；wt.exe 是 GUI 子系统，spawn 它不会带出控制台黑窗。

**发送即 resume（发送消息才恢复窗口）**：点开 web 会话不再自动 resume（与 CLI 会话一致仅预览；进程停止时列表状态点透明无点——仅进程在跑时 busy 绿点、否则 null）；进程未在线时**发送消息才恢复**——网关 `handleWsMessage 'send'` 对 `cliClients` 未命中且非启动中的会话走 `resumeAndDeliver`（**web 与 CLI 一视同仁**：`sessionProjectRootOf(sessionId)` 按磁盘 `<项目根>/.claude/projects/<id>.jsonl` 定位项目/全局根 → 复用 `spawnWebSession --resume` 按定位项目选 cwd，注册完成后再经 `cliClients` 注入消息；同一会话 resume 在途复用同一 promise 防双 spawn 双写 jsonl；会话文件不在磁盘 → 拒绝「目标会话未在线」）。

**账面活性统一判定（`webSessionEntryAlive`）**：账面记录命中「存续」时必有活进程或其活跃连接可承接消息——pid 已知 → isPidAlive；pid 空 → cliClients WS 在即进程在。三处一判：①send 暂存分支按真实活性判定，死记录落空走 resumeAndDeliver 恢复（否则 pid 空残留会挡住恢复路径：消息进 `pendingDeliveries` 后无任何进程被拉起，web 恒显「无响应」）；spawn 在途常态不弹回执，活进程断连重连间隙暂存回 status「会话连接恢复中，消息已暂存，CLI 重连后自动补投」；②`spawnWebSession` 幂等复用前验活，死记录清理后走正常 spawn（重连窗口由 cliRegisterAt 近期痕迹保护兜住，无双写）；③`reclaimIdleWebSessions` 判活统一走同函数，pid 空孤儿注册 60s 步进可清。

**`spawningPromises` settle 即清**：`const tracked = p.finally(() => { spawningPromises.delete(sid) })` + `.set(sid, tracked)` + `return tracked`——不变量「表内条目恒为真在途、未 settle 的 spawn」。只 set 不 delete 会让幂等短路恒命中旧 promise（该 sid 再也 spawn 不起来）且 send 路由恒判在途（消息全落 pendingDeliveries 等一个永不再来的注册）。

**WS 心跳回收僵尸连接**：`HEARTBEAT_INTERVAL_MS=30_000` + `HEARTBEAT_MAX_MISS=2`（≈60s 判死）+ `wsMisses: WeakMap`；`markAlive(ws)` 接在 `wss.on('connection')` 与 `/clients` upgrade 回调两处；`startSocketHeartbeat()` 遍历 `[...sockets, ...cliClients.values()]`，非 OPEN 跳过、misses ≥ MAX 则 `terminate()`（→ close → `detach` 清 `cliClients` + 3s 复核窗），否则 misses+1 且 `ping()`；`unref()` 不阻进程退出；`stopSocketHeartbeat()` 在 `stopLocalGateway` 内调用。不变量「sockets/cliClients 里的连接恒为最近一个心跳窗内可应答的活连接」（无心跳时半开死链 `cliClients.has(sid)` 恒 true，给账面判活喂错判据）。

**防双进程 + web 会话 exe 一律用网关自身**：`webSessionExe` = `process.execPath`（协议必然匹配；目录扫描旧版 exe 会探测旧端点 404 → 永不注册 → wsession 超时）；`spawnWebSession` resume 前查 `cliRegisterAt`（/clients 注册时间戳 Map，CLI_RECENT_REGISTER_MS=10s）：近期有痕迹 = 活进程断连重连中 → 复用 resolve 不 spawn（否则同会话双进程：网关对重复注册 `prev.close()` → 每秒互踢乒乓、消息路由 50% miss、审批回调每秒清、双写 jsonl，永不自愈）；`resumeAndDeliver` 注入改 400ms×5s 轮询等重连进程回来再注入。取证日志：重复注册顶替、`spawnWebSession` 全程（spawn 开始含 exe/cwd / 注册成功含耗时 / 注册超时）、网关日志逐行时间戳（`stampGatewayConsole` 在 startLocalGateway 劫持 console，仅 --gateway 独立进程）。

**网关关停不杀 web 会话窗口 + pid 注册表收养**：**web 会话与普通 CLI 会话同等权重，网关 off/restart/空闲退出/SIGINT 一律不杀存活窗口**（gatewayClient 自动重连新网关；与 backend 解耦同构；否则 `/server restart` 会把正在执行 restart 的那个会话自己杀掉）。代价是重启后内存 `webSessions` 丢失 → resume 幂等失效，故有**运行 pid 注册表落盘** `.claude/gateway/websessions.json`（`[{sessionId,pid,startedAt}]`，变更即写防 kill -9 留脏；`persistWebSessions` 在 set/各 delete 点调用），网关启动 `adoptWebSessions()` 读表收养 isPidAlive 条目（同 backend 收养先例）。**与旧 web-sessions.json 区别**：旧表是「web 创建来源标记」（已由磁盘定位取代，勿复辟）；本表是「运行进程 pid 表」（与 backends.json 同构）。`stopWebSession`（taskkill 窗口）仅剩显式关闭单会话端点与超时清理使用，网关关停路径不得调用。

**会话启动模型表（`--model` 落地唯一状态源，2026-10-13）**：`.claude/gateway/sessionmodels.json`（`[{sessionId, model, provider?, updatedAt}]`）= 「该会话下次启动用哪个模型」的唯一真相。写入点两处：①`POST /gateway/model` 会话级路由成功；②`POST /gateway/model-report` 落值（CLI 侧 `/model` 切换经此）。消费点**仅** `spawnWebSession` resume 分支——未显式传 `opts.model` 时查表补 `--model`。携带 `model` 的入口两处（均池内全名，经 `findModelProvider` 校验，池外 400）：`POST /gateway/wsession` body（仅新建分支消费，resume 的模型源唯一 = 本表）、`/clients` 上行 `session-create` 帧（§13）。显式 `opts.model` 恒优先。不变量：跨供应商模型名必须与其供应商凭据同源——故 CLI 启动段命中池内模型即 `setSessionProviderOverride(该供应商)`（见 [core.md](core.md) 模型解析）。条目不删（sid 不复用，孤儿无害）。

**SSE 关停显式 end()**：WS 被显式 `close()` → 页面自动重连成功；但 HTTP `server.close()` **只停止接受新连接、不断开既有连接**，`sseClients.clear()` 只清引用——浏览器 EventSource 收不到 TCP FIN → `onerror` 永不触发 → 前端永不重连 → 消息区实时链静默死亡。故关停时对 `sseClients` 逐个显式 `c.res.end()` 再清集合：客户端收流结束 → onerror → 3s 后 `initLive` 重连新网关 → hello → `refreshSession` 全量对账，旧页面**不刷新自动恢复**（与 WS 侧对称，不加状态源）。

**状态点链路**：REPL `sendSessionActivity` 上报 → 网关 `sessionActivity` 内存 Map → `/gateway/sessions` 附 `state` → 侧栏着色。三件套保证不丢点：①REPL 上报 useEffect 带 60s 心跳（网关 `ACTIVITY_TTL_MS=10min` 清扫后点不消失）；②前端 `refreshList` 签名 `listSigOf()` 纳入各会话 state 拼串（状态翻转必触发重渲染）；③`/gateway/activity` 收报即向 sseClients 群发轻量 `{type:'activity',session,state}`，前端 `refreshList()`（只刷列表不刷会话区）。语义：waiting 独立橘点 `.st-ask #f59e0b`（等待用户）· busy 绿（运行中）· idle 红（暂停/已完成）· 无（进程退出/未打开）；网关重启后已开 CLI 靠首个心跳（≤60s）恢复点。

## 8. web 审批双操作中继（web 与 CLI 均可操作同一会话）

CLI 交互权限弹窗接网关中继——`src/bridge/gatewayPermissionRelay.ts`（模块级 set/get 回调）+ `src/utils/gatewayClient.ts`（`/clients` WS 上行 `approval-request`/`approval-local-resolved`/`approval-cancel`、下行 `approval-response`/`approval-cancel`）+ `src/hooks/useCanUseTool.tsx`（非 BRIDGE_MODE 时 `bridgeCallbacks` 改读网关回调）→ 本地终端弹窗与 floria 审批卡**竞速（claim），先操作者生效**、另一端自动收起；网关 `/clients` 增 message 监听（审批请求→broadcast `{type:'approval'}` 卡片、本地已决→broadcast `{type:'approval-dismiss'}` 撤卡），`handleWsMessage` `'approve'` 路由 `cliClients` 回 `approval-response`（allow 带 `updatedInput:{}`、deny 带 message）；前端 app.js 处理 `approval-dismiss` 撤卡。

**floria 亦可答复提问**：AskUserQuestion 走同一中继——前端 `renderQuestionApproval` 渲染逐题单选交互表单，`sendApprove` 带 `{input, answers}`，网关 approve 路由对 `data.answers` 生成 `updatedInput={questions:数组, answers}`（questions 取数组本体勿嵌套），CLI 交互应答 `buildAllow(updatedInput)` 拿到 answers 执行工具。**单选一题只有一处高亮**：`pick[question]`（`'opt' | 'text'`）记录该题生效的答案来源——**点击**选项、或**点击/聚焦**自由输入行即切换（不等输入事件触发）；切换**不清空**另一侧内容（选过的选项、打过的字都留着），提交按 `pick` 取生效值（`ansOf`）。`.qa-opt.sel` 与 `.qa-inputrow.sel` 二者只其一；输入行**不再有独立的聚焦强调**（`:focus-within` 曾与选中态视觉同款 ⇒ 单选点选项后再点输入框就出现「两处高亮」）。**多选不受 `pick` 互斥约束**：`multiSelect:true` 时勾选项与自定义文本并存——选项高亮恒由勾选集合（`answers[q]` 数组）驱动、输入行 `.sel` 恒由「自定义文本非空」驱动，二者可同时高亮；提交 `ansOf` 把文本追加在勾选项之后 `join(', ')`（与 CLI `SelectMulti` 的 `filter(v=>v!=='__other__').concat(textInput)` 同构）。

**审批中继常驻化**：`permissionCallbacks` 为 `gatewayClient.ts` 模块级常量、**模块加载即 `setGatewayPermissionCallbacks(...)` 常驻注册**（open/close 两处注册与清空全部删除）。不变量：**「审批请求一旦产生，必入待发表」与 WS 连接状态彻底解耦**——回调若挂在 `sock.on('open')`，断连窗口内为 null，弹窗创建瞬间取快照拿到 null ⇒ bridge 分支被跳过、`sendRequest` 都不调用，请求既不上报也不进 `pendingApprovalRequests`，之后任何重连补发都无据可依。探针 `probes/probe-approval-relay-resident.ts` 6/6。

**审批确认送达后才关卡**：CLI 消费 `approval-response` 后回执 `approval-processed`（仅本地消费才发，竞速输不发）→ 网关转发 `approval-confirmed`（session_id+requestId）、approve 路由 else 分支回 `approval-rejected` → 前端 `sendApprove` 不再立即清卡，设 `approvalPending` 等待确认（8s 超时 + 断连 `showApprovalError` 保留卡片+重试）；`approval-dismiss` 撤卡清理 pending。

**pending 跨网关重启补发**：①模块级 `pendingApprovalRequests` 补发表——`sendRequest` 记入，`sendResponse`/`cancelRequest`/`approval-response` 消费（含 handler miss 死请求）/`onResponse` 退订（abort 清理路径）逐点移除；②WS `open`（含重连）`resendPendingApprovalRequests` 逐条重发 → 走网关现有暂存+broadcast 链路（网关零改动），web 先订阅收 broadcast、后订阅收重放，两序均补弹可交互卡；③`pendingResponses` 应答表提升模块级跨重连保留 + close 处 `clear()`（原断开即清会杀掉重启前挂起弹窗的 handler），作答经新连接仍命中 handler 唤醒重启前弹窗。

**网关待决审批/提问暂存与回放**：`localGateway.ts` `pendingApprovals`（按 `requestId` 存 `{sessionId, payload}`）——approval-request 到达即 `pendingApprovalsSet`，web `subscribe`（开会话/WS 重连）时 `pendingApprovalsReplay` 重发该会话未决 payload → 补弹交互卡。**寿命只绑两个真实释放源，无墙钟 TTL**：①显式回执 `pendingApprovalsDrop`（`approval-processed`/`approval-cancel`/`approval-local-resolved`）②会话进程失联确认（`detach` 3s 复核窗内 `pendingApprovalsDropSession`，与 turnBeat/sessionActivity 同点清）。**不变量**：待决项寿命 = 会话存活期，进程仍活着并阻塞在等作答的提问不因时间被清（旧 30 分钟墙钟 TTL 会误杀，重放静默不发卡 → 转录只剩紧凑行「提问·等待回答」）。仍在线会话的待决项跨 CLI 重连 ~1s 窗保留（清理在 3s 复核窗后）。

**调试**：`GET /gateway/diagnostics`（token 保护）返回审批轨迹 + cliClients/sockets/webSessions 概览。`cliClients` 有会话但 trail 无 `cli-approval-request` 有两类含义：①该 CLI 是**旧 exe**（常驻化之前，回调只在连接建立期存在）；②CLI 为新 exe 但弹窗仍在网关断连窗口内出现（常驻化后可自愈）。判据：查 trail 是否只有 `cli-register`/`cli-hello` 而无后续审批事件，并比对该进程 exe 时间戳（`Get-CimInstance Win32_Process` 看 CommandLine）。

## 9. web 重命名 → CLI 实时同步

网关 `/gateway/session/rename` 落盘后按会话精确路由 `{type:'rename',sessionId,title}` 给 `/clients` 注册的在线 CLI（`routeToClient`，未命中静默）；CLI 侧 `gatewayClient` 收到 → `controlOverrideHandle('rename')` → `GatewayControlBridge`：`applyExternalRename`（sessionStorage 新增，只更新 currentSessionTitle/currentSessionAgentName 内存缓存 + PID 注册表 name，不重复 append 文件，sessionId 不匹配忽略）+ `setAppState` 更新 `standaloneAgentContext.name`（输入栏 `─ name ─` 徽标即时更新）+ REPL 订阅 standaloneAgentContext（terminal tab title 即时重算）。rename 落盘格式 = 与 CLI /rename 同格式 append `custom-title`+`agent-name` 两条记录，**必须带 sessionId**——缺字段会被 `loadTranscriptFile`/`restoreSessionMetadata` 跳过，CLI resume 读旧标题且退出时 re-append 把旧标题写回 EOF 导致 web 列表也回退。

## 10. web 插件/技能管理视图数据源（MGR）

入口 = 管理视图三态之一 `/manage/plugins`（另有 projects/models），顶部「插件/技能/应用」切换 + 搜索过滤，卡片网格渲染（app.js fetch `/gateway/plugins`；不展示「数据源」类提示文案）。只列本地已安装项，无「公开/个人」分段。

网关端点 `GET /gateway/plugins`（`localGateway.ts` `listPlugins`，每次请求便携根实时扫描、无缓存）：
- 已安装插件 = `.claude/plugins/<name>/.claude-plugin/plugin.json`（跳过 `data`/`marketplaces`/隐藏目录）
- 已安装技能 = `.claude/skills/<name>/SKILL.md` frontmatter（name/description）
- 不读公开市场清单（`marketplaces/*/.claude-plugin/marketplace.json`）
- 响应 `{workspace, plugins:{personal}, skills:{personal}}`，每项 `{n,d,v,repo,inst,k,en}`；`inst` 恒为 1，列表按名称字母序。
  - `repo` = 上游 GitHub 仓库：插件取 `plugin.json` 的 `repository`（对象取 `.url`；无则回落 `homepage`），技能取 `SKILL.md` frontmatter 的 `repo`/`repository`；仅接受 `https://github.com/` 前缀，无值给空串。供详情页「上游仓库 / 版本 / README 介绍」共用。
  - `k` = 目录名（显示名 `n` 可来自 frontmatter，启停/寻址必须用 `k`），恒有
  - `en` = 启用态 `1/0`（同目录无 `.disabled` 标记）；**判据与加载侧共源** `utils/customizationToggle.ts`

**项目变体 `GET /gateway/plugins?label=<项目>`**：供 work 右栏「技能」工具页与「插件」tab（项目自己的插件/技能/应用视角）。按 label 定位项目根（`findProjects` 命中项的 `dir/../..`），扫 `<项目根>/.claude/plugins/*/.claude-plugin/plugin.json` 与 `<项目根>/.claude/skills/*/SKILL.md`，响应 `{label, plugins:[{n,d,v,repo,inst,k,en}], skills:[{n,d,repo,inst,k,en}]}`（**只含已安装个人项，不出公开市场**；`repo` 口径同上）；项目不存在 → 404 `{error:'project not found'}`。与无 label 的便携根清单结构不同（该项目维度不产 public 分类）；两处共用同一扫描函数 `readPluginDir` / `readSkillDir`（只认含清单文件的子目录，名称/描述取清单元数据，缺省回落目录名）。

**启停端点 `POST /gateway/plugins/enable`**（`{kind:'plugins'|'skills', name:<目录名>, enabled:bool, label?}`）：

- 状态载体 = **自定义件目录内的 `.disabled` 标记文件**（存在即停用、不存在即启用，默认启用向后兼容）。**不写 settings.json、不改 `plugin.json` / `SKILL.md`**（前者是厂家清单、后者是用户手写内容）。
- 落点：无 `label` → `<便携根>/.claude/{plugins|skills}/<name>`；有 `label` → 项目根 `.claude/{plugins|skills}/<name>`（`kind` 两种都支持，work 插件页用项目维度）。
- 校验：`name` 只接受直接子目录名（禁分隔符 / `..` / 首字符 `.`）；目录须存在，且 `plugins` 项须有 `.claude-plugin/plugin.json`、`skills` 项须有 `SKILL.md`；否则 400/404。
- 加载侧门控（两条，共源判据）：`loadSkillsFromSkillsDir`（技能目录整条跳过）与 `loadSkillsDirPlugins`（`createPluginFromPath` 的 enabled 参数）→ 停用的插件其命令/技能/agents/hooks/MCP 全不进 enabled 集。
- 热生效：`skillChangeDetector` 把就地插件根 `.claude/plugins` 也纳入监听（`marketplaces/`、`data/` 整棵忽略），只对插件目录内的 `.disabled` 变更判为 `pluginChanged`；订阅方 `useSkillsChange` 走 `refreshActivePlugins(setAppState)`（与 `/reload-plugins` 同链），技能标记仍走原技能缓存清理。
- **回合内热启用**（`utils/plugins/turnPlugins.ts`）：启用态只决定会话启动时的暴露面，用户仍可在输入里 `@` 点名停用项——web 把插件/技能 chip 序列化为 `[插件:名称]` / `[技能:名称]` 令牌。`executeUserInput` 在回合开始解析令牌、按清单名/目录名匹配出目录（便携根 `.claude/plugins`、便携根与项目 `.claude/skills`），**筛掉已启用的**（正常 `@` 不触发重装配），对停用项 `setTurnExposedPaths` 登记。登记只被启用判据消费：`isCustomizationDirEnabled(dir)` 命中即短路为启用（`utils/customizationToggle.ts`），因此装配侧与技能扫描**共用同一条判据**，不另设分支。随后调用 `refreshActivePlugins(setAppState)`——与 `/reload-plugins`、`.disabled` 变更 watcher **同一条装配链**：清全部缓存 → `loadAllPlugins` → 命令/技能/agents/hooks/MCP/LSP 一并进 enabled 集 → `mcp.pluginReconnectKey` 递增。回合结束（`executeUserInput` 的 `finally`）`clearTurnExposedPaths` 后再装配一次，回到停用态——**不落盘、不改 `.disabled`，只在本次查询内可见**。无令牌或只点到已启用项的回合不解析后不重装配。

**定位 = 清单 + 启停**；装卸/其余配置仍走 CLI `/plugin`（`ManagePlugins.tsx`），web 不安装/卸载。

## 11. `/clients` 下行控制消息路由（按会话精确转发给在线 CLI）

web 前端在 `/clients` WS 上行发控制帧，网关 `handleWsMessage` `switch (data.type)` 逐类处理；需要落到具体会话的走 `cliClients.get(sessionId)` 精确单发（未命中只回 `{type:'status'}` 提示，**不默认 resumeAndDeliver**——这类动作针对「正在运行的会话」，离线会话上做它没有意义；唯一例外是 `send`，它走 resume 全链）。当前成员：

| type | 语义 | 未在线时 |
| --- | --- | --- |
| `send` | 投递用户消息（可带 `images`）→ CLI `enqueue`（与本地打字同路径） | 暂存/`resumeAndDeliver` 恢复（§7） |
| `interrupt` | web 停止键 = CLI 一次 Ctrl+C（`onCancel` 全套） | status 提示 |
| `queue-nudge` | **排队消息催办**：点击排队气泡 → CLI 侧判活置位催办标记，`query.ts` 生成流就地断流、本轮中链 drain 把该消息纳入当前回合（≠ interrupt：不改回合边界、不撤回、不产生新回合）；若有前台任务在跑（断流插不进去）则先 `backgroundAll`（= Ctrl+B）把它转后台再断流 | status 提示 |
| `shutdown` | 优雅退出该会话 CLI（exit 0 让 WT 自动收 tab，3s 后树杀兜底，§7） | status/树杀兜底 |
| `approve` | 审批/提问应答回路由（§8） | status 提示 |

CLI 侧接收口：`src/utils/gatewayClient.ts` 的 `msg.type` 分支 → 各 `bridge/*Handle.ts` 模块级句柄（REPL 挂载则生效，headless 无句柄静默忽略）。链路细节 → [web-ui.md](web-ui.md) §6/§13。

## 12. CLI 上行信号族（`/clients` WS，网关按会话镜像 + SSE 群发）

CLI（`src/utils/gatewayClient.ts`）主动上报的会话态信号经 `/clients` WS 送上网关，网关三类处置：**无状态转发**（原样 SSE 群发）、**按会话镜像 + 首载快照**（网关内存 Map + CLI `detach()` 清 + 重连 open 补发，`/gateway/session` 首次加载附全量，SSE 增量事件体直带全量快照供前端免拉）、**单调去重**（seq 账本）。CLI 上行是事件驱动/去重后的快照，**载荷不变不发的镜像表禁配时间 TTL**。

| 信号 | 处置 | 首载字段 | 备注 |
| --- | --- | --- | --- |
| `turn-state` / `turn-beat` | 无状态转发 | — | 回合开始/结束（打断收口持久信号之一）+ 150s 活性心跳（web 端审批接管在场时抑制红标） |
| `stream-text` | 无状态转发 | — | 流式字符暂态（'' = 块边界/落盘/打断清除） |
| `restored` | 无状态转发 | — | 撤回链（文本回填输入栏） |
| `compact-state` | 无状态转发 | — | 压缩实时态起止（网关无状态，前端按 `live.compactFlags` Map + TTL 自管） |
| `queue-state` | 镜像 `sessionQueues`（无时间 TTL） | `.queued` | CLI `subscribeToCommandQueue` 订阅 + 重连补发；**每项可带 `from:{title,sid?}`（会话间通信来源）**——CLI 上报前已 `parseSessionMessage` 剥壳，网关只做形状边界白名单（title ≤200、可选 sid ≤200），见 §13 |
| `task-state` | **镜像 `sessionTasks`（无时间 TTL）** | `.tasks` | CLI `useTasksV2.getSnapshot()` 单源上报 + 重连补发；形状边界 `normalizeGatewayTasks` 只此一处（非对象/缺 id/缺 subject 丢弃、未知 status→pending、subject 截 500、blockedBy 只留字符串）。生命周期=upsert + detach 清 + 重连补发（时间 TTL 与「载荷不变不发」矛盾——活跃会话清单 10 分钟不变即被清仓 → web 浮窗消失） |
| `activity` | 镜像 `sessionActivity`（TTL 10min + REPL 60s 心跳） | `.state`（`/gateway/sessions` 列表） | 会话状态点判定兼需 `isPidAlive(act.pid)`（busy 绿/idle 红/waiting 橘/停止无点） |
| `model` | 镜像 `sessionModels`（无时间 TTL） | `.model` / `.modelTs`（`/gateway/session`） | **唯一不走 `/clients` WS 的一条**：来源是 HTTP `POST /gateway/model-report`（CLI `reportCurrentModel`），落值即 SSE 群发 `{session, model, modelTs}`。生命周期=upsert + detach 清 + 重连 open 补报（`/clients` open 回调调 `reportCurrentModel`）。语义与落地细则见 [web-ui.md](web-ui.md) §5「模型 web/CLI 同步」 |
| `session-delta` | 单调去重 `sessionDeltaSeq`（cli-hello 重置） | `.deltaSeq` | 展示增量（`{seq, anchorSid, messages}`），见 [web-ui.md](web-ui.md) §4 |
| `cli-hello` | 注册 `cliClients` + 复位 seq 水位 | — | 握手（带 `process.pid` 供网关补填真实 pid，§7） |

**新增信号的收编规范**：内容类通知优先并入 `session-delta` 流（web-ui.md §4）；仅当信号语义不属于「展示序列内容」（如队列/任务清单/压缩态/活性）才单开一类，且一律照上表镜像三件套（Map + `detach()` 清 + 重连 open 补发 + `/gateway/session` 首载字段 + SSE 全量快照）落地。时间 TTL 只配给上行端有心跳/持续重报语义的镜像（activity/display/model）；载荷不变不发的快照表（queue/task）**禁配时间 TTL**。

## 13. 会话间通信：`session-message` 上行→跨会话投递（`SESSION_LINK`）

**这是目前唯一的 CLI→网关→另一 CLI 端到端消息路径**（其余 `/clients` 帧都是「web ↔ 某一个 CLI」或纯上行信号）。链路：

```
会话 A 的 CLI ──上行 /clients {type:'session-message', requestId, toSid, text, from}──► 网关
                                                                                      │ 纯 sid 路由（不解析标题）
                                                                                      ▼
                                                         deliverToSession(toSid, {type:'session-message', text, from})
                                                          ├─ cliClients.get(toSid) 在线 ──► 直投
                                                          ├─ spawningPromises.has ────────► pendingDeliveries 暂存
                                                          │                                  （/clients 注册钩子 flushPendingDeliveries 补投）
                                                          └─ 离线/从未 spawn ─────────────► resumeAndDeliver（定位项目根 → spawn --resume
                                                                                             → 400ms×5s 轮询 tryInject）
会话 B 的 CLI ◄── 下行 {type:'session-message', text, from} ──► enqueue(wrapSessionMessage(from, text), mode:'prompt',
                                                                 skipSlashCommands:true)  ← 与本地打字同队列同分叉
回执：{type:'session-message-result', requestId, ok, error?, sessionId?}   ← sessionId 仅 session-create 成功时携带
```

**`session-create` 上行（2026-09-20，`session_send` 的 `new_session` 形态）**：同一回执帧、另一条投递链——网关先 `spawnWebSession(undefined, project, randomUUID())`（复用 §7 的 web 新建会话链，无 `--resume`，落盘 `<项目根>/.claude/projects/<sid>.jsonl`），**注册完成后**才走 `deliverToSession` 投首条消息，并回执 `sessionId=sid`。要点：① 形状校验只两条（缺 `project` / 空文本 → 回执错误），**label 是否存在于目录由 CLI 侧工具前置校验**——网关对未知 label 的既有语义是回退全局根，本支不校验也不依赖；② 命名 = 「<from.title>拉起的会话」，走 `applySessionTitle`（与 `/gateway/session/rename` 同一条「落盘 + `routeToClient` 内存同步」链，**成对不可拆**），先于投递且失败不阻断投递（只补诊断轨迹）；③ 创建/注册失败如实回执原因，**不做乐观回 sid**（对比 `POST /gateway/wsession` 的预分配语义：那对 web 有效，对工具调用是撒谎）；④ CLI 侧超时 25s > 网关注册超时 20s。⑤ **自 2026-10-13 起本帧可选带 `model`**（池内模型全名，`findModelProvider` 校验，池外 → 回执错误不 spawn）：网关以 `spawnWebSession(undefined, project, sid, {model})` 的 `--model <model>` 落地；`session_send` 工具新增可选入参 `model`（仅 `new_session` 形态有效，`SessionSendTool/prompt.ts` 有说明），缺省回落池默认（行为同前）。

**职责分界（定案）**：

| 侧 | 职责 |
|---|---|
| CLI（发送方） | 标题/sid → sid 解析（`utils/sessionAddressing.ts` + `GET /gateway/sessions`），**寻址在转录所在的那一侧完成**；无授权门——目录内任何会话可发。`new_session` 形态另需校验 `project` 在目录 `groups`（`scope==='project'`）中真实存在 |
| 网关 | **纯 sid 路由**：形状校验（空 `toSid`/空文本/**自发自收** → 回执错误）、三岔投递、回执。**不做标题匹配、无标题索引** |

**`deliverToSession(sessionId, frame, fb)` 是统一三岔口**（发送方与 web `send` 共用同一投递语义）；`DeliveryFeedback` 三态 `staged`/`resuming`/`done`，只有 `done` 回执——前两态由发送侧 20s 超时兜底（`SESSION_MESSAGE_TIMEOUT_MS`）。

**为什么单独开 `session-message` 帧而不复用 `send`**：`send` 帧无 `from` 字段，而来源要一路带到接收侧转录（模型可见，见 [core.md](core.md)）。

**离线拉起沿用既有行为**：不新增信号源——`resumeAndDeliver` 就是 web `send` 那条路径（§7「发送即 resume」），仅复用。风险（拉起产生意外副作用）已定案允可。

**回环**：**网关不做代码级刹车**——靠 `@WrokSpace/.claude/CLAUDE.md` 的「非必要不通信」约束。唯一硬边界是「自发自收」直接拒。

**相关端点**：`GET /gateway/sessions` 返回 `{file, title, state?}[]`，CLI 侧 `fetchSessionDirectory()` 取 `file` 去 `.jsonl` 作 sid（与 web 消息路由 `hashOf(s)` 同键）、`title` 空则记「未命名会话」。

## 14. 神经元可视化数据端点（`/gateway/neurons[/graph]`，只读）

web「神经」视图（[web-ui.md](web-ui.md) §26；2026-10-10 起为工作区根应用卡）的两个只读数据源，实现于 `src/gateway/neuronViz.ts`，`localGateway.ts` 注册在 `/gateway/models` 之后，token/cookie 鉴权同其它 `/gateway/*`。

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /gateway/neurons` | `{neurons: [{id,name,type,description,mem_count,cog_count,community_count,last_updated}]}` | 层级1 清单卡片；`listNeuronsInRoots()` 多根扫描（roots 由 `gatewayNeuronRoots()` 组装：cwd 根 → 各项目根 `.claude/neturon`（跳 `.` 目录与根级临时任务目录，目录存在才入列）→ 全局根，同 id keep-first=roots 顺序即优先级），cog/社群数读 `l1.cog` 两 JSON 快照（缺文件=0），**不含盘上路径字段** |
| `GET /gateway/neurons/graph?id=<注册id>&res=<分辨率>` | `{neuron:{id,name,description}, resolution, resolutions[], communities[], cogs[], mems[], cognition:{graph,communities}}` | 层级2 图数据包；`id` = 注册 id（=config.yaml `person.id`，如本库 `PJ16`，目录名 `Neuron-` 前缀扫描时被剥）；`res` 缺省 = **cog2.json 命名档**（认知管线 `abstraction.default_resolution` 的落盘痕迹；无 cog2 时兜底 `resolution_1.0`）；**认知层可缺省**：`cog_graph.json`/`community.json` 均为认知管线（recall → fill_precog → build_graph → detect_communities）产物，未跑过的库只有记忆层——此时照实出记忆层图（`cognition` 两标志 false、`resolution` 空串、cogs/communities 空数组），**不报错**；仅「community.json 存在却无该分辨率档」（含显式 `res` 指定不存在档）抛错（sendError 带可用档清单）；communities[] 元素挂 `name`/`description`/`confidence`（读 cog2.json 按 members 集合精确挂载，无命名/他档群照实缺省） |

**图数据包三级结构**：`communities[]`（`i/size/density/cog_ids/mem_count/chars/members[{id,query,role,core_score}]`，来自 community.json 指定档；另挂 `name/description/confidence` 可选字段，来自 cog2.json 命名记录按 members 集合精确匹配）+ `cogs[]`（`id/query/keywords/mem_ids/rel_ids/community(-1=未入群)/chars`，来自 cog_graph.json nodes，`true_memories`/`revelant_memories` 过滤为库内存在 id）+ `mems[]`（`id/chars/source/time/preview(≤80)`，来自 mem.db）。

**连边派生在前端**（后端只给事实，不给边）：mem↔cog 由 `cogs[].mem_ids/rel_ids` 派生（同一 mem 挂多 cog 时每 cog 各一条=事实闭合）；cog↔社群由 `cogs[].community` 派生。`chars` 一律由 blocks 派生文本长度（`deriveEntryText`）。

**不做 NEURON_RAG 门控**：本模块只读盘上 JSON/sqlite，不引入 embedder/transformers；库文件独立于该编译期 flag 存在，默认构建即可出图。**只读不写**，不触发 build_graph/detect_communities 管线。

## 15. 工作区根目录浏览端点（`/gateway/fs`，只读，2026-09-26）

web `@` 提及 /「+」菜单的「目录 / 文件」组数据源（[web-ui.md](web-ui.md) §44）。`localGateway.ts` 注册在 `/gateway/file` 之后，token/cookie 鉴权同其它 `/gateway/*`。

`GET /gateway/fs?path=<相对工作区根的可选子路径>` → `{ path, entries: [{name, type:'dir'|'file', mtime?}] }`；`path` 缺省/空串 = 工作区根（`root` = `getPortableRoot()`，与 `/gateway/project` 同一基准）。`mtime` = 最后修改时间（ms，`statSync`；失败则省略字段），供前端搜索按时间混排（[web-ui.md](web-ui.md) §44）。

- **单层只读**：复用 `listOneLevel(dir)`——同一套裁剪（跳隐藏项与 `.git`/`node_modules`/`.claude`/`.trash` 等重型目录、目录在前、**单层不设条数上限**），**不另立排除表**；端点内无任何写调用。
- **穿越防护单一实现**：`resolveWithinRoot(root, rel)`（导出纯函数）先 `resolve(root)` 得 `base`，剥离首尾 `/` 与反斜杠归一后 `resolve(base, rel)`，要求 `abs === base || abs.startsWith(base + sep)`——越界（`..` 逃逸、盘符、根绝对路径）返回 `null` → **403**；命中但非目录 → **404** `not a directory`。**基准必须先 `resolve` 再做 `startsWith` 比较**：直接用调用方传入的 `root` 拼 `sep` 时，形如 `F:/x` 的正斜杠根会与实际解析出的反斜杠路径失配，把根内路径误判成越界。
- **探针锚点**：`probes/probe-gateway-fs.ts`（直接 import `resolveWithinRoot` 测真实现：根内 6 例 + 越界 7 例 + 分支只读/`listOneLevel`/403/404 文本断言，18 项）。

## 16. 项目内文件树写端点（`/gateway/file/rename`、`/gateway/file/delete`、`/gateway/file/archive`、`/gateway/file/reveal`、`/gateway/file/write`、`/gateway/file/create`、`/gateway/file/upload`、`/gateway/file/move`）

work 文件树行操作浮窗（[web-ui.md](web-ui.md) §45）的提交侧。两端点只解析 `label` 找项目根，语义与防护全在导出纯函数里——端点即「纯函数结果码 → HTTP 码」的直译，写法与 `/gateway/fs` 复用 `resolveWithinRoot` 同源。

**`POST /gateway/file/rename`** body `{label, path, name}` → `renameProjectEntry(projRoot, path, name)`。只改 basename、不跨目录移动。新名走 `sanitizeEntryName`（同 `POST /gateway/file-cache` 的清洗口径，已抽出共用：basename 化 + `\/:*?"<>|` 与控制符换 `_` + Windows 保留名加 `_` 前缀 + 截断 120 字符且保扩展名）；新名里的路径/盘符式前缀被 basename 剥掉（只可能「少字」，不可能逃出项目根）。**目标已存在 → 409 拒绝，不覆盖也不自动序号**——改名是用户显式输入，静默换成别的名字比报错更糟；新名与原名相同 → 200 幂等 no-op。响应 `{ok, name, path}`（`path` 为改名后的项目内相对路径，正斜杠）。

**`POST /gateway/file/archive`** body `{label, path}` → `archiveProjectEntry(projRoot, path)`（**仅目录**，文件 400 `仅目录可归档`）。归档语义与项目归档一致：`tar -czf <项目根>/.achrives/<目录名>-<YYYYMMDDHHMMSS>.tar.gz -C <项目根> <relPath>`（系统 tar，顺序流），成功后 `trashProjectEntry` 把原目录移入 `<项目根>/.trash/`。tar 失败清掉本次半成品，失败文案带 stderr 尾部；打包成功但移 `.trash` 失败 → 500 且错误带已生成的包路径。响应 `{ok, path:'.achrives/<名>', trash:'.trash/<名>', size}`。`.achrives` / `.trash` 均以点开头，不进文件树。

**`POST /gateway/file/delete`** body `{label, path}` → `trashProjectEntry(projRoot, path)`。**「删除」= 移动**（工作区规范禁止 `rm`）：`renameSync` 到 `<项目根>/.trash/`，永不真删、永不覆盖——`.trash/` 下同名冲突加 `<YYYYMMDDHHMMSS>-` 前缀（同秒再撞加 `-N`）。目录删除 = 整棵子树一次搬走。响应 `{ok, trash:'.trash/<名>'}`。`.trash` 以 `.` 开头，本就不进 `/gateway/project` 文件树（`walkProjectTree` 跳过点开头条目，且在 `SKIP_TREE_DIRS` 内）。

**`POST /gateway/file/reveal`**（2026-10-24，work 文件树行菜单「在资源管理器中打开」，[web-ui.md](web-ui.md) §45）body `{label, path}`。网关进程即用户本机进程，直接在系统资源管理器中定位：文件 → 打开父目录并选中该文件，目录 → 打开该目录。实现落到 `revealInExplorer`：`bun:ffi` 直接调 shell32 的 `SHOpenFolderAndSelectItems`（与 Obsidian「在文件夹中显示」同一 API）——`SHParseDisplayName` 把绝对路径解析成 PIDL，文件/目录同一调用（传该项 PIDL + `cidl=0`），由 shell 完成打开；**不启动 explorer / PowerShell 子进程** ⇒ 无 console 黑框、无冷启动延迟（实测 5~15ms 发起、约 100ms 出窗）。**前置由网关自己补**：网关没有前台窗口，shell 只把窗挂出来、不激活（表现为「开在最下层」），而纯后台进程直接 `SetForegroundWindow` 会被前台锁拒绝；故窗口出现后（异步轮询 ≤1.6s，按「标题 = 文件夹名」或「新建 / 由隐藏转可见」认领 `CabinetWClass`）用 `AttachThreadInput` 附到当前前台线程再 `SetForegroundWindow`，仍未果则 `SwitchToThisWindow`。调用前 `CoInitializeEx(COINIT_APARTMENTTHREADED)`；shell32/ole32 懒加载并复用（`dlopen` 失败只记日志，不影响其它端点）；PIDL 用完 `CoTaskMemFree`。响应 `{ok:true}` 只表示已发起。路径防护同下方共用口径（越界 403、不存在 404），**空 `path` = 项目根自身、允许**（与 rename/delete 的 403 不同，打开项目根是合法意图）；非 Windows → **501 `unsupported platform`**。

**共用防护**：`resolveWithinRoot(projRoot, path)` 越界与空 `path`（= 项目根自身）→ **403**；条目不存在 → **404**；名称为空 → **400**。两端点均受上方 `/gateway/*` token/cookie 校验保护，且都在 `findProjects` **按 `label` 唯一命中**后才动盘（2026-10-15 待办 7 起**不再硬判 `scope==='project'`**——`scope==='global'` 的工作区根同样可按其 label 命中、作为一等项目接受写操作；`findProjects` 的 label 空间跨 scope 不重叠，按 label 定位即够。同一改动亦覆盖 `GET /gateway/project` 与 `file/{move,write,create}`。**例外**：`/gateway/comments` 与 `/gateway/backend/*` 仍按 `scope==='project'` 硬判——评论属项目不落全局根散装区，backend 需 `hasBackend` 只有项目具备）。

**`POST /gateway/file/write`**（2026-10-05，work 编辑区写回侧，[web-ui.md](web-ui.md) §54）body `{label, path, content, baseMtime?}` → `writeProjectFile(projRoot, path, content, baseMtime)`。**只改已存在文件的内容，不新建/不删除**；`path` 越界与空 `path` → **403**，不存在或为目录 → **404**。**乐观并发（不静默覆盖）**：给了 `baseMtime` 即与当前 `statSync().mtimeMs` **精确比对**（非区间容差），不等 → **409 `conflict`**（磁盘已被外部改动，调用方须显式处置）；不给则强制覆盖。成功 → `{ok, path, mtime}`（新 mtime = 下次保存的基线）。body 上限 `MAX_FILE_WRITE_BYTES = 4 MB`（对齐读侧，超限 413）。**读侧配套**：`GET /gateway/file` 新增 `ETag: "<mtimeMs>"` + `Last-Modified`（ETag 用毫秒级 mtime——`Last-Modified` 只有秒级、无法表达同一秒内两次写），编辑区即以此作基线回传。**`HEAD /gateway/file`**（2026-10-25）与 GET 同鉴权/越界 403/404/413 口径，只 `statSync` 不 `readFileSync`，回同一组头后 `res.end()` 无 body——work 编辑卡以 0.5s HEAD 轮询当前文件 mtime 做外部改动实时同步（[web-ui.md](web-ui.md) §54）。

**`POST /gateway/file/create`**（2026-10-13，work「+」菜单新建，[web-ui.md](web-ui.md) §45）body `{label, dir, name, kind:'file'|'dir'}` → `createProjectEntry(projRoot, dir, name, kind)`。`dir` = 落点目录（项目根相对，缺省/空串 = 项目根，**不自建多级**，父不存在 → **404**）；`name` 走 `sanitizeEntryName`（同 rename 清洗口径）；同名已存在 → **409**（不覆盖、不自动序号）；落点逃逸/空 `dir` 越界 → **403**；空名 → **400**。成功 `{ok, path, kind}`。

**`POST /gateway/file/upload`**（2026-10-13，work「+」菜单上传）body `{label, dir, name, contentBase64}` → `uploadProjectFile(projRoot, dir, name, buf)`（内部复用 `storeUploadFile`，与 `/gateway/upload` 同一原子落盘；文件树上传**保留原名、不加时间戳**）。前端多选逐个发；同名自动加 `-1`/`-2` 序号避让（**不覆盖**，`flag:'wx'` 并发安全）；名含路径段按 basename 化解（不可能逃出落点）；落点逃逸 → **403**；单件上限 **20 MB** → 413。成功 `{ok, path, size}`（`EntryOpResult` 可选 `size`）。

**`POST /gateway/file/move`**（2026-10-14，work 文件树拖拽移动）body `{label, path, dir}` → `moveProjectEntry(projRoot, path, dir)`。`dir` = 目标目录（项目根相对，空串 = 项目根，**不自建多级**，不存在或非目录 → **404**）；basename 随源不变（移动不改名，改名走 rename）；移入自身或其子目录 → **400**；目标同名已存在 → **409**；源越界/空 `path` → **403**，不存在 → **404**；已在目标处 → 200 幂等 no-op。成功 `{ok, name, path}`（新项目内相对路径，正斜杠）。

**项目整体归档 / 临时项目删除**（work 项目下拉行的长按 / 右键菜单，[web-ui.md](web-ui.md) §69.1）：这两口动的是**项目目录本身**（`<root>/<label>`），不是项目内条目，故不走 `resolveWithinRoot`——`label` 必须是工作区根的**直接子目录名**（含分隔符 / `.` / `..` → 400），且必须命中 `findProjects` 里 `scope==='project'` 的组（404）。

- **`POST /gateway/project/archive`** body `{label}` → `archiveProject()`：`tar -czf <root>/.achrives/<label>-<YYYYMMDDHHMMSS>.tar.gz -C <root> <label>`（系统 tar：Windows 10+ 自带 `System32\tar.exe`，macOS/Linux 自带；顺序流打包、内存恒定），成功后 `renameSync` 把原目录移入 `<root>/.trash/<ts>-<label>`。**格式选 tar.gz 不选 zip**：无中央目录索引，进程中断只截断尾部、不会整包不可读；`.achrives/` 里的历史 `.zip` 原样保留。tar 失败清掉本次半成品；打包成功但 `.trash` 移动失败（Windows 占用）→ 500，错误文案带已生成的包路径，原目录原地不动。响应 `{ok, archive:'.achrives/<名>', trash:'.trash/<名>', bytes}`。
- **`POST /gateway/project/delete`** body `{label}` → `deleteTempProject()`：**仅根级时间戳任务区**（`/^\d{8,14}-/`）可删，其余 400；语义 = 目录移入 `<root>/.trash/<ts>-<label>`（禁止 `rm`）。响应 `{ok, trash}`。
- **`POST /gateway/project/rename`** body `{label, name}` → `renameProjectDir()`：`<root>/<label>` 整目录 `renameSync` 为 `<root>/<name>`（label 即项目标识，会话转录在项目内随目录一起走，不迁移数据）。名称走 `sanitizeEntryName`，**点开头一律 400**（`.trash`/`.achrives` 之类会被项目扫描跳过）；同名已存在 → 409；与归档同口径走 `projectUseBlocker`（有在线会话 409）+ `killBackend(label)` + `closeSseWatchesUnder()`，成功后端点调 `ensureSseWatches(root)` 按新布局补齐 watch。响应 `{ok, label:'<新名>'}`。
- **移目录前必须关掉本项目的 SSE watcher**：`ensureSseWatches` 对每个项目 watch `<项目>/.claude/projects`，Windows 上该 `fs.watch` 句柄会让**父目录**（项目根）`renameSync` 返回 `EPERM`（实测：watch `a/b` 后 rename `a` 失败，`w.close()` 后同一次 rename 立刻成功）——不关则表现为「tar 已生成，但移入 `.trash` 失败」。故 `moveProjectDirToTrash` 在 rename 前调 `closeSseWatchesUnder(projRoot)`（按路径前缀摘 `sseWatches` 并 close；项目整体移走，watcher 本就该销毁）。
- **占用防护（两口共用 `projectUseBlocker`）**：项目内有在线会话 → **409** `项目内有在线会话，请先关闭会话再操作`（判据两条：`cliClients` 的 sid 经 `sessionRootFromId` 还原启动根落在项目内；`sessionActivity` 中 TTL 内且 `isPidAlive` 的 `cwd` 落在项目内——后者兜住断线重连 ~1s 的注册空窗）。**不自动杀用户会话**。预览后端是网关自己的子进程（不是用户会话），归档 / 删除前由端点调 `killBackend(label)` 停掉，避免改名后残留进程失根。
- 两端点同步等待（大项目打包是分钟级）：请求返回即完成信号，前端等待期 toast「正在归档…」。受 `/gateway/*` token 校验保护。

- **探针锚点**：`probes/probe-file-tree-ops.ts`（直接 import 四件真实现：重命名 13 例 + 删除 12 例 + 写内容 10 例〔越界/空 rel 403、不存在与目录 404、基线不符 409 且不覆盖、基线正确写入、无基线强制覆盖〕+ 端点转译/ETag/`SKIP_TREE_DIRS` 文本断言，43 项；临时树建在 `os.tmpdir()`，跑完自清；评论读写 10 例见 §17）；`probes/probe-file-create.ts`（create/upload：26 例——创建文件/目录、落点 ''=项目根、409 不覆盖、落点逃逸 403、落点目录不存在 404、保留名清洗、空名 400、上传落盘/序号避让/递归建目录/逃逸 403/basename 化解）。

## 17. 项目评论批注端点（`/gateway/comments`，2026-10-06）

work 右栏评论 tab + 选区「添加评论」的存取侧（[web-ui.md](web-ui.md) §55）。存 `<项目根>/.claude/comments.json`，结构 `{version:1, comments:[...]}`，`comment = {id, path, l0, l1, excerpt, body, author, createdAt, resolved}`。

- **`GET /gateway/comments?label=`** → `{comments:[...]}`。仅命中 `scope==='project'` 的项目，未找到 → **404**。读 `readProjectComments(projRoot)`：缺文件 / 坏 JSON / 顶层非对象 / `comments` 非数组 → 一律静默返回 `[]`；数组内非对象元素被过滤。
- **`POST /gateway/comments`** body `{label, comments:[]}` → `writeProjectComments(projRoot, comments)`。**每次整份替换**（前端是唯一写入方，改内存副本后整份回写，不做增量合并）；`comments` 非数组 → **400**；成功 `{ok:true, count}`。写入**建 `.claude/` 目录且 create-if-missing**（`writeProjectFile` 只改已存在文件、不新建，故评论另设端点）。
- 与文件树写端点同构：只解析 `label` 找项目根，语义/防护在导出纯函数里，端点即「纯函数结果码 → HTTP 码」直译；受 `/gateway/*` token/cookie 校验保护。
- **探针锚点**：`probes/probe-file-tree-ops.ts`（评论段 10 例：空读、写+计数、落 `.claude/comments.json`、回读、整份替换、非数组 400、非对象元素过滤、坏 JSON / 顶层非对象 → 空、两端点存在且转译结果码；临时树 `os.tmpdir()` 自清）。

**读端点复用（无新路由）**：`GET /gateway/file?label=&path=`（原始字节 + 路径穿越防护 + 4 MB 上限 + MIME 头 + `ETag`/`Last-Modified`，work 编辑区同款；**MIME 分类 = 静态表优先、未登记扩展名落 `sniffBinary()` 内容嗅探**——前 8 KB 无 NUL 判文本 → `text/plain; charset=utf-8`，见 [web-ui.md](web-ui.md) §43）**现亦作 AI 生成图取图口——前端按 markdown 图片语法 `![](代号.png)` 里的代号拼 `.claude/images/<代号>` 提请（[web-ui.md](web-ui.md) §50）。图片字节不进消息流/转录，`/gateway/file` 只按相对路径读盘，`.claude/images/` 仅是普通路径。**`label` 不做 scope 筛选**：项目会话 `label`=项目名（解析到项目根），全局根会话 `label`=`全局根 · 散装对话`（解析到工作区根）——两者标签空间不重叠（项目 label 是目录名、不含 `·`），故全局会话同样能取图。**label 缺省 = 按工作区根解析**（2026-10-14，work 侧栏「工作区」tab 打开散装文件）：根直读仅限 label 缺省，且拒顶层隐藏段（首段以 `.` 开头 → **403**，防摸 `.claude/gateway/token` 等凭据）；查无此 label（非空且未命中）仍 → **404**。其余穿越防护与 4 MB 上限同一口径。单图受 `GET /gateway/file` 的 4 MB 上限约束。

## 18. 卡片公开 API 端点（`/gateway/cards`、`/gateway/card-call`，2026-10-11）

agent 驱动浏览器里「在场卡片」的网关侧链路（总设计 → [web-ui.md](web-ui.md) §61）。卡片活在 iframe 里：进程外无法寻址、也没有身份 ⇒ **唯一既能寻址又持有鉴权的一层是宿主总线**（`web-src/engine/card-bus.js`），网关只做「按能力表选设备 + 转发 + 配对」。

- **两张内存表**：`cardHolders: Map<WebSocket,{caps,at}>`（浏览器 `/ws` 上报的能力表，断连即摘）；`pendingCardCalls: Map<callId,{ws,resolve,timer}>`（在途调用，断连/超时收口）。设备提示 `wsDevice`（`/ws?device=`）**仅供展示**，不参与寻址。
- **WS 上行帧**：`{type:'card-caps', caps:[…]}`（宿主每次表变/`onopen` 上报，整体替换该连接的表；空数组即摘表）；`{type:'card-result', callId, ok, result?, error?}`（在途调用回执）。
- **WS 下行帧**：`{type:'card-call', callId, target, cmd, args, timeoutMs}`。
- **`GET /gateway/cards`** → `{devices, cards:[{label,instanceId,kind,ns,cmds,ready,device}]}`（只读能力表，供 `CardCall` 的 list）。`sanitizeCaps` 落表前收口：**无 `instanceId` 的条目直接丢**（不可寻址）、`cmds` 截 64、最多 200 条。
- **`POST /gateway/card-call`** body `{label?,ns?,instanceId?,cmd,args?,timeoutMs?}` → 选设备 `pickCardHolder`（**instanceId 最精确 > ns > label**，可叠加 `label` 收窄 ns；多台命中取**最近上报**的那台——**绝不广播猜测**，否则 PC+iPad 的卡同时动）→ 下行 → 等 `card-result` 配对 → HTTP 响应。
- **错误语义（真值表）**：缺 `cmd` 或三个寻址键全空 → **400**；无浏览器在线（`sockets` 空）→ **503**；有浏览器但无匹配卡 → **409**（附当场能力表 `{target, cards}`，agent 可直接改址重试）；卡超时 / 持卡设备中途断开 → **504**。**卡内命令失败（卡回 `ok:false`，如「未注册的命令 x」）走 HTTP 200 `{ok:false,error,card}`**——那是卡的正常答复而非传输错误，混成 4xx/5xx 会让 agent 误以为链路坏了而反复重试。超时 clamp `500..60000ms`。
- **`card:open` 特判（2026-10-13）**：`POST /gateway/card-call` 的 `cmd='card:open'` 走**独立分支**（`pickLatestHolder` 选最近上报设备、**不查能力表**）：缺 `args.label` → **400**、无浏览器 → **503**、超时/断开 → **504**；**不发 409**（整卡 open 不需要目标卡已在场，语义=打开该项目预览卡）。其余 `card:*` 动词（`card:close`/`card:delete`）走常规能力表路由（须命中在场帧，否则 409）。命令词表与卡侧契约 → [web-ui.md](web-ui.md) §61。
- **CLI 侧出口**：`src/utils/gatewayClient.ts` 的 `listGatewayCards()` / `callGatewayCard()`（HTTP 超时取 `timeoutMs+2000`，让网关的 504 先到）+ 模型工具 `CardCall`（`src/tools/CardCallTool/`，`feature('CARD_API')` 门控，进 `defaultFeatures`）。
- **探针锚点**：`probes/probe-web-cards-api.ts`（§ 网关帧型/路由/状态码真值表 与 CLI 侧 `listGatewayCards`/`callGatewayCard`、工具/feature 登记的字面量一致性）。



## 19. 供应商模型目录端点（`GET /gateway/models/catalog`，只读，2026-10-30）

模型卡（工作区根应用 `.claude/preview/models/`）「点进供应商 → 勾选启用模型」的数据源：用凭据池里该 provider 的 key **实时**向供应商拉取**全部**模型清单，只读——启用项写回 `providers[].models` 仍走 `POST /gateway/file/write`（前端整份回写 + mtime 冲突校验），本端点不写任何配置。

- **请求**：`GET /gateway/models/catalog?provider=<providers 键名>`；缺 `provider` → **400**；未知名 → 200 `{ok:false,error:'provider not found',models:[]}`（同其它 `/gateway/*` 受 token/cookie 校验）。
- **端点探测顺序**（各厂商把 `/v1/models` 挂在不同根，实现 `catalogUrls()`）：`protocol==='openai-chat'` → `{baseUrl}/models`；`anthropic` → `{baseUrl}/v1/models` → 再去掉尾部 `/anthropic` 的 `{root}/v1/models`。逐个试，首个返回非空清单即用；单次超时 9s（`CATALOG_TIMEOUT_MS`）。
- **响应归一化**（`normalizeCatalogModels()`）：兼容 `{data:[{id,display_name}]}`（Anthropic/OpenAI/GLM）与 `{models:[{id,name}]}`（Gemini）；`models/<id>` 前缀剥除。
- **返回**：`{provider, ok, url, error, enabled:[已启用], models:[{id,name?,enabled,vision,tool}]}`。`models` = **已启用项恒在（在前）** + 厂商返回的其余模型；`ok=false` 时前端回落为「仅密钥池现有模型 + 手动添加」，不让启用项消失。`vision` 读 `modelVision`，`tool` = `isToolBoundModel()`（工具绑定模型可展示但不出现在切换列表）。
- **实测边界**：DeepSeek/Kimi/GLM 可达（deepseek 走 root `/v1/models`，kimi 同，GLM 走 `/api/anthropic/v1/models`）；Google 端点在本机直连超时（无代理）→ `ok:false` + 回落。

## 20. 文件下载（`GET /gateway/file?...&dl=1`，2026-10-30）

work 文件树 / 顶栏文件 pill 行菜单「下载」的唯一取件口。与同端点的**预览读取**（识图、图片音视频、编辑卡打开）刻意分语义：

- **`dl=1` 不套 4MB 上限**：4MB 只守护「把字节读进前端内存做预览/编辑」，下载是要把用户自己的文件取走，不属于该上限的守护对象；`dl` 缺省时行为完全不变（>4MB → 413 `too large`）。
- **响应头**：`Content-Disposition: attachment; filename="<ASCII 回退:非 ASCII 与引号/反斜杠→_>"; filename*=UTF-8''<RFC5987 编码原文>`（中文名不乱码）+ `Content-Length`；GET 走 `createReadStream().pipe(res)` **流式**发送，不把整文件读进网关内存；`Content-Type: application/octet-stream`。
- **HEAD 同头**：前端下载前先 HEAD 取 `Content-Length`，超过确认阈值（前端 `WK_DL_CONFIRM_BYTES = 50MB`）弹 `#dl-modal` 确认栏（文件名 + 人类可读大小，取消/关闭/遮罩/Esc = 放弃），确认后才导航下载。
- **根治「PDF 点下载变预览/跳转」**：旧实现是 `blob:` URL + `a[download]`，浏览器（Edge/iPad Safari）忽略 download 属性时把 blob 当文档导航 ⇒ 地址栏出现 `blob:https://<host>/<uuid>` 预览 PDF。现在下载 URL 指向网关且带 `attachment` 头，浏览器只会落盘；前端也不再 blob 化（大文件不占内存）。鉴权/越界 403/404 与 GET 同口径。

## 21. 安全卸载（`POST /gateway/eject`）

拔除外置盘前把卷上所有 Floria 进程一次收干净的显式动词。与 `/gateway/shutdown`（`/server off`）的分工：后者只停网关，会话窗口与卡片后端按生命周期解耦定案存活（§6、§7）；eject 额外停掉这两类进程并退出网关自身。

- **前置**：仅独立网关进程（`--gateway`）可用；进程内嵌网关调用 → 409 `eject 仅独立网关进程（--gateway）支持`。重复调用 → 409 `already ejecting`。
- **响应**：`200 {ok:true, ejecting:true, sessions:[{sessionId,pid?}], backends:[label…]}`，先回快照再异步收尾，调用方必须按「网关随后退出」处理。
- **收尾序列**：①向所有 `/clients` 连接发 `{type:'shutdown'}`（CLI 侧 `exit 0`，WT 自动收 tab）→ ②最多等 4s 仍未断开者按 pid `killTreeExcept(pid, 网关自身)` 树杀（pid 源：`webSessions` → `cli-hello` 上报的 `cliPids` → `sessionActivity`；豁免网关自身，因其常是某个会话的子进程）→ ③逐个 `killBackend` 停全部卡片后端（含收养的 child=null 条目），再按 `.claude/gateway/backends.json` 补杀本代未收养的遗留 pid 并清空注册表 → ④`stopSseWatches` → `stopLocalGateway` + `process.exit(0)`。
- **不变量**：接受 eject 后 `ejecting` 置位，`spawnWebSession` 直接拒绝、`gatewayStopping` 提前置位阻断新后端就绪探测——卷上不再产生新进程。pid 未知且不响应 shutdown 的旧 exe 会话可能残留，由调用方在卷停稳后核对进程表。
- **配套脚本**：`Neuron-Pj16/l3.raw/files/20261110183000-safe-eject.ts`（在工作区外执行：读 `.claude/gateway/{token,port}` → POST → 轮询端口关闭 → 扫描残留进程并给出「可弹出」结论）。
