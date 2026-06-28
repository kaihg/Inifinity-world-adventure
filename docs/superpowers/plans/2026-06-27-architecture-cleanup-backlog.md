# 架構清理 Backlog（2026-06-27）

源自對整體架構與前後端串接的 first-principles 分析。  
六個獨立任務，可任意順序處理，互不依賴（除非備注說明）。

---

## 任務總覽

| # | 任務 | 影響範圍 | 優先 | 狀態 |
|---|------|---------|------|------|
| 1 | `.pending-opening` sentinel 取代字串偵測 | 後端 | 中 | 待處理 |
| 2 | Recall 向量索引改為預設啟用 | 後端 config | 高 | 待處理 |
| 3 | 拆分 `server/app.ts` | 後端 | 低（加功能前再做） | ✅ 完成 |
| 4 | 提取共用 `handleTurnEvent()` | 前端 | 高 | ✅ 完成 |
| 5 | 提取 `useTypewriter()` hook | 前端 | 中 | ✅ 完成 |
| 6 | 提取 `pollUntilProgressed()` utility | 前端 | 低 | 待處理 |

---

## 任務 1 — `.pending-opening` sentinel 取代字串魔術偵測

### 問題

`app/src/engine/turn/index.ts:92`：

```typescript
const isOpeningTurn = state.now.lastUpdated.includes("進入主神空間");
```

依賴 `initWorld` 寫入 `now.md` 的初始字串值。兩個靜默失效場景：
1. `templates/initial-now.md` 模板被修改，初始字串改變
2. LLM 第一回合就成功覆寫 `now.lastUpdated`（Layer 2 正常執行），偵測消失

### 解法

與現有 `.pending-death` 同模式：

1. `engine/world-ops.ts` 的 `initWorld()` 寫完所有初始檔案後，額外寫 `world/.pending-opening`（內容：ISO timestamp）
2. `engine/turn/index.ts` 的 `runMainSpaceTurn()` 改成讀取 `.pending-opening` 是否存在來判斷 `isOpeningTurn`
3. 開場回合落地完成後（`runTurnCore` 回傳、commit 完成後），刪除 `.pending-opening`

### 刪除時機

在 `runMainSpaceTurn()` 的 `yield* runTurnCore(...)` 之後，`scheduleLoreSync` 之前，`await unlink(pendingOpeningPath).catch(() => {})` — 失敗靜默忽略（檔案可能已不存在）。

### 測試

`world-ops.test.ts`：驗證 `initWorld` 後 `.pending-opening` 存在。  
`turn/index.test.ts`：驗證開場回合後 `.pending-opening` 被刪除，第二回合不再觸發 opening prompt。

---

## 任務 2 — Recall 向量索引改為預設啟用

### 問題

`RECALL_ENABLED=true` 才啟動向量索引，目前 `.env.example` 中此行被注解或標為「選填」。  
遊戲超過 50 回合後，LLM context 放不下早期事件，敘事一致性無聲退化（NPC 行為、已揭露的副本機關被遺忘）。

### 解法

**`app/src/config.ts`**：
```typescript
// 改為：缺省 true，明確 "false" 才關閉
recallEnabled: process.env.RECALL_ENABLED !== "false",
```

**`app/.env.example`**：
```dotenv
# 語意回憶索引（建議開啟；長期遊戲若關閉，LLM 將遺忘早期事件）
# RECALL_ENABLED=false
```

### 注意

首次開啟後需執行 `npm run recall:reindex` 建立索引（或引擎自動觸發）。  
確認 `README` / `.env.example` 有說明索引路徑 `.recall-index/` 不進 git。

---

## 任務 3 — 拆分 `server/app.ts`（目前 612 行）

### 問題

`app/src/server/app.ts` 612 行，同時處理：
- Fastify 初始化與插件掛載
- LLM client 建立（5 個 client 變體）
- `/api/turn`、`/api/turn/status`、`/api/turn/stream` 路由（SSE 管理）
- `/api/world/init|end|protagonist|status` 路由
- 副本狀態轉場邏輯
- 死亡 sentinel 管理

### 解法（建議拆法）

```
app/src/server/
  app.ts              # 只剩 buildServer()：建 Fastify、掛插件、register 路由、decorate
  routes/
    turn.ts           # /api/turn、/api/turn/status、/api/turn/stream
    world.ts          # /api/world/init|end|protagonist|status
    state.ts          # /api/state、/api/version、/api/config
```

`TurnDeps` 和 `ServerDeps` 保持原型別，路由檔接受 deps 作為參數（方便測試注入 fake）。

### 時機

**優先度低**：目前 612 行尚在上限（800）以內，只在加入下一個較大功能前處理。

---

## 任務 4 — 提取共用 `handleTurnEvent()` 消除三份重複 SSE switch

### 問題

`app/web/src/App.tsx` 中三個函式各有幾乎相同的 `switch(ev.type)` 處理（共約 90 行）：

| 函式 | 行數 | 差異 |
|------|------|------|
| `send()` | ~35 行 | `stopTypewriter` 在 catch 清 queue |
| `sendOpening()` | ~30 行 | 無 self-healing polling |
| `reconnectIfNeeded()` | ~25 行 | `stopTypewriter(true)` 在前 |

三份 switch 的 `delta`/`transition`/`warning`/`error`/`done` 分支邏輯完全相同。

### 解法

```typescript
// App.tsx 內部
function makeTurnEventHandler(deps: {
  enqueue: (char: string) => void;
  startTypewriter: () => void;
  stopTypewriter: (clearQueue?: boolean) => void;
  setStory: React.Dispatch<React.SetStateAction<string>>;
  setSuggested: React.Dispatch<React.SetStateAction<string[]>>;
  setState: React.Dispatch<React.SetStateAction<GameState | null>>;
  setProtagonistDied: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (ev: TurnEvent) => {
    switch (ev.type) {
      case "delta": ...
      case "transition": ...
      case "warning": ...
      case "error": ...
      case "done": ...
    }
  };
}
```

`send()`、`sendOpening()`、`reconnectIfNeeded()` 各自呼叫 `makeTurnEventHandler(deps)` 得到 callback，差異部分（如 error 後要不要 polling）留在各函式自己的 catch/finally。

**預期效果**：App.tsx 從 633 行壓到 ~480 行。

---

## 任務 5 — 提取 `useTypewriter()` custom hook

### 問題

App.tsx 內的 typewriter 相關狀態與邏輯（約 50 行）直接內嵌在元件：

```typescript
const pendingQueue = useRef<string[]>([]);
const llmDoneRef = useRef(false);
const typewriterTimer = useRef<...>(null);
const typewriterIntervalMsRef = useRef(TYPEWRITER_INTERVAL_MS_DEFAULT);
function startTypewriter() { ... }
function stopTypewriter(clearQueue = false) { ... }
function waitForTypewriter(): Promise<void> { ... }
```

### 解法

```typescript
// app/web/src/useTypewriter.ts
export function useTypewriter(intervalMs = TYPEWRITER_INTERVAL_MS_DEFAULT) {
  // ... 內部封裝所有 ref 和計時器
  return {
    enqueue: (text: string) => { ... },
    start: () => { ... },
    stop: (clearQueue?: boolean) => { ... },
    waitDone: () => Promise<void>,
    setIntervalMs: (ms: number) => { ... },
  };
}
```

App.tsx 改成：
```typescript
const tw = useTypewriter();
// 原 pendingQueue.current.push(char) → tw.enqueue(delta)
// 原 startTypewriter() → tw.start()
// 原 waitForTypewriter() → tw.waitDone()
```

**預期效果**：App.tsx 再減約 50 行；typewriter 邏輯可獨立測試。

---

## 任務 6 — 提取 `pollUntilProgressed()` utility

### 問題

`send()` 的 catch 區塊內嵌了約 30 行輪詢邏輯：

```typescript
const maxAttempts = 6;
const pollIntervalMs = 3000;
let healed = false;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  ...
  if (freshState.now.lastUpdated !== preTurnLastUpdated) {
    // 成功
  }
}
```

### 解法

```typescript
// app/web/src/api.ts 或 app/web/src/poll.ts
export async function pollUntilProgressed(
  preTurnLastUpdated: string | undefined,
  opts = { maxAttempts: 6, intervalMs: 3000 }
): Promise<GameState | null> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (attempt > 1) await sleep(opts.intervalMs);
    const freshState = await fetchState().catch(() => null);
    if (freshState?.lastTurn && freshState.now.lastUpdated !== preTurnLastUpdated) {
      return freshState;
    }
  }
  return null;
}
```

`send()` 的 catch 改成：
```typescript
const healed = await pollUntilProgressed(preTurnLastUpdated);
if (healed) { setState(healed); setStory(healed.lastTurn!.narrative); ... }
else { setStory(...失敗訊息...); }
```

**預期效果**：`send()` 的 catch 從 30 行縮到 ~6 行；polling 邏輯可獨立測試。

---

## 建議處理順序

```
高影響、低風險先做：
  任務 2（Recall 預設啟用）— 純 config 改一行，風險幾乎為零
  任務 4（handleTurnEvent）— 收益最大，消除最多重複
  任務 1（.pending-opening）— 修正一個靜默失效風險

中等：
  任務 5（useTypewriter hook）— 與任務 4 搭配做效果最好

緩做：
  任務 6（pollUntilProgressed）— 功能正常，只是整理
  任務 3（拆分 app.ts）— 加下一個功能前再做
```
