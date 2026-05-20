/* app.js — UI 编排
 * 调用 window.buildSnapshot(symbol, account, proxy, progressCb)
 * 持久化所有表单字段到 localStorage; iPhone Safari 可"添加到主屏幕"作伪 App
 */
const $ = (id) => document.getElementById(id);
const KEYS = ["symbol", "equity", "risk", "horizon", "liqtol", "positions", "proxy"];
const BOOL_KEYS = ["proxy-all"];

let lastResult = null;

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.style.color = cls === "err" ? "var(--neg)" : cls === "ok" ? "var(--pos)" : "var(--muted)";
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function readAccount() {
  return {
    equity_usdt: parseFloat($("equity").value) || null,
    risk_per_trade_pct: parseFloat($("risk").value) || null,
    holding_horizon: $("horizon").value || null,
    liq_tolerance_pct: parseFloat($("liqtol").value) || null,
    existing_positions: $("positions").value.trim() || null,
  };
}

function saveAll() {
  for (const k of KEYS) localStorage.setItem("eth_snap_" + k, $(k).value);
  for (const k of BOOL_KEYS) localStorage.setItem("eth_snap_" + k, $(k).checked ? "1" : "");
}

function loadAll() {
  for (const k of KEYS) {
    const v = localStorage.getItem("eth_snap_" + k);
    if (v != null) $(k).value = v;
  }
  for (const k of BOOL_KEYS) {
    $(k).checked = localStorage.getItem("eth_snap_" + k) === "1";
  }
}

async function runFetch() {
  const symbol = ($("symbol").value || "ETH").trim().toUpperCase();
  $("symbol").value = symbol;
  saveAll();

  $("btn-fetch").disabled = true;
  $("btn-fetch").textContent = "抓取中…";
  $("actions").hidden = true;
  $("output").textContent = "";
  $("acc-card").open = false;
  setStatus("准备…");

  const t0 = performance.now();
  try {
    const res = await window.buildSnapshot(
      symbol,
      readAccount(),
      $("proxy").value.trim(),
      (text) => setStatus("⏳ " + text),
      $("proxy-all").checked
    );
    lastResult = res;
    $("output").textContent = res.markdown;
    $("actions").hidden = false;
    const ms = Math.round(performance.now() - t0);
    const errN = res.errors ? Object.keys(res.errors).length : 0;
    if (errN) {
      const list = Object.keys(res.errors).slice(0, 2).join(", ");
      setStatus(`✅ ${ms}ms (${errN} 源失败: ${list}${errN > 2 ? "…" : ""})`, "ok");
    } else {
      setStatus(`✅ 全部成功 ${ms}ms`, "ok");
    }
  } catch (e) {
    setStatus("❌ " + (e.message || String(e)), "err");
  } finally {
    $("btn-fetch").disabled = false;
    $("btn-fetch").textContent = "抓取";
  }
}

async function copyMd() {
  if (!lastResult) return;
  const text = lastResult.markdown;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制 ✓ 现在粘到 Claude.ai");
  } catch (e) {
    // iOS Safari 偶尔抛错: 退化为选中全部
    const range = document.createRange();
    range.selectNodeContents($("output"));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("已全选 — 请长按复制");
  }
}

function dlJson() {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult.json, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  a.download = `eth-snapshot-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  toast("JSON 已下载");
}

document.addEventListener("DOMContentLoaded", () => {
  loadAll();
  // change-on-change 保存(iOS 上 change 触发时机更稳)
  for (const k of [...KEYS, ...BOOL_KEYS]) {
    const el = $(k);
    if (!el) continue;
    el.addEventListener("change", saveAll);
    if (el.type !== "checkbox") el.addEventListener("input", saveAll);
  }
  $("btn-fetch").addEventListener("click", runFetch);
  $("btn-copy").addEventListener("click", copyMd);
  $("btn-json").addEventListener("click", dlJson);

  // Enter 在 symbol 框直接抓取
  $("symbol").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runFetch(); }
  });
});
