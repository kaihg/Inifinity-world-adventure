# 玩家行動嵌入 journal.md

## 背景

現行做法是在 `world/player-decisions.md` 以 UUID 為鍵獨立記錄玩家輸入，與 `journal.md` 無法直接對照。此外 `journal.md` 每段開頭的 `玩家行動：` 欄位在回合開始時為空（Layer 1 完成後才落地），`骰池：` 也以 flat text 混入敘事正文，導致：

1. 玩家決策與其觸發的敘事分離，閱讀脈絡斷裂
2. `player-decisions.md` 記錄的 `玩家輸入：` 欄位為空（Issue 8）
3. 骰池資訊混入敘事，LLM prompt 容易誤讀
4. 這份記錄是 `docs/superpowers/specs/2026-06-26-player-meta-epitaph-design.md` 第 9 節「玩家決策來源層」的必要前置

## 設計

### 新 journal 段落格式

```
> 玩家：觀察四周

## [2026-06-30] 林逸環顧主神空間
敘事內容…

擲骰：敏捷=72（失敗）

建議動作：A、B、C
<!-- 骰池：[66, 5, 26, 79, 6, 53] -->
```

規則：
- `> 玩家：` 行**只有** `input.trim()` 非空才寫入；開場回合（空 input）直接從 `## heading` 開始
- `> 玩家：` 行與 `## heading` 是**同一次 atomic write**，在 Layer 1+2 成功後落地（不提前寫入孤立行）
- 骰池改為 HTML comment `<!-- 骰池：[...] -->`，放在 `建議動作：` 之後——人工閱讀時隱藏，引擎審計時可 grep，LLM prompt 不可見
- `擲骰：` 行（Layer 2 rolls）仍放在敘事之後、`建議動作` 之前

副本 `dungeons/<id>/log.md` 採相同格式（對稱 journal.md）。

### 移除 player-decisions.md

`player-decisions.ts`、`player-decisions.test.ts`、以及 `turn.ts` 中的 `appendPlayerDecision` 呼叫一併刪除。玩家決策來源改由 journal.md 段落中的 `> 玩家：` 行提供。未來 epitaph 系統需要時，直接 grep/parse journal.md。

## 變更一覽

### `app/src/engine/journal.ts`

**`JournalEntry` 介面**新增可選欄位：
```typescript
export interface JournalEntry {
  date: string;
  title: string;
  body: string;
  playerAction?: string;  // 新增
}
```

**`appendJournal`** 改為：
```typescript
export async function appendJournal(worldDir: string, entry: JournalEntry): Promise<void> {
  const playerLine = entry.playerAction?.trim()
    ? `\n> 玩家：${entry.playerAction.trim()}\n`
    : "";
  const section = `${playerLine}\n## [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`;
  await appendFile(path.join(worldDir, "journal.md"), section, "utf8");
}
```

**`parseLastTurnRecord`** 更新兩處：
1. 保留舊格式 strip（向下相容）：`body.replace(/^玩家行動：.*\n(骰池：.*\n)?\n*/, "")`
2. `建議動作` 正規式改 `m` flag（去掉 `s`），確保只抓同一行，不含 HTML comment：

```typescript
const suggestedMatch = body.match(/\n\n建議動作：(.+)$/m);
```

### `app/src/engine/dungeon.ts`

**`RunEntry` 介面**同樣新增 `playerAction?: string`。

**`appendLog`** 採相同 playerLine 前綴邏輯。

### `app/src/engine/turn/turn-core.ts`

`plan.appendRaw` 呼叫改為：

```typescript
await plan.appendRaw({
  date: today,
  title: summary,
  playerAction: input,          // 新增
  body: `${narrative}${rollsLine}${suggestedLine}${dicePoolComment}`,
});
```

其中：
- 骰池永遠加，無論 `suggestedLine` 是否存在
- 移除舊的 `玩家行動：${input}\n骰池：[...]\n\n` 前綴

實際 body 模板：
```typescript
const diceComment = `\n<!-- 骰池：[${dicePool.join(", ")}] -->`;
body: `${narrative}${rollsLine}${suggestedLine}${diceComment}`
```

### `app/src/server/routes/turn.ts`

移除：
```typescript
import { appendPlayerDecision } from "../../engine/player-decisions.js";
// ...
await appendPlayerDecision(config.worldDir, { ... });
```

### 刪除檔案

| 檔案 | 原因 |
|------|------|
| `app/src/engine/player-decisions.ts` | 功能由 journal.md `> 玩家：` 行取代 |
| `app/src/engine/player-decisions.test.ts` | 對應模組刪除 |

### 測試更新

**`app/src/engine/journal.test.ts`**：
- 新增：`appendJournal` 有 `playerAction` 時，檔案內容包含 `> 玩家：` 行（在 `## heading` 之前）
- 新增：`appendJournal` 無 `playerAction`（或空字串）時，不寫 `> 玩家：` 行
- 新增：`parseLastTurnRecord` 正確從新格式提取 narrative（HTML comment 不進入 narrative）
- 保留：舊格式（`玩家行動：`）的 backward compat 測試

**`app/src/server/app.test.ts`**：移除斷言 `player-decisions.md` 內容的測試

## 不在本次範圍

- 現有 `world/journal.md` 舊格式的資料遷移（使用者重建世界即可）
- 由 journal.md 反向解析 epitaph 的實作（另立 spec）
- `world/player-decisions.md` 資料檔不刪除（可能有舊資料，git 歷史保存），只停止寫入；`.ts` 程式碼模組刪除

## 影響

| | 改前 | 改後 |
|--|------|------|
| 玩家行動記錄位置 | `player-decisions.md`（UUID 鍵，欄位常空） | `journal.md`（`> 玩家：` 行，緊接觸發敘事） |
| 骰池格式 | `骰池：[...]`（flat text，混入敘事） | `<!-- 骰池：[...] -->`（HTML comment，不進 LLM） |
| 寫入時機 | `appendPlayerDecision` 在 turn 開始前呼叫 | 隨 `appendRaw` 在 Layer 1+2 成功後一次落地 |
| 玩家行動 ↔ 敘事連結 | 無（跨兩個檔案） | 有（`> 玩家：` 緊接同一 `## section`） |
