# 第三人稱鐵則 + 場景/技能 lore + 反應式文件同步（三層回合）設計

## 背景

目前每回合的結構抽取（副大腦，`buildControlMessages`）是單一 JSON call，同時負責兩種性質不同的工作：

1. **下一回合開場就要讀的狀態**：`now.md` 七欄、主角積分/屬性/技能/物品/buff、`rolls`、`mode_transition`、`awaiting_user_input`、`suggested_actions`、`commit_summary`。
2. **細節補完，下一回合 context loader 不會立刻讀**：`npc_updates`（append 進 `characters/<id>.md`）、`item_pickups`/`item_reveals`（道具 secrets/wiki）、`wiki_reveals`（副本 wiki）、recall 向量索引重建。

這兩種工作目前綁在同一次 LLM call、同一個 `runTurnCore` 同步區塊裡，全部 await 完才把 `done` event 丟給前端，玩家看到「建議動作」之前要等最重的那一份工作做完。

另外兩個既有缺口：
- 主敘事 prompt（`buildMainSpaceMessages`/`buildDungeonMessages`）沒有明確的人稱規則，目前敘事偏第三人稱（用角色名字）純粹是模型自己的傾向，沒有寫進鐵則，有 drift 成「你」的風險。
- `lore.ts` 的 `LoreCategory` 只有 `dungeons`/`items`/`skills` 在用（`skills` 型別已存在但無人寫入），沒有「場景/地點」這個分類，且 `skills`/場景都沒有「劇情首次明確提到時才生成 secrets、之後累積進 wiki」的觸發點。

## 目標

1. **第三人稱鐵則**：主空間與副本兩個敘事 prompt 各加一條鐵則，明確要求敘事一律用姓名/代稱描寫主角與所有人物，不可用「你」指稱主角；玩家輸入的「我」只代表意圖，敘事轉譯時要用主角本名。
2. **場景 lore 分類**：`lore.ts` 的 `LoreCategory` 新增 `"locations"`，沿用既有 `loadLore`/`ensureSecrets`/`appendLoreReveals` 三件套，不另起新邏輯。
3. **三層回合**：把現有單一 control call 拆成：
   - **Layer 1（主腦）**：敘事散文。不變。
   - **Layer 2（fast-control）**：`now`/`protagonist_updates`/`protagonist_points_delta`/`rolls`/`mode_transition`/`transition_dungeon_*`/`awaiting_user_input`/`suggested_actions`/`commit_summary`。落地後立即 commit、yield `done`，SSE 在這裡結束，玩家馬上看到建議動作。
   - **Layer 3（reactive-lore-sync）**：`npc_updates`/`item_pickups`/`item_reveals`/`wiki_reveals`/新增的 `location_mentions`/`skill_mentions`（劇情首次明確提到的場景/技能 id+name，沿用 item_pickups 的格式）+ recall 向量索引重建。在 Layer 2 commit、`done` event 送出**之後**才開始跑，不卡 SSE 回應；完成後自己 commit 一次。

## 不變的部分

- 擲骰機制（`roll.ts`）、骰池注入主腦 prompt 的方式完全不變。
- `TurnControlSchema` 既有欄位不刪不改型別，只新增 `location_mentions`/`skill_mentions`（兩個都是 `Array<{id, name}>`，格式對齊 `item_pickups`）。
- raw 層落地（`journal.md`/`runs/*.md`）、`now.md` 覆寫、主角積分/屬性落地的時機與邏輯：仍在 Layer 2，不延後。
- `character-pre-pass.ts`、recall 查詢（讀取）邏輯不受影響。

## 架構變更

### 第三人稱鐵則（`turn.ts` 的 `buildMainSpaceMessages`/`buildDungeonMessages`）

兩個 prompt 的「## 鐵則」各加一條：

```
- 敘事一律採第三人稱描寫主角與所有人物（用姓名/代稱，例如「沈奕」「葉晴」），絕不可用「你」指稱主角；
  玩家輸入中的「我」只代表角色意圖，敘事裡要轉譯為主角本名。
```

### 場景 lore 分類（`lore.ts`）

```typescript
export type LoreCategory = "dungeons" | "items" | "skills" | "locations";
```

不需要改 `loadLore`/`ensureSecrets`/`appendLoreReveals` 本體——三者已經是純參數化的（`category` 只決定目錄路徑），新增分類等於零邏輯成本。

### Schema 新增欄位（`schema.ts`）

```typescript
location_pickups?: [{id, name}]  // 劇情首次明確帶到的場景（仿 item_pickups）
location_reveals?: [{id, reveal}]
skill_pickups?: [{id, name}]     // 主角首次習得/明確接觸的技能設定
skill_reveals?: [{id, reveal}]
```

> 命名沿用 `item_pickups`/`item_reveals` 的形狀（`pickups` = 首次接觸要生成 secrets；`reveals` = 累積進 wiki），而不是另創 `*_mentions`，讓 `turn.ts` 可以直接重用 `applyItemPickups`/`appendLoreReveals` 的既有函式邏輯改成參數化版本，不必為場景/技能各寫一份。

### Layer 2 / Layer 3 拆分（`turn.ts`）

**Control prompt 拆兩份**：
- `buildFastControlMessages`：欄位限定在 `now`/`protagonist_updates`/`protagonist_points_delta`/`rolls`/`mode_transition`/`transition_dungeon_*`/`awaiting_user_input`/`suggested_actions`/`commit_summary`。
- `buildLoreSyncMessages`：欄位限定在 `npc_updates`/`item_pickups`/`item_reveals`/`location_pickups`/`location_reveals`/`skill_pickups`/`skill_reveals`/`wiki_reveals`。兩者都讀同一份完整敘事散文 + canonical 狀態，只是要求抽取的欄位子集不同——**不是兩次不同的理解任務，只是切兩刀**，避免單次 JSON 過度肥大拖累抽取品質。

**`TurnDeps` 新增 `loreClient?: LlmClient`**（未設定退回 `controlClient` 退回 `client`，延續既有「可選獨立模型」分工模式——Layer 3 的抽取任務比 Layer 2 簡單，可以指更小/更慢的模型而不影響玩家體感）。

**`runTurnCore` 改動**：
1. 主腦串流（不變）。
2. Layer 2 抽取 → 落地 raw 層、`now.md`、主角狀態、`rolls`、commit（Layer 2 的 commit message 用 `commit_summary`）→ `yield { type: "done", ... }`。**SSE 到這裡可以結束。**
3. 呼叫端（`runMainSpaceTurn`/`runDungeonTurn`）在 `runTurnCore` 回傳後，**不 await** 地另外觸發 Layer 3（包裝成一個 promise），但要把這個 promise 存到一個跨回合的 handle 上。
4. Layer 3 完成後：落地 npc/item/location/skill/wiki reveals、recall 重建索引、commit 一次（commit message 固定字串如「補完場景/角色/物品設定」，不寫具體內容，對齊 CLAUDE.md「commit message 提到劇透文件只寫事實」的既有約定）。

**串連下一回合的關鍵**：新增 `TurnDeps.pendingLoreSync?: { promise: Promise<void> | null; set(p: Promise<void>): void }`（一個簡單的可變 handle，由 server 層在建立 `TurnDeps` 時建立一個 per-session 實例，跨回合複用同一個物件）。`runMainSpaceTurn`/`runDungeonTurn` 一開始先 `await deps.pendingLoreSync?.promise`，回合做完後把新的 Layer 3 promise 寫回 `pendingLoreSync.set(...)`。

這個 handle 是**單一 in-process 物件、純靠 await 鏈接力**，不是 worker/真執行緒、不需要檔案鎖：
- 玩家體感：Layer 3 不卡 SSE 回應，建議動作秒出。
- 正確性：下一回合的 Layer 2/3 都不會跟上一回合的 Layer 3 commit 同時寫檔案，因為一定先 await 完。
- 失敗處理：Layer 3 任一步驟失敗只記 `log.warn`，不拋出、不影響下一回合（`pendingLoreSync.promise` 必須是「永遠 resolve、自己 catch 掉」的 promise，否則會讓下一回合的 await 拋錯）。

### Recall 重建索引

從 `runTurnCore` 同步區塊移到 Layer 3：`reindexTouchedFiles` 呼叫點不變，只是觸發時間點延後到 Layer 3 階段，且觸及的檔案清單要補上 `locations/<id>/wiki.md`、`skills/<id>/wiki.md`。

## 錯誤處理與降級

- Layer 2 失敗：行為與現有 `control = null` 的降級路徑完全相同（敘事保留、`now.md` 只 bump、`awaiting_user_input=true`、發 warning）——不受本次改動影響。
- Layer 3 失敗（任一道具/場景/技能/NPC/wiki 子步驟，或整次 LLM call 失敗）：`log.warn` 記錄，跳過該筆，不影響其他筆、不影響已經結束的本回合 SSE、不阻塞下一回合（因為 `pendingLoreSync` 的 promise 本身 catch 掉，永遠 resolve）。
- Layer 3 沒有對應的 `warning` SSE event（因為這時 SSE 連線已經關閉），改成只寫 server log；前端不會看到。

## 測試策略

- `lore.test.ts`：`LoreCategory` 新增 `"locations"` 的讀寫測試（沿用既有 items 測試模式複製一份）。
- `schema.test.ts`：新增 `location_pickups`/`location_reveals`/`skill_pickups`/`skill_reveals` 的解析測試。
- `turn.test.ts`：
  - `buildFastControlMessages`/`buildLoreSyncMessages` 各自的純函式測試（取代現有 `buildControlMessages` 測試，或保留 `buildControlMessages` 改名重構）。
  - `runTurnCore`/`runMainSpaceTurn`：驗證 `done` event 在 Layer 3 開始前就 yield（用一個「會卡住的 fake loreClient」+ 計時/順序斷言，確保 done 不等 Layer 3）。
  - 新增「`pendingLoreSync` 接力」測試：兩次連續呼叫 `runMainSpaceTurn`，第二次呼叫前手動檢查 Layer 3 寫的檔案已經落地（驗證 await 鏈確實生效）。
  - Layer 3 失敗測試：`loreClient` 拋錯時，下一回合仍正常開始、不拋錯。
- `app.test.ts`：SSE 測試補一個案例，確認 response 在 Layer 2 完成後就關閉（不需要等 Layer 3 的 fake client resolve）。

## 範圍外

- 不引入真正的 worker_threads / job queue / 跨 process 背景任務；`pendingLoreSync` 純粹是同 process 內的 promise 接力。
- 不改變骰值機制、`now.md` 七欄定義、raw 層落地時機。
- 不對既有 `items`/`dungeons` 的 lore 流程做行為變更，只是讓 `locations`/`skills` 走同一套。
- 場景/技能首次提及的判斷邏輯仍完全交給 LLM（Layer 3 抽取），引擎不做關鍵字比對或規則式偵測。
