# 設計文件：副本轉場狀態修正（Issue #51，Bug 1-3）

**日期**：2026-06-26  
**範疇**：`app/src/server/app.ts`（主要）、需新增 import `readFile`/`writeFile`/`bumpNowUpdated`

---

## 背景

副本轉場由 `mode_transition`（Layer 2 fast-control）驅動，落地邏輯在 `app.ts:452-487`。
Issue #51 定位了三個具體實作缺陷（Bug 1-3）；Bug 4（上一輪敘事未餵進 prompt）範疇較大，本次不處理。

---

## Bug 1：`transition` 事件沒有進 buffer

### 問題
`app.ts:474`（enter_dungeon）與 `app.ts:485`（settle_dungeon）的 `transition` 事件
直接用 `reply.raw.write` 送出，沒有 `currentTurnBuffer.events.push`。
前端走 `/api/turn/stream?offset=` 重連時，buffer 重播不包含這個事件，玩家重整後看不到轉場訊號。

### 修法
每個 `reply.raw.write(transition...)` 改為先建 event 物件、push 進 buffer，再寫出：

```typescript
// enter_dungeon
const transitionEv = { type: "transition", to: "dungeon", dungeonId: active.dungeonId } as const;
if (currentTurnBuffer) currentTurnBuffer.events.push(transitionEv);
reply.raw.write(`data: ${JSON.stringify(transitionEv)}\n\n`);

// settle_dungeon
const transitionEv = { type: "transition", to: "main-space" } as const;
if (currentTurnBuffer) currentTurnBuffer.events.push(transitionEv);
reply.raw.write(`data: ${JSON.stringify(transitionEv)}\n\n`);
```

**影響範圍**：只改 `app.ts` 兩處，不動型別定義。

---

## Bug 2：`done.state` 是轉場前的舊快照

### 問題
`turn-core.ts:189` 的 `loadState` 在 Layer 2 後、`done` yield 前執行，
但轉場（`enterDungeon`/`setNowActiveDungeon`）發生在 `app.ts` 層、`done` yield 之後。
`done.state` 永遠是進副本前的磁碟狀態，前端面板收到舊快照。

### 修法（方案 C：只對有轉場的回合補讀）
加 `didTransition` flag，轉場落地後重讀一次 state：

```typescript
let didTransition = false;

// ... enter_dungeon 分支末尾
didTransition = true;

// ... settle_dungeon 分支末尾
didTransition = true;

// 轉場後補讀，確保 done.state 反映落地後磁碟狀態
if (didTransition) {
  try {
    done = { ...done, state: await loadState(config.worldDir, turnLogger) };
  } catch (err) {
    turnLogger.warn({ err }, "轉場後 loadState 失敗，done.state 保留轉場前快照");
  }
}
```

**無轉場回合**：flag 為 false，不執行，零額外開銷。

---

## Bug 3：guard 擋下時 `now.md` 與實際 mode 脫鈎

### 問題
`app.ts:453-456`，缺 `transitionDungeonId` 時只送 warning 並清 `modeTransition`，
但 `now.md` 的 `nextStep`/`scene` 可能已被 Layer 2 寫成「主角已進入副本」的狀態。
下一輪模型收到 canonical block 的 `mode=main-space` 與 `nextStep=已進副本` 互相矛盾，
容易再演一次轉場。

### 修法
guard 分支補寫 `now.md` 的最後更新時間戳（`bumpNowUpdated`，lossless，只改時間戳行）：

```typescript
if (done.modeTransition === "enter_dungeon" && !done.transitionDungeonId) {
  turnLogger.warn("mode_transition=enter_dungeon 但缺 transition_dungeon_id，無法進入副本，停在等玩家");

  try {
    const nowPath = path.join(config.worldDir, "now.md");
    const nowMd = await readFile(nowPath, "utf8");
    await writeFile(
      nowPath,
      bumpNowUpdated(nowMd, {
        date: todayISO(),
        summary: "系統判定要進入副本但未確定副本 id，等待玩家確認",
      }),
      "utf8",
    );
  } catch (err) {
    turnLogger.warn({ err }, "guard 補寫 now.md 失敗，略過");
  }

  reply.raw.write(`data: ${JSON.stringify({ type: "warning", message: "系統判定要進入副本，但未能確定副本 id，暫停等玩家確認。" })}\n\n`);
  done = { ...done, modeTransition: null };
}
```

**說明**：
- 用 `bumpNowUpdated` 而非整個覆寫，不動其他欄位，符合 lossless 原則。
- 失敗時只 warn 不崩潰，與其他降級路徑一致。
- 不強行改 `nextStep` 欄位內容（Layer 2 已落地的 now 欄位保留），只確保時間戳反映「狀態已被系統確認」。

---

## 需新增的 import（`app.ts`）

```typescript
// node:fs/promises 已有 rm，補加 readFile / writeFile
import { rm, readFile, writeFile } from "node:fs/promises";

// 補加 bumpNowUpdated
import { bumpNowUpdated } from "../engine/now.js";
```

---

## 不在本次範疇

- **Bug 4**（主腦 prompt 缺上一輪敘事）：改動較大，留到後續 issue 觀察。
- `turn-core.ts` 本身不改動。
- 無新測試檔，現有 unit test 結構不受影響（`app.ts` 的整合測試若有涵蓋轉場路徑則可補）。
