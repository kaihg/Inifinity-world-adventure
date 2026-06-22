# 前端專注當前回合：清除舊劇情與停止逐 token 跳動

日期：2026-06-22
範圍：`app/web/`（前端，純 UI 互動行為）

## 問題

前端劇情區（NARRATIVE LOG）目前有兩個影響閱讀體驗的問題：

1. **舊劇情不清除**：`App.tsx` 的 `delta` 事件處理把每個新回合的文字 append 到同一個 `story` state（`s + "\n\n" + ev.text`），從不清空。多回合累積後畫面變得冗長。但因為重整頁面（`refresh()`／visibility 喚醒）只會載入「最近一回合」的 narrative，更早的劇情其實也不會被保留，append 的累積只在單次 session 中存在，意義不大。

2. **瀏覽器逐 token 向下跳動**：`useEffect(() => storyEndRef.current?.scrollIntoView({ behavior: "smooth" }), [story])` 在每個 streaming token 變動 `story` 時都觸發 smooth scroll 到底部，造成 streaming 期間畫面不停往下跳，無法穩定閱讀。

## 目標

讓劇情區**專注於當前回合**：新回合開始即清空舊內容，streaming 期間畫面穩定不自動跳動。歷史劇情的載入留待未來獨立功能，本次不實作。

## 設計（方案 A）

集中在 `app/web/src/App.tsx`，搭配少量 `styles.css` 調整（若需要）。

### 改動 1：新回合清空舊劇情

- 在 `send()` 開頭（`setBusy(true)` 附近）執行 `setStory("")`，立即清空畫面。
- `delta` 事件處理移除 `firstToken` 前綴 `"\n\n"` 的邏輯，改為直接累加：`setStory((s) => s + ev.text)`。因為已清空，不再需要與舊內容分隔。
- `auto-advance`／`transition`／`warning`／`error` 的分隔標記**維持不變**：這些是「同一回合內」多段推進（自動推進、進出副本、提示）的分隔，仍需保留。
- 清空後到第一個 token 抵達前的空白期，由既有的 `computing-hint`（story card 下方的「主控系統正在運算中…」）覆蓋，不顯突兀。

### 改動 2：停止逐 token 跳動

- 移除 `App.tsx` 中以 `[story]` 為依賴、每 token 觸發 `scrollIntoView` 的 `useEffect`。
- 改為在 `send()` 清空 story 之後做**一次性**捲動，把故事卡片捲到可視區頂端（`scrollIntoView` 或 `window.scrollTo`），讓新回合從頂端開始閱讀。
- streaming 期間**完全不再自動捲動**，使用者可自由閱讀，不被打斷。

### 改動 3：背景喚醒／初始載入相容性（不需改動，僅確認）

- 初始 `refresh()` 與 visibility 喚醒：設定的是「上一回合完整 narrative」（整段覆寫），與「專注單回合」一致，邏輯不變。
- 癒合輪詢（`catch` 區塊）成功時 `setStory(freshState.lastTurn.narrative)` 也是整段覆寫，一致，不需改。

## 不做（YAGNI）

- **歷史劇情載入功能**：列為未來獨立工項，本次不碰。設計上保留日後在劇情區加「載入更早劇情」入口的空間。

## 測試

- 前端目前無測試檔，本次改動為純 UI 互動行為。
- **手動驗證**：
  1. 送出一個行動，等 streaming 完成；再送出第二個行動 → 確認第二回合開始時舊劇情立即消失，只顯示新回合。
  2. streaming 進行中 → 確認畫面不再逐 token 向下跳動。
  3. 觸發自動推進／進出副本 → 確認同一回合內的分隔標記（「系統自動推進」「進入副本」等）仍正常顯示。
  4. 重整頁面／切換背景再回來 → 確認顯示最近一回合 narrative，行為不變。
- 引入 React 自動化測試環境超出本次範圍；如未來建立測試基建，可補上上述情境的元件測試。

## 影響檔案

- `app/web/src/App.tsx`（主要）
- `app/web/src/styles.css`（如捲動或空白期樣式需微調）
