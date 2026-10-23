const $ = (selector) => document.querySelector(selector);
let adminKey = sessionStorage.getItem("naiwaAdminKey") || "";
let avatarDataUrl = "";
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

function renderHistory(history = []) {
  const list = $("#adminHistoryList");
  list.replaceChildren();
  history.forEach((entry) => {
    const location = entry.location || {};
    const row = document.createElement("article");
    row.className = "admin-history-item";
    const time = document.createElement("time");
    time.textContent = prettyTime(entry.locatedAt);
    const label = document.createElement("strong");
    label.textContent = location.label || (location.latitude != null ? `${Number(location.latitude).toFixed(5)}, ${Number(location.longitude).toFixed(5)}` : "語意位置");
    const detail = document.createElement("span");
    detail.textContent = `${entry.name || "奶蛙"}${location.accuracy ? ` · 約 ${location.accuracy} 公尺` : ""}`;
    row.append(time, label, detail);
    list.append(row);
  });
  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "尚未記錄定位。";
    list.append(empty);
  }
}

function setAvatar(element, dataUrl) {
  if (!element) return;
  if (dataUrl) {
    element.textContent = "";
    element.style.backgroundImage = `url("${dataUrl}")`;
    element.style.backgroundSize = "cover";
    element.style.backgroundPosition = "center";
  } else {
    element.textContent = "🐸";
    element.style.backgroundImage = "";
  }
}

function renderSettings(settings = {}) {
  const form = $("#customizeForm");
  if (!form) return;
  form.elements.deviceName.value = settings.deviceName || "";
  form.elements.locationCaption.value = settings.locationCaption || "";
  form.elements.title.value = settings.title || "";
  form.elements.tagline.value = settings.tagline || "";
  form.elements.accent.value = settings.accent || "yellow";
  avatarDataUrl = settings.avatarDataUrl || "";
  setAvatar($("#avatarPreview"), avatarDataUrl);
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
  $("#rawPanel").textContent = JSON.stringify({ devices: data.devices || [], history: data.history || [] }, null, 2);
  renderSettings(data.settings || {});
  renderHistory(data.history || []);
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

$("#customizeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const data = await request("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        deviceName: form.elements.deviceName.value,
        locationCaption: form.elements.locationCaption.value,
        title: form.elements.title.value,
        tagline: form.elements.tagline.value,
        accent: form.elements.accent.value,
        avatarDataUrl,
      }),
    });
    renderSettings(data.settings || {});
    showToast("自訂已儲存，首頁會立即套用");
    await loadDiagnostics();
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});

$("#avatarInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2_000_000) {
    showToast("圖片太大，請選擇 2 MB 以內的圖片");
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    avatarDataUrl = reader.result;
    setAvatar($("#avatarPreview"), avatarDataUrl);
  };
  reader.readAsDataURL(file);
});

if (adminKey) {
  $("#adminKey").value = adminKey;
  loadDiagnostics();
}
