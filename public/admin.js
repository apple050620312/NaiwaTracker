const $ = (selector) => document.querySelector(selector);
let adminKey = sessionStorage.getItem("naiwaAdminKey") || "";
let toastTimer;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3000);
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `請求失敗（${response.status}）`);
  return data;
}

function prettyTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function renderDiagnostics(data) {
  const health = data.health || {};
  const items = [
    ["資料來源", health.source === "findhub" ? "Find Hub" : health.source || "—", health.source === "findhub"],
    ["執行模式", health.mode || "—", true],
    ["上游目錄", health.vendorPresent ? "已找到" : "缺少", health.vendorPresent],
    ["認證檔案", health.authFilePresent ? "已找到" : "未設定", health.authFilePresent],
    ["最近同步", prettyTime(health.lastSync), true],
    ["最近錯誤", health.lastError || "沒有錯誤", !health.lastError],
  ];
  const grid = $("#diagnosticGrid");
  grid.replaceChildren();
  items.forEach(([label, value, good]) => {
    const article = document.createElement("article");
    article.className = "diagnostic-item";
    const caption = document.createElement("span");
    caption.textContent = label;
    const text = document.createElement("strong");
    text.textContent = value;
    text.className = good ? "is-good" : "is-bad";
    article.append(caption, text);
    grid.append(article);
  });

  const logs = $("#logList");
  logs.replaceChildren();
  (data.logs || []).forEach((entry) => {
    const row = document.createElement("article");
    row.className = `log-entry log-entry--${entry.level || "info"}`;
    const time = document.createElement("time");
    time.textContent = `${prettyTime(entry.time)} · ${entry.level || "info"}`;
    const message = document.createElement("p");
    message.textContent = entry.message || "";
    row.append(time, message);
    if (entry.details) {
      const details = document.createElement("pre");
      details.textContent = typeof entry.details === "string" ? entry.details : JSON.stringify(entry.details, null, 2);
      row.append(details);
    }
    logs.append(row);
  });
  if (!logs.children.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "還沒有活動紀錄。";
    logs.append(empty);
  }
  $("#rawPanel").textContent = JSON.stringify(data.devices || [], null, 2);
}

async function loadDiagnostics() {
  try {
    const data = await request("/admin/api/diagnostics");
    $("#adminAuth").hidden = true;
    $("#adminPanel").hidden = false;
    renderDiagnostics(data);
  } catch (error) {
    $("#adminAuth").hidden = false;
    $("#adminPanel").hidden = true;
    showToast(error.message);
  }
}

$("#adminAuthForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  adminKey = $("#adminKey").value;
  sessionStorage.setItem("naiwaAdminKey", adminKey);
  await loadDiagnostics();
});

$("#refreshDiagnostics").addEventListener("click", async () => {
  const button = $("#refreshDiagnostics");
  button.disabled = true;
  try {
    await request("/admin/api/refresh", { method: "POST", body: "{}" });
    await loadDiagnostics();
    showToast("診斷資料已更新");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

if (adminKey) {
  $("#adminKey").value = adminKey;
  loadDiagnostics();
}
