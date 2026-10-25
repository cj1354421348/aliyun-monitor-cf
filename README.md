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

## 快速开始

```bash
npm install
npx wrangler login

# 1. 建 KV
npx wrangler kv namespace create MONITOR_KV
#    把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]

# 2. 填配置
cp config.example.json config.json   # 填真 AK / bot_token / instance_id

# 3. 配置进 KV（改配置不用重新 deploy）
npx wrangler kv key put config --path ./config.json --binding MONITOR_KV

# 4. HTTP 触发密钥
npx wrangler secret put MONITOR_SECRET

# 5. 部署
npx wrangler deploy
```

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
│   ├── index.ts      Workers 入口：scheduled() / fetch() / Telegram webhook
│   ├── monitor.ts    止损与开机决策（runMonitor / runStart / Budget）
│   ├── report.ts     日报、自检、权限探测
│   ├── aliyun.ts     阿里云 RPC V1 客户端（HMAC-SHA1 签名 + ECS/CDT/BSS）
│   ├── notify.ts     Telegram / Bark 推送，含 Markdown 降级与分片
│   ├── state.ts      状态读写（KV 后端），读失败拒写
│   ├── scheduler.ts  一个 cron 分发三件事的纯函数
│   ├── config.ts     配置结构、校验、凭证回落
│   └── util.ts       北京时间、脱敏、百分号编码、消息切分
├── test/             node:test 原生测试，84 个用例
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

```bash
curl -s -X POST "$BASE/run?mode=monitor" -H "Authorization: Bearer $SECRET"
```

`mode` 可选 `monitor` / `start` / `report` / `selftest` / `ecs` / `config`。

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
npm test            # 84 个用例
```

| 文件 | 用例 | 守什么 |
| --- | --- | --- |
| `util.test.ts` | 10 | 北京时间换算、百分号编码、base64、消息切分不丢字 |
| `aliyun.test.ts` | 10 | RPC V1 签名与 Python 版算出的已知向量逐字对齐 |
| `scheduler.test.ts` | 12 | 分钟点分发、cron 与 schedule 自洽性校验 |
| `monitor.test.ts` | 13 | 止损/开机五种情形、冷却、预算耗尽、连续失败告警 |
| `state.test.ts` | 10 | 读失败拒写、内容没变不写、非法 JSON 兜底 |
| `notify.test.ts` | 19 | 4xx 不算成功、Markdown 降级、分片、Bark 编码 |
| `report.test.ts` | 10 | 评估优先级：超标 > 接近上限 > 扣费预警 > 正常 |

`monitor.test.ts` 不打桩内部函数，而是换掉 `globalThis.fetch` ——
从「查流量 → 判阈值 → 下发 ECS 命令 → 发告警 → 写状态」整条路都是真代码在跑。

`test/gen_signature_vector.py` 用旧版 Python 实现算出一组固定签名给 `aliyun.test.ts` 当向量。
改签名逻辑时这个测试会先红。

---

## 排障

**`KV 里没有 config`**
→ 配置没写进去，或写到了本地模拟 KV。

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
