const $ = (selector) => document.querySelector(selector);

const state = {
  settings: {},
  devices: [],
  source: "demo",
  lastSync: null,
  selectedId: null,
  avatarDataUrl: "",
};

let toastTimer;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `請求失敗（${response.status}）`);
  return data;
}

function showToast(message, kind = "info") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function selectedDevice() {
  return state.devices.find((device) => device.id === state.selectedId) || state.devices[0] || null;
}

function formatDate(value) {
  if (!value) return "尚未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "剛剛";
  return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function relativeTime(value) {
  if (!value) return "等待回報";
  const date = new Date(value);
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function setAvatar(element, dataUrl, fallback = "🐸") {
  if (!element) return;
  if (dataUrl) {
    element.textContent = "";
    element.style.backgroundImage = `url("${dataUrl}")`;
    element.style.backgroundSize = "cover";
    element.style.backgroundPosition = "center";
  } else {
    element.textContent = fallback;
    element.style.backgroundImage = "";
  }
}

function mapPosition(location) {
  if (!location || location.latitude == null || location.longitude == null) return null;
  // A calm, familiar canvas for Taipei.  Locations outside this view are
  // gently clamped to its edge while the exact coordinates remain visible.
  const minLat = 24.94;
  const maxLat = 25.12;
  const minLng = 121.45;
  const maxLng = 121.67;
  const x = Math.max(9, Math.min(91, ((location.longitude - minLng) / (maxLng - minLng)) * 100));
  const y = Math.max(11, Math.min(83, (1 - (location.latitude - minLat) / (maxLat - minLat)) * 100));
  return { x, y };
}

function renderSource() {
  const source = state.source || "demo";
  const label = $("#sourceLabel");
  const hint = $("#sourceHint");
  const dot = $("#sourceDot");
  dot.classList.remove("status-dot--warn");
  if (source === "findhub") {
    label.textContent = "Find Hub 已連線";
    hint.textContent = "Xiaomi Tag 正在回報位置";
  } else if (source === "demo-fallback") {
    label.textContent = "連線需要處理";
    hint.textContent = "先看示範位置，管理員可檢查連線";
    dot.classList.add("status-dot--warn");
  } else {
    label.textContent = "示範模式";
    hint.textContent = "可以先試用奶蛙的介面";
  }
}

function renderDevices() {
  const list = $("#deviceList");
  list.replaceChildren();
  $("#deviceCount").textContent = String(state.devices.length);
  state.devices.forEach((device) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `device-item${device.id === state.selectedId ? " is-selected" : ""}`;
    button.dataset.id = device.id;
    const avatar = document.createElement("span");
    avatar.className = "device-avatar";
    setAvatar(avatar, state.settings.avatarDataUrl);
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = device.name || "Xiaomi Tag";
    const model = document.createElement("small");
    model.textContent = device.model || "Find Hub 裝置";
    copy.append(name, model);
    const status = document.createElement("i");
    status.className = `device-state${device.status === "ready" ? " device-state--muted" : ""}`;
    status.setAttribute("aria-hidden", "true");
    button.append(avatar, copy, status);
    button.addEventListener("click", () => {
      state.selectedId = device.id;
      render();
    });
    list.append(button);
  });
  if (!state.devices.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "還沒有讀到追蹤器。";
    list.append(empty);
  }
}

function renderMap(device) {
  const location = device?.location;
  const hasCoordinates = location && location.latitude != null && location.longitude != null;
  const marker = $("#mapMarker");
  const empty = $("#mapEmpty");
  if (hasCoordinates) {
    const position = mapPosition(location);
    marker.style.left = `${position.x}%`;
    marker.style.top = `${position.y}%`;
    marker.hidden = false;
    empty.hidden = true;
    $("#markerLabel").textContent = location.label || state.settings.locationCaption || "奶蛙秘密基地";
    $("#markerTime").textContent = relativeTime(location.timestamp);
    $("#locationLabel").textContent = location.label || state.settings.locationCaption || "最近回報位置";
    $("#coordinates").textContent = `${Number(location.latitude).toFixed(5)}° N · ${Number(location.longitude).toFixed(5)}° E`;
    $("#mapsLink").href = location.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
    $("#lastSeen").textContent = relativeTime(location.timestamp);
    $("#accuracy").textContent = location.accuracy ? `約 ${location.accuracy} 公尺` : "精準度未知";
    $("#trackerStatus").textContent = device.status === "ready" ? "等待定位" : "正在附近";
    $("#mapStatus").innerHTML = `<span class="status-dot status-dot--live"></span> 定位已更新`;
  } else {
    marker.hidden = true;
    empty.hidden = false;
    $("#locationLabel").textContent = "還沒有位置回報";
    $("#coordinates").textContent = "按下「現在定位」開始尋找";
    $("#mapsLink").href = "#";
    $("#lastSeen").textContent = "等待回報";
    $("#accuracy").textContent = "—";
    $("#trackerStatus").textContent = "尚未定位";
    $("#mapStatus").innerHTML = `<span class="status-dot status-dot--warn"></span> 等待定位`;
  }
}

function render() {
  const settings = state.settings;
  document.documentElement.dataset.accent = settings.accent || "lime";
  $("#brandTitle").textContent = settings.title || "奶蛙在哪裡";
  $("#heroTitle").textContent = `${settings.title || "奶蛙在哪裡"}？`;
  $("#tagline").textContent = settings.tagline || "今天的奶蛙，也在努力探索世界。";
  $("#todayLabel").textContent = `${new Intl.DateTimeFormat("zh-TW", { month: "long", day: "numeric" }).format(new Date())} · FIND HUB`;
  $("#syncLabel").textContent = state.lastSync ? `同步於 ${formatDate(state.lastSync)}` : "尚未同步";
  setAvatar($("#miniAvatar"), settings.avatarDataUrl);
  setAvatar($("#markerAvatar"), settings.avatarDataUrl);
  renderSource();
  renderDevices();
  const device = selectedDevice();
  if (device) {
    $("#selectedName").textContent = device.name || settings.deviceName || "奶蛙的 Xiaomi Tag";
    $("#selectedModel").textContent = device.model || "Xiaomi Tag";
    $("#noteCopy").textContent = device.location ? "只要有回報，就知道你平安。慢慢走、好好玩，晚上見。" : "奶蛙還沒回報位置，按一下「現在定位」請它冒個泡。";
  }
  renderMap(device);
}

async function loadBootstrap(showMessage = false) {
  try {
    const data = await api("/api/bootstrap");
    state.settings = data.settings || {};
    state.devices = data.devices || [];
    state.source = data.source || "demo";
    state.lastSync = data.lastSync;
    if (!state.selectedId || !state.devices.some((item) => item.id === state.selectedId)) state.selectedId = state.devices[0]?.id || null;
    render();
    if (showMessage) showToast("已重新整理奶蛙的位置", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function refreshDevices() {
  const button = $("#refreshButton");
  button.disabled = true;
  try {
    await api("/api/sync", { method: "POST", body: "{}" });
    await loadBootstrap(true);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function locateSelected() {
  const device = selectedDevice();
  if (!device) return showToast("目前沒有可定位的追蹤器", "error");
  const button = $("#locateButton");
  button.disabled = true;
  button.querySelector("span:last-child").textContent = "正在尋找…";
  try {
    const updated = await api(`/api/trackers/${encodeURIComponent(device.id)}/locate`, { method: "POST", body: "{}" });
    const index = state.devices.findIndex((item) => item.id === updated.id);
    if (index >= 0) state.devices[index] = updated;
    state.lastSync = new Date().toISOString();
    render();
    showToast("找到奶蛙了！位置已更新", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.querySelector("span:last-child").textContent = "現在定位";
  }
}

function fillCustomizeForm() {
  const form = $("#customizeForm");
  form.elements.deviceName.value = state.settings.deviceName || "";
  form.elements.locationCaption.value = state.settings.locationCaption || "";
  form.elements.title.value = state.settings.title || "";
  form.elements.tagline.value = state.settings.tagline || "";
  form.elements.accent.value = state.settings.accent || "lime";
  setAvatar($("#avatarPreview"), state.settings.avatarDataUrl);
  state.avatarDataUrl = state.settings.avatarDataUrl || "";
}

function openCustomize() {
  fillCustomizeForm();
  $("#customizeModal").hidden = false;
  setTimeout(() => $("#customizeForm").elements.deviceName.focus(), 20);
}

function closeCustomize() { $("#customizeModal").hidden = true; }

async function saveCustomize(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    deviceName: form.elements.deviceName.value,
    locationCaption: form.elements.locationCaption.value,
    title: form.elements.title.value,
    tagline: form.elements.tagline.value,
    accent: form.elements.accent.value,
    avatarDataUrl: state.avatarDataUrl,
  };
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const data = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    state.settings = data.settings || state.settings;
    state.devices = data.devices || state.devices;
    state.source = data.source || state.source;
    state.lastSync = data.lastSync || state.lastSync;
    render();
    closeCustomize();
    showToast("自訂已儲存，奶蛙換上新造型了", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

$("#refreshButton").addEventListener("click", refreshDevices);
$("#locateButton").addEventListener("click", locateSelected);
$("#openCustomize").addEventListener("click", openCustomize);
$("#closeCustomize").addEventListener("click", closeCustomize);
$("#cancelCustomize").addEventListener("click", closeCustomize);
$("#customizeModal").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeCustomize(); });
$("#customizeForm").addEventListener("submit", saveCustomize);
$("#avatarInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2_000_000) return showToast("圖片太大，請選擇 2 MB 以內的圖片", "error");
  const reader = new FileReader();
  reader.onload = () => { state.avatarDataUrl = reader.result; setAvatar($("#avatarPreview"), state.avatarDataUrl); };
  reader.readAsDataURL(file);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#customizeModal").hidden) closeCustomize(); });

loadBootstrap();
