# TypeWriter 顯示 + Turn Buffer 斷線重連設計

**日期：** 2026-06-26  
**問題：** 前端文字顯示直接綁定 LLM t/s 速度，體驗生硬；頁面重整或切換 tab 時 SSE 斷線，正在進行中的回合遺失。

---

## 目標

1. 文字以固定速度「打出來」，閱讀節奏不受 LLM 吐字速度影響。
2. 頁面重整或切換 tab 後，若回合仍在進行中，可從斷點重連繼續顯示；若已完成，還原最後一回合內容。

---

## 整體架構

```
LLM delta
   ↓
後端 TurnBuffer (in-memory)
   ├── narrative: string  ← 累積所有 delta 文字
   ├── events: TurnEvent[]  ← 完整事件序列
   └── active: boolean
   ↓                              ↓
POST /api/turn (初次連線)    GET /api/turn/stream?offset=N (重連)
   ↓                              ↓
前端 pendingQueue (ref) ← 收到 delta，逐字推入 queue
   ↓
TypeWriter interval（25ms）
   ↓
story state（畫面顯示）
```

---

## Section 1：後端 TurnBuffer

### 資料結構

```typescript
interface TurnBuffer {
  turnId: string;
  narrative: string;      // 累積所有 delta（供 /stream offset 重播用）
  events: TurnEvent[];    // 完整事件序列（含 warning/transition/done）
  active: boolean;
}

let currentTurn: TurnBuffer | null = null;
```

### 生命週期

- `POST /api/turn` 進來時：清掉上一回合 buffer，建立新 buffer（`active: true`）。
- 每次 `delta` event：`narrative += text`，`events.push(ev)`。
- 其他 event（`warning`/`transition`/`done`）：`events.push(ev)`。
- `done` event 後：`active = false`（buffer 保留，直到下一回合才清）。

保留已完成回合的 buffer，讓重整後仍可從 buffer 重播完整事件序列（含 suggestedActions）。

### 新增端點

**`GET /api/turn/status`**
```json
{ "active": boolean, "turnId": string | null }
```

**`GET /api/turn/stream?offset=N`**
- SSE，重播 `events[N..]`，若 `active=true` 繼續串流新事件。
- 若 `active=false` 且 `offset >= events.length` → `204 No Content`（不需重連）。
- 若 `offset > events.length`（buffer 已清，如伺服器重啟）→ `410 Gone`。

---

## Section 2：TypeWriter 邏輯（含 lookahead pause）

### 常數

```typescript
const TYPEWRITER_INTERVAL_MS = 25;  // 約 40 chars/sec
const LOOKAHEAD_MIN = 20;           // queue 低於此值且 LLM 仍在跑時暫停
```

### 前端 ref（不是 state）

```typescript
const pendingQueue = useRef<string[]>([]);
const llmDone = useRef(false);
const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
```

用 ref 而非 state：interval callback 需要讀最新值，且推字本身不應觸發 re-render，只有 `setStory` 的 append 才觸發。

### TypeWriter interval 邏輯

```
每 25ms：
  if queue.length < LOOKAHEAD_MIN && !llmDone:
    → 暫停（不輸出）；cursor blinking 繼續顯示
  else if queue.length > 0:
    → 取一個字，setStory(s => s + char)
  else if llmDone:
    → 清除 interval，隱藏 cursor
```

### 錯誤情況

收到 `error` event 或 fetch throw 時：
- 立即清除 interval
- 清空 `pendingQueue`
- 直接 `setStory(s => s + errorMessage)`（不走 queue，確保即時可見）

---

## Section 3：前端重連邏輯

### sessionStorage 記錄

```typescript
// 每收到一個 event，更新 offset
sessionStorage.setItem("turnId", currentTurn.turnId);
sessionStorage.setItem("receivedOffset", String(events.length));
```

### 頁面 load / visibilitychange 時

```
1. GET /api/turn/status
2. if active=true:
     讀 sessionStorage turnId + receivedOffset
     if turnId 吻合 → GET /api/turn/stream?offset=receivedOffset 重接
     if turnId 不吻合 → offset 作廢，從 offset=0 重播（或視為全新回合）
3. if active=false:
     fetchState() 還原最後已落地回合（現有行為）
```

### 降級情況

- `410 Gone`（伺服器重啟，buffer 消失）：退回 `fetchState()`，還原已落地的最後回合，顯示「連線已中斷，已還原最後進度」。
- 回合正在跑時伺服器重啟：回合無法繼續，顯示「連線中斷，請重新輸入行動」。

---

## Section 4：錯誤處理與邊界

| 情況 | 處理 |
|------|------|
| offset > buffer 長度（伺服器重啟） | 410 → fetchState() 降級 |
| visibilitychange 時回合已完成 | fetchState() 現有路徑 |
| 新回合開始時舊 buffer 清掉 | 正常清理 |
| LLM 速度 < LOOKAHEAD_MIN | TypeWriter 暫停，cursor 繼續 blink |
| LLM done 後 queue 仍有字 | 移除 lookahead 限制，直到 queue 清空 |

---

## Section 5：測試策略

### 後端 unit tests（Vitest + server.inject()）

- `TurnBuffer` 累積 / replay 邏輯
- `/api/turn/status` 端點
- `/api/turn/stream?offset=N` 端點：正常重播、offset 越界 410、active=false 204

### 前端 unit tests（Vitest）

- TypeWriter queue：`queue.length < LOOKAHEAD_MIN && !llmDone` → 不輸出
- `llmDone=true` 後 queue 排空行為
- 錯誤時 interval 立即清除

### 整合測試

- 模擬斷線後重連，確認事件從正確 offset 重播
- 模擬慢速 LLM（每 500ms 一字），確認 typewriter 暫停而非 stutter

### 手動驗證（瀏覽器）

- TypeWriter 動畫視覺效果
- 頁面重整後重連動畫的連貫感

---

## 不在範圍內

- WebSocket 改寫（傳輸層維持 SSE + fetch）
- 多使用者並行（單一主角世界，單一 TurnBuffer 即可）
- TypeWriter 速度設定介面
