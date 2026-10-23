const $ = (selector) => document.querySelector(selector);

const state = {
  settings: {},
  devices: [],
  source: "demo",
  lastSync: null,
  history: [],
  selectedId: null,
  mapBounds: null,
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
  const bounds = state.mapBounds;
  if (!bounds) return { x: 50, y: 48 };
  return {
    x: Math.max(4, Math.min(96, ((Number(location.longitude) - bounds.left) / (bounds.right - bounds.left)) * 100)),
    y: Math.max(4, Math.min(96, (1 - (Number(location.latitude) - bounds.bottom) / (bounds.top - bounds.bottom)) * 100)),
  };
}

function renderSource() {
  const source = state.source || "demo";
  const label = $("#sourceLabel");
  const hint = $("#sourceHint");
  const dot = $("#sourceDot");
  dot.classList.remove("status-dot--warn");
  if (source === "findhub" || source === "online") {
    label.textContent = "奶蛙已連線";
    hint.textContent = "奶蛙正在回報位置";
  } else if (source === "demo-fallback") {
    label.textContent = "連線需要處理";
    hint.textContent = "先看示範位置，管理員可檢查連線";
    dot.classList.add("status-dot--warn");
  } else {
    label.textContent = "奶蛙示範模式";
    hint.textContent = "可以先試用這個小角落";
  }
}

function renderDevices() {
  const list = $("#deviceList");
  list.replaceChildren();
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
    name.textContent = device.name || "奶蛙";
    const model = document.createElement("small");
    model.textContent = device.model || "奶蛙的足跡";
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
    empty.textContent = "還沒有讀到奶蛙。";
    list.append(empty);
  }
}

function renderMap(device) {
  const location = device?.location;
  const hasCoordinates = location && location.latitude != null && location.longitude != null;
  const marker = $("#mapMarker");
  const empty = $("#mapEmpty");
  const mapStage = $("#mapStage");
  const mapFrame = $("#mapFrame");
  if (hasCoordinates) {
    mapStage.classList.add("has-external-map");
    const points = [location, ...(state.history || []).map((item) => item.location || {})].filter((item) => item.latitude != null && item.longitude != null);
    const latitudes = points.map((item) => Number(item.latitude));
    const longitudes = points.map((item) => Number(item.longitude));
    const latRange = Math.max(...latitudes) - Math.min(...latitudes);
    const lngRange = Math.max(...longitudes) - Math.min(...longitudes);
    const latPadding = Math.max(0.018, latRange * 0.28);
    const lngPadding = Math.max(0.018, lngRange * 0.28);
    // Leave more breathing room to the north-east so the current point has
    // visible context instead of being pinned to the exact center.
    const left = Math.min(...longitudes) - lngPadding;
    const right = Math.max(...longitudes) + lngPadding * 2.2;
    const bottom = Math.min(...latitudes) - latPadding * 1.8;
    const top = Math.max(...latitudes) + latPadding;
    state.mapBounds = { left, right, bottom, top };
    mapFrame.src = `https://www.openstreetmap.org/export/embed.html?bbox=${left},${bottom},${right},${top}&layer=mapnik`;
    mapFrame.hidden = false;
    const position = mapPosition(location);
    marker.style.left = `${position.x}%`;
    marker.style.top = `${position.y}%`;
    marker.hidden = false;
    empty.hidden = true;
    $("#markerLabel").textContent = location.label || state.settings.locationCaption || "奶蛙秘密基地";
    $("#markerTime").textContent = relativeTime(device.lastLocatedAt || location.timestamp);
    $("#locationLabel").textContent = location.label || state.settings.locationCaption || "最近回報位置";
    $("#coordinates").textContent = "位置已保護 · 地圖已更新";
    $("#mapsLink").href = location.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
    $("#lastSeen").textContent = relativeTime(device.lastLocatedAt || location.timestamp);
    $("#accuracy").textContent = location.accuracy ? `約 ${location.accuracy} 公尺` : "精準度未知";
    $("#trackerStatus").textContent = device.status === "ready" ? "等待定位" : "正在附近";
    $("#mapStatus").innerHTML = `<span class="history-legend-dot"></span> 過去足跡　<span class="status-dot status-dot--live"></span> 定位已更新`;
  } else {
    marker.hidden = true;
    empty.hidden = false;
    mapStage.classList.remove("has-external-map");
    mapFrame.hidden = true;
    mapFrame.removeAttribute("src");
    $("#locationLabel").textContent = "還沒有位置回報";
    $("#coordinates").textContent = "位置已保護 · 按下按鈕開始尋找";
    $("#mapsLink").href = "#";
    $("#lastSeen").textContent = "等待回報";
    $("#accuracy").textContent = "—";
    $("#trackerStatus").textContent = "尚未定位";
    $("#mapStatus").innerHTML = `<span class="status-dot status-dot--warn"></span> 等待定位`;
    state.mapBounds = null;
  }
  renderHistoryMarkers();
}

function renderHistoryMarkers() {
  const container = $("#historyMarkers");
  if (!container) return;
  container.replaceChildren();
  const bounds = state.mapBounds;
  if (!bounds) return;
  const current = selectedDevice()?.location;
  (state.history || []).forEach((entry) => {
    const location = entry.location || {};
    if (location.latitude == null || location.longitude == null) return;
    if (current && Math.abs(Number(location.latitude) - Number(current.latitude)) < 0.000001 && Math.abs(Number(location.longitude) - Number(current.longitude)) < 0.000001) return;
    const x = Math.max(2, Math.min(98, ((Number(location.longitude) - bounds.left) / (bounds.right - bounds.left)) * 100));
    const y = Math.max(2, Math.min(98, (1 - (Number(location.latitude) - bounds.bottom) / (bounds.top - bounds.bottom)) * 100));
    const dot = document.createElement("span");
    dot.className = "history-map-dot";
    dot.style.left = `${x}%`;
    dot.style.top = `${y}%`;
    dot.title = `${relativeTime(entry.locatedAt)}的足跡`;
    dot.setAttribute("aria-label", dot.title);
    container.append(dot);
  });
}

function render() {
  const settings = state.settings;
  document.documentElement.dataset.accent = settings.accent || "yellow";
  $("#brandTitle").textContent = settings.title || "奶蛙在哪裡";
  $("#heroTitle").textContent = `${settings.title || "奶蛙在哪裡"}？`;
  $("#tagline").textContent = settings.tagline || "今天的奶蛙，也在努力探索世界。";
  $("#todayLabel").textContent = `${new Intl.DateTimeFormat("zh-TW", { month: "long", day: "numeric" }).format(new Date())} · NAIWA`;
  $("#syncLabel").textContent = state.lastSync ? `同步於 ${formatDate(state.lastSync)}` : "尚未同步";
  setAvatar($("#miniAvatar"), settings.avatarDataUrl);
  setAvatar($("#markerAvatar"), settings.avatarDataUrl);
  renderSource();
  renderDevices();
  const device = selectedDevice();
  if (device) {
    $("#selectedName").textContent = device.name || settings.deviceName || "奶蛙";
    $("#selectedModel").textContent = device.model || "奶蛙的足跡";
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
    state.history = data.history || [];
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
  if (!device) return showToast("目前沒有奶蛙資料", "error");
  const button = $("#locateButton");
  button.disabled = true;
  button.querySelector("span:last-child").textContent = "正在尋找…";
  try {
    const result = await api(`/api/trackers/${encodeURIComponent(device.id)}/locate`, { method: "POST", body: "{}" });
    const updated = result.device || result;
    const index = state.devices.findIndex((item) => item.id === updated.id);
    if (index >= 0) state.devices[index] = updated;
    state.history = result.history || state.history;
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

$("#refreshButton").addEventListener("click", refreshDevices);
$("#locateButton").addEventListener("click", locateSelected);

loadBootstrap();
