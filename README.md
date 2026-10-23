# 奶蛙在哪裡

一個以一般使用者體驗為中心的 Find Hub Xiaomi Tag 追蹤器。前端以「奶蛙在哪裡」的可愛視覺呈現位置、最後回報時間與精準度；管理員診斷則獨立在 `/admin.html`，只有輸入管理員金鑰後才能查看連線狀態、活動紀錄與裝置摘要。

後端透過 `vendor/GoogleFindMyTools` 呼叫 Find Hub 的裝置清單、FCM 位置回報與 E2EE 解密流程。瀏覽器只拿到繪圖所需的欄位，Google token 與加密回應留在伺服器端。

## 啟動

需求：Python 3.10+。核心介面只使用標準函式庫，首次試用不必安裝額外套件。

```powershell
python app.py
```

開啟 <http://127.0.0.1:8765/>。預設會使用示範位置，方便先檢查 UI。若要真的連線到帳號中的 Xiaomi Tag：

1. 在專案根目錄安裝依賴：`python -m pip install -r requirements.txt`。
2. 依照上游專案的說明首次執行認證流程，讓 `vendor/GoogleFindMyTools/Auth/secrets.json` 產生。
3. 以 `FINDHUB_MODE=live` 啟動：`$env:FINDHUB_MODE='live'; python app.py`。

上游專案的認證需要 Chrome 與使用者互動；本程式不會把帳號密碼寫入自己的資料夾。需要較長的位置等待時間時，可用 `FINDHUB_LOCATION_TIMEOUT=60` 調整秒數。

## 管理員診斷

管理員頁面：<http://127.0.0.1:8765/admin.html>。預設本機金鑰是 `local-admin`；正式使用請先設定環境變數：

```powershell
$env:NAIWA_ADMIN_KEY='請換成自己的長金鑰'
python app.py
```

管理員通道可執行重新檢查，並能看到上游套件是否存在、認證檔案是否已設定及最近錯誤。一般首頁只顯示友善的狀態訊息。

## 自訂

首頁左下的「自訂奶蛙」可以設定：

- 奶蛙圖片（PNG、JPG、WEBP 或 GIF，2 MB 內）
- 追蹤器暱稱與秘密基地名稱
- 首頁標題與小句子
- 青檸、葡萄、珊瑚三種主題色

設定寫入 `data/settings.json`，該檔案已加入 `.gitignore`。

## 上游專案

本專案使用 [leonboe1/GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools)（目前鎖定 commit `d46e9528578015b51d3b84dd91bf8f16e9ab850f`）。上游 README 已說明其實驗性質、Chrome 認證流程與 Find Hub 加密資料的限制，請在正式使用前閱讀。
