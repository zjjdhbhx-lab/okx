# ETH 交易快照 — 网页版

把扩展的所有抓取/计算/格式化逻辑搬到一个**纯静态前端**,挂 GitHub Pages,iPhone Safari 直接用。
账户参数和代理 URL 都存浏览器 localStorage,**不上传任何数据**。

## 文件

```
eth-snapshot-v2-web/
├── index.html      ← 入口
├── app.css         ← 移动端深色样式
├── app.js          ← UI 编排 (~120 行)
├── snapshot.js     ← 数据抓取 + 指标 + Markdown 生成 (~1100 行, 从扩展 background.js 移植)
└── README.md       ← 本文件
```

## 部署到 GitHub Pages

1. 把整个 `eth-snapshot-v2-web/` 目录提交到你的 GitHub 仓库(可以放在仓库根或任意子目录)。
2. 仓库 **Settings → Pages** → Source 选 `Deploy from a branch` → 分支选 `main` → 文件夹按你放的位置选(放根选 `/ (root)`,放 docs 子目录选 `/docs`)。
3. 等 1–2 分钟,Pages 给出 URL,如:
   `https://<你的用户名>.github.io/<仓库名>/eth-snapshot-v2-web/`
4. iPhone Safari 打开该 URL → Safari 分享菜单 → **添加到主屏幕** → 桌面图标点开像 App 一样用。

## CORS 现实(必读)

浏览器跨域有限制,**不同数据源待遇不同**:

| 数据源                                     | 浏览器直连 | 备注                                             |
| ------------------------------------------ | ---------- | ------------------------------------------------ |
| OKX (`www.okx.com/api/v5/...`)             | ✅          | 行情/K线/OI/funding/LSR/taker/清算/盘口/合约信息 |
| CoinGecko (`api.coingecko.com`)            | ✅          | 跨交易所 OI、stETH/ETH、BTC.D/ETH.D              |
| Yahoo Finance (`query1.finance.yahoo.com`) | ❌          | DXY / NDX / US10Y — **必须经代理**               |
| Farside (`farside.co.uk`)                  | ❌          | ETH 现货 ETF 流向 — **必须经代理**               |

代理为空时,Yahoo + Farside 这两段会失败并出现在底部"部分数据源失败"列表,**其它段不受影响**(占整体数据的 ~85%)。

### 方案 A:用公共代理(快但不稳)

在面板"CORS 代理 URL"填:

```
https://api.allorigins.win/raw?url=
```

或 `https://corsproxy.io/?` 等。**缺点**:第三方服务,可能限流、可能下线、可能注入广告。**适合临时用**。

### 方案 B:部署你自己的 Cloudflare Worker(推荐,免费,3 分钟)

1. 注册 https://dash.cloudflare.com (免费账号)
2. **Workers & Pages → Create → Hello World** 模板
3. 粘下面这段替换默认代码,点 **Deploy**:

```js
// 单文件 CORS 代理 — 用法: https://<你的-worker>.workers.dev/?url=<encoded-target>
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    const target = url.searchParams.get("url");
    if (!target) return new Response("Pass ?url=<encoded-url>", { status: 400 });
    let res;
    try {
      res = await fetch(target, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (e) {
      return new Response("upstream fetch failed: " + e.message, { status: 502 });
    }
    const body = await res.arrayBuffer();
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.delete("content-security-policy");
    headers.delete("content-encoding"); // 已 decompressed
    return new Response(body, { status: res.status, headers });
  },
};
```

4. Deploy 完毕给你一个 URL,如 `https://eth-proxy.<你的子域名>.workers.dev`
5. 面板里 CORS 代理填:`https://eth-proxy.<你的子域名>.workers.dev/?url=` (**末尾保留 `?url=`**,代码会自动拼 encodeURIComponent(目标URL))
6. Cloudflare Workers 免费额度 10 万请求/天,这种用法一天点 100 次都用不到 1%

## iPhone 使用提示

- 添加到主屏幕后,首次打开会进入"App 模式"(无 Safari 工具栏),全屏更顺手
- 抓取一次 ~2–5 秒,完成后点"📋 复制 Markdown",切到 Claude.ai 长按粘贴
- 账户参数填一次就够,localStorage 保留;清浏览器数据才会丢
- 暗色主题,深夜复盘不刺眼

## 与 Chrome 扩展的差异

|                 | 扩展版                       | 网页版                      |
| --------------- | ---------------------------- | --------------------------- |
| Yahoo / Farside | ✅ 扩展 host_permissions 直抓 | ⚠️ 需 CORS 代理              |
| Coinglass       | ⚙️ 可选(扩展面板填 key)       | ❌ 移除(浏览器侧无 key 管理) |
| 输出内容        | 完全一致 14 段               | 完全一致 14 段              |
| 数据复制        | 自动注入 Claude.ai 对话框    | 复制按钮 → 手动粘贴         |
| iPhone 可用     | ❌ Chrome 扩展 iOS 不支持     | ✅ 任何浏览器                |

## 本地预览(可选)

```powershell
cd D:\app\eth\eth-snapshot-v2-web
python -m http.server 8080
# 然后浏览器开 http://localhost:8080/
```

直接双击 `index.html` 也能开,但 `file://` 协议下 OKX 等部分接口可能因 CORS 拒绝。**走 http server 或 https 域名最稳**。

## 注意事项

- 国内访问 Cloudflare Workers 走 `*.workers.dev` 域名通常可用,实在被墙可绑自己的域名 + Cloudflare 默认 CDN
- 公共代理(allorigins / corsproxy)从国内访问稳定性参差,看运气
- OKX 接口对单 IP 有限流,正常使用(几秒点一次)碰不到上限

