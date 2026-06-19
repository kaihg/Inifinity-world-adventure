# Scene Pre-pass 設計文件

**日期**：2026-06-19
**狀態**：已核准，待實作

## 問題陳述

目前 `loadState()` 進入 system prompt 的 NPC 資訊只有 `characters/index.md` 四欄（id、name、role、status）。角色完整檔案（背景、能力、性格、關係）從未進入 LLM context，導致：

- NPC 像工具人，只會配合主角，缺乏自主性
- NPC 能力標籤失效（例如葉晴明明是特戰教官，卻對暗號、陷阱、守夜話題無反應）
- 需要玩家在對話中明確點出才能改善，造成出戲感

根本原因是**上下文工程問題**，不是模型能力問題。

## 解法：二段式 Pipeline

每回合拆成兩次 LLM call，各自專注一件事：

```
1. Character Pre-pass（並行，每個 NPC 獨立一次 call）
   input:  NPC 完整角色檔 + 場景 + 玩家行動
   output: { stance, intent, tone }

2. 敘事 call（原本的 runTurnCore）
   input:  原 system prompt + 角色意圖區塊（注入）
   output: 敘事散文 + ===STATE=== JSON
```

**並行策略**：所有在場 NPC 的角色意圖 call 同時發出，等待時間 = 最慢那個 NPC，不是所有 NPC 加總。

## 觸發範圍

只對「當前場景存在的角色」跑 pre-pass：

1. 讀取 `now.companions`，解析出 NPC ID 列表
2. 對每個 ID 確認 `characters/<id>.md` 存在
3. 有完整檔案 → 跑角色意圖 call
4. 缺檔案（新生成角色、一次性 NPC）→ 靜默略過，不影響敘事 call

> **設計意圖**：主幹 LLM 可能在回合中生成新角色，此時角色檔尚不存在。下一回合引擎更新 `now.companions` 與角色檔後，才納入 pre-pass。這是正確行為，不是 bug。

## 角色意圖 Schema

```typescript
interface CharacterIntent {
  id: string;
  stance: string;  // 本回合對主角/場景的立場，一句話
  intent: string;  // 想做或說的事，一句話
  tone: string;    // 語氣標籤，例如「冷靜直接」「謹慎保留」「情緒不穩」
}
```

**預留欄位**（本次不填，未來擴充用）：

```typescript
interface CharacterIntent {
  // ...以上三欄
  triggered_abilities?: string[];  // 本回合應展現的能力標籤
  subtext?: string;                // 表面話背後的真實想法（非必要不填）
}
```

## 元件設計

### TurnDeps 擴充

```typescript
export interface TurnDeps {
  client: LlmClient;           // 主敘事 LLM
  characterClient?: LlmClient; // 角色意圖 LLM，缺省 fallback 到 client
  worldDir: string;
  commit: (message: string) => Promise<boolean>;
  today?: () => string;
  dicePool?: number[];
}
```

### 新增模組：`engine/character-pre-pass.ts`

職責：
- 接收在場 NPC ID 列表 + worldDir + characterClient
- 並行讀取角色檔、發出意圖 call
- 回傳 `CharacterIntent[]`（失敗的 NPC 靜默略過）

### 角色意圖 call 的 system prompt

```
你是角色意圖分析器。根據以下角色檔案與當前場景，
輸出該角色在本回合的立場、意圖、語氣。
只輸出 JSON，不要前言。格式：
{ "stance": "...", "intent": "...", "tone": "..." }

角色檔案：
<角色完整 .md 內容>

當前場景：<now.scene>
玩家行動：<input>
```

### 注入敘事 call 的方式

角色意圖結果作為獨立區塊，插入 system prompt 的 `canonicalBlock` 之後：

```
## 在場角色本回合意圖（pre-pass 生成，必須遵守）
### 葉晴（yeqing）
- 立場：對沈奕的行動保持觀察，評估實戰判斷力
- 意圖：主動提出守夜暗號方案，推進已承諾但未執行的計畫
- 語氣：控制、低調、直接

### 林思雨（linsiyu）
- 立場：…
- 意圖：…
- 語氣：…
```

如果沒有任何 NPC 通過 pre-pass，整個區塊省略，敘事 call 的 system prompt 與現在相同。

## 設定化

`.env` 新增兩個 optional 變數：

```env
# 角色意圖 LLM（缺省沿用主 LLM）
CHARACTER_OPENAI_BASE_URL=http://localhost:11434/v1
CHARACTER_MODEL=qwen2.5:3b
```

`config.ts` 新增：

```typescript
character?: {
  baseUrl: string;
  model: string;
}
```

缺省時 `characterClient` 與主 `client` 共用同一端點，零 migration cost。

## 失敗處理

| 情況 | 行為 |
|------|------|
| 角色檔不存在 | 靜默略過該 NPC |
| 意圖 call 逾時 / parse 錯誤 | 靜默略過該 NPC，發 `{ type: "warning" }` event |
| 所有意圖 call 失敗 | 敘事 call 照常進行，無角色意圖注入 |
| 敘事 call 失敗 | 現有降級邏輯不變 |

Pre-pass 失敗**絕不 block 回合**。

## 不在範圍內

- **World Simulation Pass**（不在場角色的週期性模擬）→ [issue #7](https://github.com/kaihg/Inifinity-world-adventure/issues/7)
- `subtext` / `triggered_abilities` 欄位的實際使用
- 前端顯示角色意圖面板

## 影響範圍

| 檔案 | 變動 |
|------|------|
| `app/src/config.ts` | 新增 `character` 設定區塊 |
| `app/src/llm/client.ts` | 無變動（`LlmClient` 介面不動） |
| `app/src/engine/turn.ts` | `TurnDeps` 新增 `characterClient?`；`buildMainSpaceMessages` / `buildDungeonMessages` 新增 intents 參數；`runMainSpaceTurn` / `runDungeonTurn` 在組 messages 前先跑 pre-pass |
| `app/src/engine/character-pre-pass.ts` | 新增 |
| `app/src/server/app.ts` | 建立 `characterClient`（從 config 讀取）並注入 `TurnDeps` |
| `app/.env.example` | 新增 `CHARACTER_OPENAI_BASE_URL` / `CHARACTER_MODEL` 說明 |
