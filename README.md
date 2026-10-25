# aliyun-monitor-cf

阿里云 **CDT 公网流量监控 + 自动止损 + 每日财报**，跑在 Cloudflare Workers 上。

零服务器、零 Python 运行时、零第三方依赖 —— 全部是 TypeScript，签名用 `crypto.subtle` 手搓。
免费额度内可盯 **10~13 台**实例，够用就一分钱不花。

> 这是 [aliyun_monitor](https://github.com/10000ge10000/aliyun_monitor) 的 Cloudflare Workers 版，
> 从服务器版 `src/monitor.py` + `src/report.py` 和阿里云函数计算版 `src/fc/index.py` 重写而来。
> 止损判定、告警文案、日报格式逐字对齐旧版，所以切过来历史消息能对得上。

---

## 它做什么

| 场景 | 行为 |
| --- | --- |
| 当月公网流量 ≥ `traffic_limit`（默认 180 GB） | **立刻关机止损**，发 Telegram 预警，24 小时内不重复轰炸 |
| 流量安全但实例是 Stopped | 自动开机，下次 tick 验证是否真起来 |
| 连续 3 次启动失败 | 进 30 分钟冷却，发「启动失败告警」（带账户余额） |
| 连续 3 次查询失败 | 发「监控异常告警」—— 监控失明了，得人工看一眼 |
| 每天 09:00（北京时间） | 推日报：流量、账单、余额、评价 |

Telegram 命令：`/help` `/list` `/status` `/report` `/selftest`（只读，不含开关机按钮）。

---

## 快速开始（网页部署）

全程不碰本地 wrangler，四步。

**1. 建 KV 命名空间**

Dashboard → Storage & Databases → Workers KV → Create instance。
名字随便起，建完记下那串 32 位十六进制 ID。

**2. 写配置**

进刚建的 KV → KV Pairs → Add entry：

| Key | Value |
| --- | --- |
| `config` | 整份配置 JSON（见下面「配置」一节） |

**3. 建 Worker 并连仓库**

Dashboard → Workers & Pages → Create → Workers → Hello World。
**Worker name 必须填 `aliyun-monitor`**，它要和 `wrangler.toml` 里的 `name` 一致。

建好后进 Settings → Build → Connect，选 GitHub 仓库、Production branch 填 `main`。
Build command 留空，Deploy command 保持默认的 `npx wrangler deploy`。

**4. 绑 KV**

同一个 Worker → Settings → Variables and Secrets → KV Namespace Bindings → Add binding：

| 字段 | 值 |
| --- | --- |
| Variable name | `MONITOR_KV` ← 必须叫这个，代码里写死了 |
| KV namespace | 第 1 步建的那个 |

绑完回 Deployments 点 Retry deployment。

**5.（可选）开网页看板**

同一个 Worker → Settings → Variables and Secrets → Add，两个都用 **Secret** 类型：

| Name | Value |
| --- | --- |
| `DASHBOARD_USER` | 你想用的用户名 |
| `DASHBOARD_PASS` | 你想用的密码，越长越好 |

加完直接访问 Worker 根路径 `/` 就能登录看板。**不加这两个变量也不影响任何功能**——
cron 巡检、止损、日报、Telegram 告警全部照常，只是访问 `/` 会返回一页 503 说明怎么配。

### 网页看板

根路径 `/` 是一张单页看板，不用装任何东西，手机上也能看。

**能做什么**

- 看每台实例的实时状态：运行状态、公网 IP、规格、流量进度条、实例账单、账户总账、余额、评估结论
- 看调度摘要：现在几点（北京时间）、下次巡检 / 下次开机 / 下次日报分别是什么时候
- 看状态机里记的东西：连续巡检失败次数、连续启动失败次数、待开机时刻、最近一次告警事件
- 五个手动按钮：立即巡检、发日报、链路自检、权限探测、配置校验

**刻意不做的事**

- **没有开机按钮**。`mode=start` 不在看板白名单里，只能靠 cron 按 `start_at_minutes` 开机。
  开机是花钱的动作，不给网页一个误触的机会。
- **不自动轮询**。`/api/status` 一次要打 5 个子请求/实例，所以只在点「刷新」时跑。
  页面上显示「采集于 …」，看的是那一刻的快照，不是实时流。
- **不改任何东西**。看板只读 KV + 打阿里云查询接口，唯一的写操作是 `/api/run` 触发的
  那几个 mode（它们本身也是巡检/日报，不改配置、不改实例状态）。

**认证怎么做的**

`DASHBOARD_USER` / `DASHBOARD_PASS` 存在 Worker Secret 里，登录成功后发一个签名 Cookie：

```
dash = <过期毫秒>.<HMAC-SHA256(DASHBOARD_PASS, "dash-v1:" + 过期毫秒)>
```

属性 `HttpOnly; Secure; SameSite=Strict; Path=/`，有效期 **180 天**。
签名密钥就是密码本身——**改密码等于让所有已登录的浏览器立刻失效**，不用额外维护密钥。

CSRF 靠两层：`SameSite=Strict` 让跨站请求带不上 Cookie，另外所有写操作都要求
`X-Requested-With: dashboard` 头，浏览器跨站表单发不出自定义头。

**路由一览**

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 无（页面本身），数据要登录 | 看板 |
| GET | `/health` | 无 | 三行纯文本，给脚本和探活用 |
| POST | `/api/login` | 无 | 换 Cookie |
| POST | `/api/logout` | 无 | 清 Cookie |
| GET | `/api/summary` | Cookie 或 Bearer | 只读 KV，不花阿里云子请求 |
| POST | `/api/status` | Cookie 或 Bearer | 打阿里云，5 子请求/实例 |
| POST | `/api/run?mode=` | Cookie 或 Bearer | 只允许 monitor / report / selftest / ecs / config |
| POST | `/run?mode=` | Bearer `MONITOR_SECRET` | 原来的接口，一字没改 |
| POST | `/tg/<MONITOR_SECRET>` | 路径里的 secret | Telegram webhook，一字没改 |

`/api/*` 同时接受 Cookie 和 `Authorization: Bearer <MONITOR_SECRET>`，所以脚本也能拉数据：

```bash
curl -s "$BASE/api/summary" -H "Authorization: Bearer $SECRET" | jq
curl -s -X POST "$BASE/api/status" -H "Authorization: Bearer $SECRET" | jq
```

**安全上要知道的两件事**

1. 看板走 HTTPS，但密码强度就是全部安全性——没有限速、没有锁定。
   别用短密码，别和别处复用。
2. Cookie 是 180 天的。在别人电脑上登录过，记得点「退出」，或者改一次 `DASHBOARD_PASS`
   让全部会话作废。

### 为什么 KV 不在 wrangler.toml 里声明

仓库是公开的，KV namespace ID 虽然不算密钥，但没必要进 Git。
`wrangler.toml` 里用 `[unsafe.metadata]` 塞了一个 `keep_bindings`：

```toml
[unsafe.metadata]
keep_bindings = ["kv_namespace", "secret_text", "secret_key"]
```

没有这一行，wrangler 部署时会用自己算的 binding 集合覆盖远端，
Dashboard 上手工绑的 KV 会被清掉 —— wrangler 内部的 `keep_bindings`
只认 `plain_text` / `json` / `secret_text` / `secret_key`，从不包含 `kv_namespace`。
`unsafe.metadata` 是唯一能在配置层覆盖它的口子（见 wrangler-dist `cli.js:105166`）。

代价是每次部署会打一条 `"unsafe" fields are experimental` 警告，不影响部署。

### 可选：HTTP 触发和 Telegram 命令

不加 `MONITOR_SECRET` 也能跑 —— cron 巡检、止损、日报、告警全部正常，
因为告警是直接调 `api.telegram.org` 推送的，不经过 webhook。

想手动触发或让机器人在群里回话，才需要：

```bash
npx wrangler secret put MONITOR_SECRET
# 然后绑 webhook
curl "https://api.telegram.org/bot<bot_token>/setWebhook?url=https://<worker>.workers.dev/tg/<MONITOR_SECRET>"
```

### 或者用 CLI 部署

```bash
npm install
npx wrangler login
npx wrangler kv namespace create MONITOR_KV    # 记下 id
npx wrangler kv key put config --path ./config.json --binding MONITOR_KV
npx wrangler secret put MONITOR_SECRET         # 可选
npx wrangler deploy
```

CLI 这条路要在 `wrangler.toml` 里补回 `[[kv_namespaces]]` 段（带真实 ID），
否则部署后没有 KV 绑定 —— 状态会退回内存，冷却失效。

> **wrangler 3 默认写远端**，`--local` 才是本地模拟；wrangler 4 反过来，要加 `--remote`。
> 不确定就先 `npx wrangler --version`。

### 部署完先验证，别急着信 cron

```bash
export BASE=https://aliyun-monitor.<你的子域>.workers.dev
export SECRET=<MONITOR_SECRET>

curl -s -X POST "$BASE/run?mode=config"   -H "Authorization: Bearer $SECRET" | jq
curl -s -X POST "$BASE/run?mode=selftest" -H "Authorization: Bearer $SECRET" | jq
curl -s -X POST "$BASE/run?mode=ecs"      -H "Authorization: Bearer $SECRET" | jq
curl -s -X POST "$BASE/run?mode=report"   -H "Authorization: Bearer $SECRET" | jq
```

`selftest` 就是照妖镜：

- `traffic` 有数字 → CDT 签名和地域都对
- `status` 不是「未找到实例」→ `instance_id` / `region` 都对
- `bill` 以「可用:」开头 → 账单站点选对了
- `mode=ecs` 里出现「权限不足」→ RAM 缺 `ecs:StopInstance`，**止损会静默失败**

---

## 配置

```json
{
  "telegram": {
    "bot_token": "123456:ABC-DEF...",
    "chat_id": "-1001234567890",
    "admin_user_ids": [123456789]
  },
  "bark": { "bark_url": "https://api.day.app/YOUR_KEY" },
  "usd_cny_rate": 7.2,
  "schedule": {
    "auto_start": true,
    "start_at_minutes": [0, 30],
    "report_at": "09:00",
    "report_weekdays": [0, 1, 2, 3, 4, 5, 6]
  },
  "users": [
    {
      "name": "hk-01",
      "instance_id": "i-bp1xxxxxxxxxxxx",
      "region": "cn-hongkong",
      "traffic_limit": 180,
      "bill_threshold": 1.0,
      "bill_endpoint": "business.ap-southeast-1.aliyuncs.com",
      "ak": "LTAI5t...",
      "sk": "..."
    }
  ]
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `traffic_limit` | 180 | 当月公网流量上限（GB），到量关机 |
| `bill_threshold` | 1.0 | 账单预警阈值（USD；CNY 账单乘 `usd_cny_rate`） |
| `bill_endpoint` | `business.ap-southeast-1.aliyuncs.com` | 国际站用这个，国内站用 `business.aliyuncs.com`。**填错会 400 NotApplicable** |
| `paused` / `disabled` | false | 临时停掉某台机器 |
| `report_weekdays` | 全周 | 0 = 周日 |
| `auto_start` | true | `false` 就是只止损、永不自动开机 |

`ak`/`sk` 可提到顶层做全局凭证，`users[].ak` 优先。

**AK 需要的 RAM 权限：** `ecs:DescribeInstances`、`ecs:StartInstance`、`ecs:StopInstance`、
`cdt:ListCdtInternetTraffic`、`bss:QueryAccountBalance`、`bss:DescribeInstanceBill`。

---

## 为什么重写，不是移植

| 障碍 | 处理 |
| --- | --- |
| Workers 没有 Python 运行时 | 全部重写成 TS，`src/fc/index.py` 一行用不上 |
| 环境变量 5KB 上限 | FC 版把整份配置塞 `MONITOR_CONFIG_JSON`，多账号必超 → 改放 KV |
| 单次调用 50 个子请求 | 显式 `Budget` 记账，超了就停手并 `log.error` |
| 单次 CPU 10ms | FC 版发完 `StartInstance` 轮询 180 秒等 Running，Workers 等不起 → 记 `pending_start_ts`，下次 tick 验证 |
| 无 `fcntl.flock` | 靠单 cron + 状态时间戳防重复动作 |
| 每账号 5 个 cron 配额 | 只挂一个 `*/5`，止损/开机/日报由 `scheduler.ts` 按北京时间分发 |

打包后 **56 KB / gzip 15 KB**，无运行时依赖。

---

## 目录

```
.
├── src/
│   ├── index.ts      Workers 入口：scheduled() / fetch() / 看板路由 / Telegram webhook
│   ├── dashboard.ts  网页看板：会话签名、cron 时刻推算、状态采集、整页 HTML
│   ├── monitor.ts    止损与开机决策（runMonitor / runStart / Budget）
│   ├── report.ts     日报、自检、权限探测
│   ├── aliyun.ts     阿里云 RPC V1 客户端（HMAC-SHA1 签名 + ECS/CDT/BSS）
│   ├── notify.ts     Telegram / Bark 推送，含 Markdown 降级与分片
│   ├── state.ts      状态读写（KV 后端），读失败拒写
│   ├── scheduler.ts  一个 cron 分发三件事的纯函数
│   ├── config.ts     配置结构、校验、凭证回落
│   └── util.ts       北京时间、脱敏、百分号编码、消息切分
├── test/             node:test 原生测试，108 个用例
├── config.example.json
├── wrangler.toml
└── package.json
```

---

## 运维

### 看日志

```bash
npx wrangler tail
```

每次 tick 打一行 `cron 完成: {...}`，含 `plan`（这分钟跑了哪几件事）、
`stopped` / `started` / `skipped`、`subrequests`、`state_saved`。

### 手动触发

配了 `DASHBOARD_USER` / `DASHBOARD_PASS` 的话，直接开浏览器点按钮最省事（见上面「网页看板」）。

命令行：

```bash
curl -s -X POST "$BASE/run?mode=monitor" -H "Authorization: Bearer $SECRET"
```

`mode` 可选 `monitor` / `start` / `report` / `selftest` / `ecs` / `config`。
注意 `start`（开机）只有这个接口能调，看板刻意不给它入口。

### 状态文件

KV key `state/monitor_state.json`，是「实例 ID → 该实例状态」的平表：

```json
{
  "i-bp1xxxxxxxxxxxx": {
    "overlimit": 1761362400000,
    "check_failures": 0,
    "start_failures": 0,
    "pending_start_ts": 1761362700000
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `overlimit` | 上次发「流量预警」的时间戳，24 小时冷却 |
| `check_failed` | 上次发「监控异常告警」的时间戳，1 小时冷却 |
| `start_failed` | 上次发「启动失败告警」的时间戳，1 小时冷却 |
| `resumed` | 上次发「恢复监控」的时间戳，1 小时冷却 |
| `check_failures` | 连续查询失败次数，≥3 告警 |
| `start_failures` | 连续启动失败次数，≥3 进 30 分钟冷却 |
| `pending_start_ts` | 已下发启动命令、等下次 tick 验证 |

> **读失败就拒写**：`State.save()` 发现 `load()` 没成功过会跳过写入并 warn，
> 避免用空状态覆盖真实状态（否则冷却时间戳全丢，下一秒重复轰炸）。

### 子请求预算

免费版单次 50 个子请求，`SUBREQUEST_BUDGET` 默认 40，留 10 个给告警。
一台实例一轮 `monitor` 约 2 个（CDT 流量 + DescribeInstances），关机 +1，发告警 +1~2。

**所以免费版大约盯 10~13 台。** 更多就调大 `SUBREQUEST_BUDGET`（付费版上限 10000）。

预算耗尽时的行为是**有意设计**的：

- 查不到流量 → 跳过这台继续下一台（不误关机）
- 该关机但没额度 → `log.error("子请求预算耗尽，无法下发关机 —— 这是最坏的情况")`
- 该告警但没额度 → 跳过，下轮重试（冷却时间戳没写）

### KV 写额度

免费版 1000 写/天。5 分钟一个 tick = 288 次/天，但 `State.save()` 内容没变就不写。
真撞上限就把 cron 放宽到 `*/10`。

---

## 测试

```bash
npm run typecheck   # tsc --noEmit，零错
npm test            # 108 个用例
```

| 文件 | 用例 | 守什么 |
| --- | --- | --- |
| `util.test.ts` | 10 | 北京时间换算、百分号编码、base64、消息切分不丢字 |
| `aliyun.test.ts` | 18 | RPC V1 签名与 Python 版算出的已知向量逐字对齐；`Items` 两种返回形状；公网 IP 三级回落 |
| `scheduler.test.ts` | 12 | 分钟点分发、cron 与 schedule 自洽性校验 |
| `monitor.test.ts` | 13 | 止损/开机五种情形、冷却、预算耗尽、连续失败告警 |
| `state.test.ts` | 10 | 读失败拒写、内容没变不写、非法 JSON 兜底 |
| `notify.test.ts` | 19 | 4xx 不算成功、Markdown 降级、分片、Bark 编码 |
| `report.test.ts` | 10 | 评估优先级：超标 > 接近上限 > 扣费预警 > 正常 |
| `dashboard.test.ts` | 16 | 会话伪造、Cookie 解析、下次巡检/开机/日报时刻推算、KV 摘要拼装 |

`monitor.test.ts` 不打桩内部函数，而是换掉 `globalThis.fetch` ——
从「查流量 → 判阈值 → 下发 ECS 命令 → 发告警 → 写状态」整条路都是真代码在跑。

`test/gen_signature_vector.py` 用旧版 Python 实现算出一组固定签名给 `aliyun.test.ts` 当向量。
改签名逻辑时这个测试会先红。

---

## 排障

**`没有 MONITOR_KV 绑定，也没设 CONFIG_JSON`**
→ Dashboard → Settings → Variables and Secrets 里没绑 KV，或变量名不叫 `MONITOR_KV`。

**`KV 里没有 config`**
→ 配置没写进去，或写到了本地模拟 KV。Dashboard 的 KV Pairs 里 Key 必须是 `config`。

**`SignatureDoesNotMatch`**
→ `sk` 复制时带了换行或空格。

**`NotApplicable` / `caller site does not match the API domain`**
→ 国际站账号打了 `business.aliyuncs.com`，改 `bill_endpoint`。

**日报「账单: Fail」但余额正常**
→ `DescribeInstanceBill` 缺 `bss:DescribeInstanceBill` 权限时会退到
`QueryBillOverview`，那条标 `(账号总览)`，数字偏大是正常的。

**`ecs:StopInstance` 权限不足**
→ 跑 `mode=ecs` 看。缺这个权限时止损会**静默失败**，日志只有
`StopInstance 失败: Forbidden`，实例照跑照扣流量。

**cron 没触发**
→ 免费版 cron 最终一致，可能延迟几分钟。`wrangler tail` 确认有没有
`cron 触发` 那行；没有就去 Dashboard → Worker → Settings → Triggers 看有没有挂上。

**告警重复轰炸**
→ 状态没写进 KV。看 `wrangler tail` 里的 `state_saved: false`，
通常是 `load()` 失败过，此时 `save()` 主动拒写。
如果日志里有 `没有 MONITOR_KV 绑定 —— 状态改用内存后端`，那是 KV 没绑上，
每次调用内存都是空的，冷却时间戳存不住，同一条告警每 5 分钟重复一次。

**访问 `/` 返回 503「看板未启用」**
→ 没配 `DASHBOARD_USER` / `DASHBOARD_PASS`。这两个是 Worker **Secret**，
配完要等新版本生效（Dashboard 改 Secret 会立刻生效，不用重新部署）。
`/health` 和 `/run` 不受影响。

**看板能打开但一直停在登录页**
→ 登录成功但 Cookie 存不下。检查是不是用 `http://` 访问的（`Secure` Cookie 只在
HTTPS 下保存），或者浏览器禁了 Cookie。`workers.dev` 域名默认就是 HTTPS。

**看板登录后过一会儿又掉登录**
→ 改过 `DASHBOARD_PASS`。签名密钥就是密码，改了密码所有旧 Cookie 立刻失效。

---

## 从旧版迁移

1. 部署 Workers 版，跑 `mode=selftest` 确认所有字段正常
2. 让 `mode=report` 手动推一周日报，和旧版数字对一遍
3. 确认一致后，停掉服务器上的 cron / 阿里云 FC 函数

| 旧文件 | 状态 |
| --- | --- |
| `src/monitor.py` | 逻辑已全部搬进 `src/monitor.ts` |
| `src/report.py` | 搬进 `src/report.ts` |
| `src/ecs_bot.py` | 只搬了只读命令，开关机按钮没搬 |
| `src/fc/index.py` | 功能等价版是 `src/*.ts`，FC 版可下线 |
| `install.sh` / `install2.sh` | 装服务器版用，与本项目无关 |

---

## 免责

同上游 [aliyun_monitor](https://github.com/10000ge10000/aliyun_monitor)：作者不对因脚本异常、
API 变更、依赖失效或配置错误导致的任何流量流失及费用直接负责。
`traffic_limit` 请留足余量 —— 止损是最后一道闸，不是唯一的闸。
