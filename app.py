"""Naiwa Tracker: a small, friendly web wrapper around GoogleFindMyTools.

The browser only talks to this local server.  Authentication tokens and the
encrypted Find Hub responses stay on the server side; the UI receives only the
location fields it needs to render the tracker card and map.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import time
import traceback
import uuid
from collections import deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.getenv("NAIWA_DATA_DIR", ROOT / "data"))
SETTINGS_FILE = DATA_DIR / "settings.json"
HISTORY_FILE = DATA_DIR / "history.json"
VENDOR_DIR = Path(os.getenv("FINDHUB_TOOLS_PATH", ROOT / "vendor" / "GoogleFindMyTools"))
HOST = os.getenv("NAIWA_HOST", "127.0.0.1")
PORT = int(os.getenv("NAIWA_PORT", "8765"))
ADMIN_KEY = os.getenv("NAIWA_ADMIN_KEY", "local-admin")
FINDHUB_MODE = os.getenv("FINDHUB_MODE", "auto").strip().lower()

DEFAULT_SETTINGS: dict[str, Any] = {
    "title": "奶蛙在哪裡",
    "tagline": "今天的奶蛙，也在努力探索世界。",
    "deviceName": "奶蛙",
    "locationCaption": "奶蛙秘密基地",
    "avatarDataUrl": "",
    "accent": "yellow",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_safe(value: Any) -> Any:
    """Convert protobuf-ish values to values safe for JSON responses."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return str(value)


class SettingsStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.settings = dict(DEFAULT_SETTINGS)
        self._load()

    def _load(self) -> None:
        with self.lock:
            try:
                if self.path.exists():
                    raw = json.loads(self.path.read_text(encoding="utf-8"))
                    if isinstance(raw, dict):
                        self.settings.update({k: v for k, v in raw.items() if k in DEFAULT_SETTINGS})
            except (OSError, json.JSONDecodeError):
                # A broken settings file should never prevent the tracker from
                # opening.  The admin channel will show the event in the log.
                self.settings = dict(DEFAULT_SETTINGS)

    def get(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.settings)

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        allowed = {"title", "tagline", "deviceName", "locationCaption", "avatarDataUrl", "accent"}
        with self.lock:
            for key, value in changes.items():
                if key in allowed:
                    self.settings[key] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.settings, ensure_ascii=False, indent=2), encoding="utf-8")
            return dict(self.settings)


class ActivityLog:
    def __init__(self) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=120)
        self._lock = threading.Lock()

    def add(self, level: str, message: str, details: Any | None = None) -> None:
        entry: dict[str, Any] = {"time": utc_now(), "level": level, "message": message}
        if details is not None:
            entry["details"] = json_safe(details)
        with self._lock:
            self._entries.appendleft(entry)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._entries)


class HistoryStore:
    """Small durable history for the last location reports."""

    def __init__(self, path: Path, max_entries: int = 200):
        self.path = path
        self.max_entries = max_entries
        self.lock = threading.RLock()
        self.records: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        with self.lock:
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else []
                if isinstance(raw, list):
                    self.records = [item for item in raw if isinstance(item, dict)][: self.max_entries]
            except (OSError, json.JSONDecodeError):
                self.records = []

    def add(self, device: dict[str, Any], location: dict[str, Any], located_at: str) -> dict[str, Any]:
        record = {
            "id": uuid.uuid4().hex,
            "trackerId": device["id"],
            "name": device.get("name", "奶蛙"),
            "model": device.get("model", "奶蛙"),
            "locatedAt": located_at,
            "location": json_safe(location),
        }
        with self.lock:
            self.records.insert(0, record)
            self.records = self.records[: self.max_entries]
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.records, ensure_ascii=False, indent=2), encoding="utf-8")
        return record

    def list(self, limit: int | None = None) -> list[dict[str, Any]]:
        with self.lock:
            records = self.records if limit is None else self.records[: max(0, limit)]
            return [json_safe(item) for item in records]

    def latest_for(self, tracker_id: str) -> dict[str, Any] | None:
        with self.lock:
            for record in self.records:
                if record.get("trackerId") == tracker_id:
                    return json_safe(record)
        return None


class ProviderError(RuntimeError):
    pass


class FindHubProvider:
    """Adapter for the experimental GoogleFindMyTools repository.

    The upstream project is intentionally imported lazily.  This keeps the
    demo experience usable with only the Python standard library installed and
    lets the app report missing optional dependencies in the admin channel.
    """

    def __init__(self, settings: SettingsStore, activity: ActivityLog, history: HistoryStore):
        self.settings = settings
        self.activity = activity
        self.history = history
        self.lock = threading.RLock()
        self.devices: dict[str, dict[str, Any]] = {}
        self.last_sync: str | None = None
        self.last_error: str | None = None
        self.source = "demo"
        self._upstream: dict[str, Any] | None = None
        self.refresh()

    def _load_upstream(self) -> dict[str, Any]:
        if self._upstream is not None:
            return self._upstream
        if not VENDOR_DIR.exists():
            raise ProviderError(f"找不到 GoogleFindMyTools：{VENDOR_DIR}")
        vendor_string = str(VENDOR_DIR)
        if vendor_string not in sys.path:
            sys.path.insert(0, vendor_string)
        try:
            from Auth.fcm_receiver import FcmReceiver
            from FMDNCrypto.foreign_tracker_cryptor import decrypt
            from KeyBackup.cloud_key_decryptor import decrypt_aes_gcm
            from NovaApi.ExecuteAction.LocateTracker.decrypt_locations import (
                is_mcu_tracker,
                retrieve_identity_key,
            )
            from NovaApi.ExecuteAction.LocateTracker.location_request import create_location_request
            from NovaApi.ExecuteAction.nbe_execute_action import serialize_action_request
            from NovaApi.ListDevices.nbe_list_devices import request_device_list
            from NovaApi.nova_request import nova_request
            from NovaApi.scopes import NOVA_ACTION_API_SCOPE
            from NovaApi.util import generate_random_uuid
            from ProtoDecoders import Common_pb2, DeviceUpdate_pb2
            from ProtoDecoders.decoder import parse_device_list_protobuf, parse_device_update_protobuf
        except Exception as exc:  # ImportError plus dependency/runtime errors.
            raise ProviderError(f"GoogleFindMyTools 載入失敗：{exc}") from exc
        self._upstream = {
            "FcmReceiver": FcmReceiver,
            "decrypt": decrypt,
            "decrypt_aes_gcm": decrypt_aes_gcm,
            "is_mcu_tracker": is_mcu_tracker,
            "retrieve_identity_key": retrieve_identity_key,
            "create_location_request": create_location_request,
            "serialize_action_request": serialize_action_request,
            "request_device_list": request_device_list,
            "nova_request": nova_request,
            "NOVA_ACTION_API_SCOPE": NOVA_ACTION_API_SCOPE,
            "generate_random_uuid": generate_random_uuid,
            "Common_pb2": Common_pb2,
            "DeviceUpdate_pb2": DeviceUpdate_pb2,
            "parse_device_list_protobuf": parse_device_list_protobuf,
            "parse_device_update_protobuf": parse_device_update_protobuf,
        }
        return self._upstream

    @staticmethod
    def _auth_file_exists() -> bool:
        secrets = VENDOR_DIR / "Auth" / "secrets.json"
        return secrets.exists() and secrets.stat().st_size > 2

    def _should_use_live(self) -> bool:
        if FINDHUB_MODE == "demo":
            return False
        if FINDHUB_MODE == "live":
            return True
        return self._auth_file_exists()

    def _demo_device(self) -> dict[str, Any]:
        now = time.time() - 8 * 60
        custom_name = self.settings.get().get("deviceName") or DEFAULT_SETTINGS["deviceName"]
        caption = self.settings.get().get("locationCaption") or DEFAULT_SETTINGS["locationCaption"]
        return {
            "id": "naiwa",
            "canonicId": "naiwa",
            "name": custom_name,
            "model": "奶蛙",
            "status": "online",
            "source": "demo",
            "location": {
                "latitude": 25.03395,
                "longitude": 121.56447,
                "accuracy": 32,
                "label": f"台北信義區 · {caption}",
                "timestamp": datetime.fromtimestamp(now, timezone.utc).isoformat(),
                "isOwnReport": True,
                "mapsUrl": "https://www.google.com/maps/search/?api=1&query=25.03395,121.56447",
            },
        }

    def _live_devices(self) -> dict[str, dict[str, Any]]:
        api = self._load_upstream()
        result_hex = api["request_device_list"]()
        if not result_hex:
            raise ProviderError("Find Hub 沒有回傳裝置清單")
        device_list = api["parse_device_list_protobuf"](result_hex)
        # GoogleFindMyTools returns Android phones alongside Spot trackers.
        # The product follows the user's tracker, so deliberately ignore
        # phone canonic IDs and keep one Spot target in the main experience.
        spot_type = api["DeviceUpdate_pb2"].IDENTIFIER_SPOT
        spot_devices: list[dict[str, Any]] = []
        for device in device_list.deviceMetadata:
            if device.identifierInformation.type != spot_type:
                continue
            canonic_ids = device.identifierInformation.canonicIds.canonicId
            if not canonic_ids:
                continue
            label = device.userDefinedDeviceName or "我的奶蛙"
            spot_devices.append(
                {
                    "id": "naiwa",
                    "canonicId": canonic_ids[0].id,
                    "name": label,
                    "model": "奶蛙",
                    "status": "ready",
                    "source": "findhub",
                    "location": None,
                }
            )
        if not spot_devices:
            raise ProviderError("Find Hub 帳號中找不到可用的奶蛙追蹤器")
        return {spot_devices[0]["id"]: spot_devices[0]}

    def refresh(self) -> dict[str, Any]:
        with self.lock:
            self.last_error = None
            try:
                if self._should_use_live():
                    self.devices = self._live_devices()
                    self.source = "findhub"
                    self.activity.add("success", f"已載入 {len(self.devices)} 個 Find Hub 裝置")
                else:
                    demo = self._demo_device()
                    self.devices = {demo["id"]: demo}
                    self.source = "demo"
                    self.activity.add("info", "使用示範資料；可在管理員診斷通道切換 Find Hub")
            except Exception as exc:
                self.last_error = str(exc)
                self.source = "demo-fallback"
                demo = self._demo_device()
                self.devices = {demo["id"]: demo}
                self.activity.add("error", "Find Hub 連線失敗，暫時使用示範資料", str(exc))
            for device in self.devices.values():
                if device.get("location") is None:
                    recent = self.history.latest_for(device["id"])
                    if recent and recent.get("location"):
                        device["location"] = recent["location"]
                        device["lastLocatedAt"] = recent.get("locatedAt")
                        device["status"] = "online"
            self.last_sync = utc_now()
            return self.snapshot()

    def _extract_locations(self, device_update: Any, api: dict[str, Any]) -> list[dict[str, Any]]:
        registration = device_update.deviceMetadata.information.deviceRegistration
        identity_key = api["retrieve_identity_key"](registration)
        locations_proto = (
            device_update.deviceMetadata.information.locationInformation.reports.recentLocationAndNetworkLocations
        )
        is_mcu = api["is_mcu_tracker"](registration)
        reports: list[tuple[Any, Any]] = []
        if locations_proto.HasField("recentLocation"):
            reports.append((locations_proto.recentLocation, locations_proto.recentLocationTimestamp))
        reports.extend(zip(locations_proto.networkLocations, locations_proto.networkLocationTimestamps))

        locations: list[dict[str, Any]] = []
        for location, timestamp in reports:
            stamp = int(timestamp.seconds)
            if location.status == api["Common_pb2"].Status.SEMANTIC:
                locations.append(
                    {
                        "latitude": None,
                        "longitude": None,
                        "accuracy": None,
                        "label": location.semanticLocation.locationName,
                        "timestamp": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                        "isOwnReport": True,
                        "mapsUrl": None,
                    }
                )
                continue

            encrypted = location.geoLocation.encryptedReport.encryptedLocation
            public_key_random = location.geoLocation.encryptedReport.publicKeyRandom
            if public_key_random == b"":
                decrypted = api["decrypt_aes_gcm"](hashlib.sha256(identity_key).digest(), encrypted)
            else:
                offset = 0 if is_mcu else location.geoLocation.deviceTimeOffset
                decrypted = api["decrypt"](identity_key, encrypted, public_key_random, offset)
            decoded = api["DeviceUpdate_pb2"].Location()
            decoded.ParseFromString(decrypted)
            latitude = decoded.latitude / 1e7
            longitude = decoded.longitude / 1e7
            locations.append(
                {
                    "latitude": latitude,
                    "longitude": longitude,
                    "accuracy": location.geoLocation.accuracy,
                    "label": None,
                    "timestamp": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                    "isOwnReport": bool(location.geoLocation.encryptedReport.isOwnReport),
                    "mapsUrl": f"https://www.google.com/maps/search/?api=1&query={latitude},{longitude}",
                }
            )
        return sorted(locations, key=lambda item: item["timestamp"], reverse=True)

    def _live_location(self, device: dict[str, Any]) -> dict[str, Any]:
        api = self._load_upstream()
        request_uuid = api["generate_random_uuid"]()
        event = threading.Event()
        result: dict[str, Any] = {}
        receiver = api["FcmReceiver"]()

        def handle_location_response(response: str) -> None:
            try:
                parsed = api["parse_device_update_protobuf"](response)
                if parsed.fcmMetadata.requestUuid != request_uuid:
                    return
                locations = self._extract_locations(parsed, api)
                if locations:
                    result["location"] = locations[0]
                else:
                    result["error"] = "Find Hub 回傳成功，但沒有可用位置"
            except Exception as exc:  # Keep callback errors visible to the request thread.
                result["error"] = str(exc)
            finally:
                event.set()

        try:
            token = receiver.register_for_location_updates(handle_location_response)
            payload = api["create_location_request"](device["canonicId"], token, request_uuid)
            api["nova_request"](api["NOVA_ACTION_API_SCOPE"], payload)
            if not event.wait(timeout=float(os.getenv("FINDHUB_LOCATION_TIMEOUT", "35"))):
                raise ProviderError("等待 Find Hub 位置回報逾時")
            if result.get("error"):
                raise ProviderError(result["error"])
            if not result.get("location"):
                raise ProviderError("Find Hub 沒有回傳位置")
            return result["location"]
        finally:
            # FcmReceiver is a process-wide singleton in the upstream project;
            # remove this request's callback so later locations do not wake an
            # already-finished HTTP request.
            try:
                receiver.location_update_callbacks.remove(handle_location_response)
            except (ValueError, AttributeError):
                pass

    def locate(self, tracker_id: str) -> dict[str, Any]:
        with self.lock:
            device = self.devices.get(tracker_id)
            if not device:
                raise ProviderError("找不到這個追蹤器")
            if self.source.startswith("demo"):
                location = self._demo_device()["location"]
            else:
                location = self._live_location(device)
            device["location"] = location
            device["status"] = "online"
            device["lastLocatedAt"] = utc_now()
            self.history.add(device, location, device["lastLocatedAt"])
            self.activity.add("success", f"已更新 {device['name']} 的位置")
            return dict(device)

    @staticmethod
    def _device_payload(device: dict[str, Any], include_private: bool = False) -> dict[str, Any]:
        payload = json_safe(device)
        if not include_private:
            payload.pop("canonicId", None)
            payload.pop("source", None)
            payload["name"] = "奶蛙"
            payload["model"] = "奶蛙"
        return payload

    def snapshot(self, include_private: bool = False) -> dict[str, Any]:
        with self.lock:
            source = self.source if include_private else ("online" if self.source == "findhub" else self.source)
            return {
                "source": source,
                "lastSync": self.last_sync,
                "lastError": self.last_error,
                "devices": [self._device_payload(item, include_private) for item in self.devices.values()],
            }


class AppState:
    def __init__(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.settings = SettingsStore(SETTINGS_FILE)
        self.activity = ActivityLog()
        self.history = HistoryStore(HISTORY_FILE)
        self.provider = FindHubProvider(self.settings, self.activity, self.history)

    def bootstrap(self) -> dict[str, Any]:
        snapshot = self.provider.snapshot()
        return {"settings": self.public_settings(), "history": self.public_history(20), **snapshot, "serverTime": utc_now()}

    def public_settings(self) -> dict[str, Any]:
        settings = self.settings.get()
        settings["deviceName"] = "奶蛙"
        return settings

    def public_history(self, limit: int | None = None) -> list[dict[str, Any]]:
        records = self.history.list(limit)
        for record in records:
            record.pop("trackerId", None)
            record.pop("model", None)
            record["name"] = "奶蛙"
        return records


APP = AppState()


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    try:
        transfer_encoding = handler.headers.get("Transfer-Encoding", "").lower()
        if "chunked" in transfer_encoding:
            chunks: list[bytes] = []
            total = 0
            while True:
                line = handler.rfile.readline(128).strip()
                if not line:
                    continue
                size = int(line.split(b";", 1)[0], 16)
                if size == 0:
                    # Consume the trailer terminator.  We do not need trailer
                    # headers for any API endpoint.
                    handler.rfile.readline()
                    break
                total += size
                if total > 5_000_000:
                    raise ValueError("request too large")
                chunks.append(handler.rfile.read(size))
                handler.rfile.read(2)  # CRLF after each chunk.
            raw = b"".join(chunks) or b"{}"
        else:
            size = int(handler.headers.get("Content-Length", "0"))
            if size > 5_000_000:
                raise ValueError("request too large")
            raw = handler.rfile.read(size) if size else b"{}"
        decoded = json.loads(raw.decode("utf-8"))
        if not isinstance(decoded, dict):
            raise ValueError("JSON object required")
        return decoded
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"無法讀取 JSON：{exc}") from exc


def validate_settings(changes: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("title", "tagline", "deviceName", "locationCaption"):
        if key in changes:
            value = str(changes[key]).strip()
            if len(value) > 120:
                raise ValueError(f"{key} 太長（最多 120 字）")
            result[key] = value
    if "accent" in changes:
        value = str(changes["accent"])
        # "lime" was the original label; accept it once so existing local
        # settings continue to load after the yellow theme update.
        if value == "lime":
            value = "yellow"
        if value not in {"yellow", "violet", "coral"}:
            raise ValueError("accent 不在可用的主題色中")
        result["accent"] = value
    if "avatarDataUrl" in changes:
        value = str(changes["avatarDataUrl"])
        if value and not re.match(r"^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$", value):
            raise ValueError("圖片格式不支援，請選擇 PNG、JPG、WEBP 或 GIF")
        if len(value) > 3_000_000:
            raise ValueError("圖片太大，請選擇 2 MB 以內的圖片")
        result["avatarDataUrl"] = value
    return result


class NaiwaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "NaiwaTracker/1.0"

    def log_message(self, format: str, *args: Any) -> None:  # Keep terminal output useful and concise.
        APP.activity.add("http", format % args)

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _send_error_json(self, message: str, status: int = HTTPStatus.BAD_REQUEST) -> None:
        self._send_json({"error": message}, status)

    def _admin_ok(self) -> bool:
        return self.headers.get("X-Admin-Key", "") == ADMIN_KEY

    def _serve_file(self, path: Path) -> None:
        try:
            resolved = path.resolve()
            public_root = PUBLIC_DIR.resolve()
            if public_root not in resolved.parents and resolved != public_root:
                raise FileNotFoundError
            raw = resolved.read_bytes()
        except (OSError, FileNotFoundError):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path == "/api/bootstrap":
            self._send_json(APP.bootstrap())
        elif path == "/api/health":
            snapshot = APP.provider.snapshot()
            self._send_json(
                {
                    "ok": True,
                    "source": snapshot["source"],
                    "lastSync": snapshot["lastSync"],
                    "lastError": snapshot["lastError"],
                    "vendorPath": str(VENDOR_DIR),
                    "vendorPresent": VENDOR_DIR.exists(),
                    "mode": FINDHUB_MODE,
                }
            )
        elif path == "/admin/api/diagnostics":
            if not self._admin_ok():
                self._send_error_json("需要管理員金鑰", HTTPStatus.UNAUTHORIZED)
                return
            snapshot = APP.provider.snapshot(include_private=True)
            self._send_json(
                {
                    "health": {
                        "source": snapshot["source"],
                        "lastSync": snapshot["lastSync"],
                        "lastError": snapshot["lastError"],
                        "mode": FINDHUB_MODE,
                        "vendorPath": str(VENDOR_DIR),
                        "vendorPresent": VENDOR_DIR.exists(),
                        "authFilePresent": FindHubProvider._auth_file_exists(),
                    },
                    "settings": APP.settings.get(),
                    "history": APP.history.list(),
                    "logs": APP.activity.list(),
                    "devices": snapshot["devices"],
                }
            )
        elif path in {"/", "/index.html"}:
            self._serve_file(PUBLIC_DIR / "index.html")
        elif path in {"/admin", "/admin/", "/admin.html"}:
            self._serve_file(PUBLIC_DIR / "admin.html")
        elif path.startswith("/") and not path.startswith("/api/"):
            self._serve_file(PUBLIC_DIR / path.lstrip("/"))
        else:
            self._send_error_json("找不到路由", HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        try:
            # Consume request bodies even for endpoints whose payload is empty.
            # This keeps HTTP/1.1 keep-alive connections aligned for the next
            # request (notably when the browser follows a POST with a GET).
            request_body = read_json(self)
            if path == "/api/settings":
                if not self._admin_ok():
                    self._send_error_json("需要管理員金鑰", HTTPStatus.UNAUTHORIZED)
                    return
                body = validate_settings(request_body)
                updated = APP.settings.update(body)
                # A custom device name/location caption should be reflected in
                # the demo card immediately without forcing a network call.
                if APP.provider.source.startswith("demo"):
                    APP.provider.refresh()
                self._send_json({"settings": updated, **APP.provider.snapshot()})
            elif path == "/api/sync":
                self._send_json(APP.provider.refresh())
            elif path.startswith("/api/trackers/") and path.endswith("/locate"):
                tracker_id = path[len("/api/trackers/") : -len("/locate")].strip("/")
                if not tracker_id:
                    raise ValueError("缺少追蹤器 ID")
                updated = APP.provider.locate(tracker_id)
                self._send_json({"device": APP.provider._device_payload(updated), "history": APP.public_history(20)})
            elif path == "/admin/api/refresh":
                if not self._admin_ok():
                    self._send_error_json("需要管理員金鑰", HTTPStatus.UNAUTHORIZED)
                    return
                self._send_json(APP.provider.refresh())
            else:
                self._send_error_json("找不到路由", HTTPStatus.NOT_FOUND)
        except ProviderError as exc:
            APP.activity.add("error", str(exc))
            self._send_error_json(str(exc), HTTPStatus.BAD_GATEWAY)
        except (ValueError, OSError) as exc:
            APP.activity.add("error", str(exc))
            self._send_error_json(str(exc), HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # Keep the public API response safe; details go to admin logs.
            APP.activity.add("error", "伺服器處理失敗", traceback.format_exc())
            self._send_error_json(f"伺服器處理失敗：{exc}", HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), NaiwaHandler)
    print(f"奶蛙在哪裡已啟動：http://{HOST}:{PORT}")
    print(f"資料來源：{APP.provider.source}（FINDHUB_MODE={FINDHUB_MODE}）")
    print("管理員診斷：http://%s:%s/admin.html" % (HOST, PORT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止奶蛙在哪裡")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
