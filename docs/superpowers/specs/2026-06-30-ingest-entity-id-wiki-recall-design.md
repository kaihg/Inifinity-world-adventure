# Ingest 管線改進：Entity ID 正規化 + Wiki 注入 + Recall 查詢優化

## 背景

2026-06-29 E2E 測試發現以下問題，並在 first-principles 分析後確認根因：

1. **問題 3（ID 結構不一致）**：dungeon entity file 用 LLM 自由產出的中文名（`生化危機：浣熊市.md`），run 目錄用 machine-generated 英文 kebab-case（`bio-hazard-raccoon-city/`），同一副本兩套命名無法對齊。
2. **問題 4（Scene 重複 + 英文 ID）**：entity extraction 為同一場所建立兩個 entity（`main_space`、`geometric_crystal`），且 ID 用英文 snake_case，中英混用造成重複識別。
3. **問題 5（Skills wiki 狀態描述不準）**：wiki format hint 硬規定「持有者：xxx」，導致尚未取得的技能被錯誤標注為玩家持有。
4. **根本問題（wiki 未注入 + recall 查詢源太弱）**：category wiki 從未被注入 Layer 1 prompt；recall 以 player input（短且模糊）做語意搜尋，效果差。

---

## 設計

### 一、`sanitizeLoreId(id: string): string`

**位置**：`app/src/engine/lore.ts`（新增 export function）

**規則（依序執行）**：
1. `trim()` — 去頭尾空白
2. `toLowerCase()` — 統一小寫（對中文無副作用，防英文大小寫分岐）
3. ASCII `:` → 全形 `：`
4. ASCII `/` `\` → 全形 `／`
5. 截斷至 80 字元

**套用點**：
- `rewriteLoreFile(worldDir, category, id, ...)` 入口
- `loadLoreFile(worldDir, category, id, ...)` 入口
- dungeon 進入時 `transitionDungeonId` 在寫入 now.md / 建立 run 目錄之前

所有 lore ID 接觸 filesystem 前都先通過此函式，確保 entity file 與 run 目錄可用同一 ID 定址。

---

### 二、ID 命名慣例：全面改用中文正式名稱

**棄用英文 kebab-case**：本遊戲全繁體中文，LLM 自然產出中文名；強制轉英文 ID 是額外不穩定源且造成 Issue 3/4。

**新慣例**：
- 所有 entity ID = 中文正式名稱，經 `sanitizeLoreId` 正規化
- 例：副本 `生化危機：浣熊市`、場景 `主神空間`、技能 `基礎戰術反應`
- run 目錄同步改用中文：`world/dungeons/生化危機：浣熊市/`
- entity file 與 run 目錄同名：`world/dungeons/生化危機：浣熊市.md` ↔ `world/dungeons/生化危機：浣熊市/`

**需同步修改**：
- Layer 2 fast-control schema 的 `transition_dungeon_id` 欄位描述：要求輸出中文名稱（如「生化危機：浣熊市」），由引擎呼叫 `sanitizeLoreId` 後使用
- `dungeon.ts` 的 `enterDungeon`：用 sanitized ID 建立 run 目錄

---

### 三、Extraction Prompt 三條新規則

**位置**：`app/src/engine/ingest.ts` 的 `extractEntities` system prompt

新增以下規則（附在現有規則清單後）：

```
- 所有 entity id 直接使用中文正式名稱，不做英文翻譯或 snake_case 轉換
- scene 的 id 使用場所的中文正式名稱；同一物理地點只能有一個 scene entity，禁止為同一場所的不同面向建立多個 id
- dungeon 的 id 使用副本的中文正式名稱（如「生化危機：浣熊市」）
```

---

### 四、Wiki 格式：名稱登記冊（Name Registry）

**設計原則**：wiki 的讀者是 Layer 1 的 narrative model，目的是告訴它「這個 entity 存在」，不描述當前狀態。狀態細節由 recall 動態注入 entity file。Wiki 描述越精簡越不容易與 entity file 出現矛盾。

**更新後的 `WIKI_FORMAT_HINT`**（`app/src/engine/ingest.ts`）：

```typescript
const WIKI_FORMAT_HINT: Record<LoreCategory, string> = {
  skills: "分「主動技能」「被動技能」兩大段，各技能一行 `- [[id]]：一句中性描述`",
  items:  "分「消耗品」「持久道具」兩大段，各道具一行 `- [[id]]：品質等級、一句中性描述`",
  scenes: "分「主空間場景」「副本場景（副本名）」兩大段，各場景一行 `- [[id]]：環境基調`",
  dungeons: "各副本一行 `- [[id]]：難度基調、狀態（進行中/已結算）`",
};
```

**重點**：
- skills：移除「持有者：xxx」，改為中性描述（不聲明擁有狀態）
- scenes：新增主空間/副本分區，避免跨副本場景混在一起
- items/dungeons：維持現有結構但措辭改為中性
- 所有分類：只寫「是什麼」，不寫「誰有」「現在狀態如何」

---

### 五、Category Wiki 注入 Layer 1

**現狀**：四個 category wiki（skills/items/scenes/dungeons）從未被注入任何 prompt，僅為人類可讀 side product。

**新設計**：每回合固定注入全部四個 category wiki，作為 entity 名稱登記冊。

**實作位置**：`app/src/engine/turn/index.ts`，在組裝 Layer 1 params 之前讀取所有 wiki。

**注入位置**：`app/src/engine/turn/prompts.ts` 的 `buildMainSpaceMessages` 與 `buildDungeonMessages`，在主角狀態之後、recall block 之前加入一個新的 `wikiBlock` 區段：

```
## 已知實體索引（name registry）
### 技能
<skills/wiki.md 內容>
### 道具
<items/wiki.md 內容>
### 場景
<scenes/wiki.md 內容>
### 副本
<dungeons/wiki.md 內容>
```

**Context 增長估算**：一般遊玩進度下四個 wiki 合計約 1,000–3,000 tokens，對總 context 影響有限。

**降級策略**：wiki 檔案不存在時靜默略過（`ENOENT` 回空字串），不影響回合正常進行。

---

### 六、Recall 查詢源改為最後一條 Journal Entry

**現狀**：recall 以玩家 input（通常 5–20 字，語意稀薄）做向量搜尋。

**問題**：短輸入的語意密度不足以精準找出相關 entity file。

**新設計**：查詢源改為「最後一條 journal entry（或 log.md 最後一段）」，即 Layer 1 剛產出的敘事段落。

**理由**：
- journal entry 自然包含場景描述、NPC 名稱、技能/道具提及、事件發生地
- 語意空間與 entity file 最接近（都是以遊戲世界語言描述的文本）
- 長度足夠（通常 200–500 字），向量搜尋精準度大幅提升

**查詢構成**（優先序）：
1. **上一回合**的 journal/log entry（Layer 1 前一回合的產出，回合開始時從檔案讀取）
2. 玩家 input（補充）

> 時序說明：recall 的結果是注入 Layer 1 prompt，所以只能用「本回合開始前」已寫入的內容作查詢源；本回合 Layer 1 的敘事輸出是下一回合的查詢材料。

**實作位置**：`app/src/recall/` 的查詢入口；查詢源在 turn pipeline 組 prompt 之前讀取（與讀 now.md 同一階段）。

> **注意**：recall 目前由 `RECALL_ENABLED` env 控制，本次設計不改變此開關，只改查詢源。

---

## 不在本次範圍

- 現有 `bio-hazard-raccoon-city/` run 目錄不做遷移（test world，下次 init 自然正確）
- 現有 `main_space.md`、`geometric_crystal.md` 等舊英文 ID 檔案不做補丁
- Recall 索引重建機制（已有 `RECALL_ENABLED` 流程，不改）
- 問題 1、2、6、7、8、9 見 `2026-06-30-e2e-observed-issues-backlog.md`

---

## 影響範圍

| 檔案 | 變動類型 |
|------|---------|
| `app/src/engine/lore.ts` | 新增 `sanitizeLoreId()`，套用到 `loadLoreFile` / `rewriteLoreFile` 入口 |
| `app/src/engine/dungeon.ts` | `enterDungeon` 用 `sanitizeLoreId` 處理 `transitionDungeonId`；run 目錄改用中文 ID |
| `app/src/engine/ingest.ts` | extraction prompt 加 3 條規則；更新 `WIKI_FORMAT_HINT` |
| `app/src/engine/turn/index.ts` | 每回合讀取 4 個 category wiki，傳入 prompt builder |
| `app/src/engine/turn/prompts.ts` | `buildMainSpaceMessages` / `buildDungeonMessages` 加 `wikiBlock` 區段 |
| `app/src/recall/` | 查詢源改為最後一條 journal/log entry + player input |
| `app/src/engine/schema.ts` | `transition_dungeon_id` 欄位描述更新，說明應輸出中文名 |
