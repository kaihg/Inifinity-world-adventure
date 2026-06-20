# 拆分主敘事與結構控制輸出（雙腦回合）設計

## 背景

目前每回合只發一次 LLM call（`buildMainSpaceMessages`/`buildDungeonMessages`），要求模型在同一次輸出裡先寫敘事散文，再以 `===STATE===` 分隔吐出單一 JSON 控制物件（`TurnControlSchema`：`state_changes`、`rolls`、`mode_transition`、`transition_dungeon_id`、`awaiting_user_input`、`suggested_actions`、`commit_summary`）。

這讓單一模型同時擔負「寫好故事」與「精確產出結構化 JSON」兩個性質不同的任務，尤其在自架/較弱模型上容易互相拖累：要嚴守 JSON 格式可能讓散文變僵硬，反之放開敘事自由度又容易讓 JSON 格式跑掉，解析失敗時目前只能整回合降級（敘事保留、暫停等玩家）。

## 目標

把「主敘事」與「結構控制抽取」拆成兩次循序的 LLM call：

1. **主腦**：只負責寫敘事散文，不輸出任何 JSON。
2. **副大腦**：等主腦把整段話說完（拿到完整散文）後，讀散文 + 當前世界狀態，一次性抽出完整的 `TurnControl` JSON。

兩者循序執行（副大腦依賴主腦的完整輸出當輸入），不是平行。

## 不變的部分

- **擲骰機制完全不變**：骰池仍由伺服器端 `roll.ts`（crypto 真隨機）預先擲好，餵進主腦 system prompt，主腦敘事時必須依序取用、不可自行編造數字。副大腦不重新擲骰，只是讀「主腦已經寫進散文裡的骰值使用情況」抽取成結構化 `rolls[]` 回報——這是對已成事實的文字做結構化，不是產生新的隨機性。
- `TurnControlSchema`（`schema.ts`）欄位定義不變。
- raw 層落地（`journal.ts`/`dungeon.ts` 的 `appendRun`）、`now.md` 覆寫、積分增減、wiki 提煉、commit 時機等下游邏輯不變，只是輸入來源從「單一 call 解析結果」變成「副大腦 call 解析結果」。
- `character-pre-pass.ts`（NPC 意圖 pre-pass）不受影響，繼續在主腦呼叫前注入 `intentsBlock`。

## 架構變更

### 主腦（敘事）

- System prompt 移除整個 `OUTPUT_FORMAT_BLOCK` 與 JSON 輸出要求。
- 保留：鐵則、世界設定、canonical 狀態（`canonicalBlock`）、骰池區塊（措辭調整為「敘事中要把用到的骰值寫清楚，後續會由系統抽取」）、`intentsBlock`、（副本模式）wiki/secrets。
- 輸出純散文，不需要 `===STATE===` sentinel。
- `runTurnCore` 裡的 `createNarrativeSplitter` 在主回合路徑上移除：串流 delta 直接轉發給前端，累積成 `narrative` 全文即可，不必再做 sentinel 緩衝切分。

### 副大腦（結構抽取，新角色）

- 新增 `TurnDeps.controlClient?: LlmClient`，未設定時退回 `deps.client`，延續 `characterClient` 既有的「可選獨立模型」分工模式。
- 主腦串流結束、取得完整 `narrative` 後才呼叫，輸入：
  - 完整敘事散文（主腦剛產生的）
  - 玩家本回合輸入
  - 世界設定（`setting.md`）
  - canonical 狀態（`now`/`protagonist`）
  - 本回合骰池（同一份，供比對散文裡提到的骰值）
  - （副本模式）`wiki`/`secrets`
  - 現有副本 id 列表（讀 `world/dungeons/` 目錄列舉，新增小工具函式，供 main-space 模式判斷 `enter_dungeon` 時該續用既有副本還是生成新 slug）
- 輸出：**單純一個 JSON 物件**（不再有散文前綴，不需要找 sentinel，直接整段當 JSON 解析），驗證走既有 `TurnControlSchema`。
- System prompt 明確要求：只抽取/整理散文裡已經發生的事實，不可新增劇情、不可發明散文未提及的數值或事件。

### mode_transition 與副本 slug

- 不引入第三個 agent，也不在主腦輸出裡加 inline 標記。`mode_transition`/`transition_dungeon_id` 就是副大腦輸出的 `TurnControl` 裡的欄位之一，跟其他結構欄位同一次呼叫產出。
- 副大腦在 main-space 模式時，額外拿到「現有副本 id 列表」，用來判斷敘事是否在重返已存在的副本（續用該 id）或進入全新副本（生成新的 kebab-case slug）。

## 錯誤處理與降級

- 主腦這條路徑幾乎不會再有「解析失敗」的情境——純文字輸出，沒有 JSON 可解析錯，原本 sentinel 缺失/JSON 壞掉的風險完全消失在這一層。
- 風險集中到副大腦：解析/Schema 驗證失敗時，沿用現有降級邏輯，但觸發點不同——此時敘事已經安全產生並落地（raw log 正常寫，因為散文跟結構脫鉤，比現在更安全）：
  - `now.md` 只 bump `lastUpdated`，不套用 `state_changes`
  - 不套用積分增減、不套用 wiki_reveals、不觸發 mode_transition
  - `awaiting_user_input` 視為 `true`（暫停，交還玩家），`suggested_actions` 為空
  - yield 一個 `warning` event 讓前端可觀察
  - 行為上對齊今天 `runTurnCore` catch 區塊的降級路徑，只是觸發來源從「單一 call 解析失敗」改成「副大腦 call 解析失敗」。

## 測試策略

- `turn.test.ts`：現有 mock client 回應（散文+sentinel+JSON 一體）需要拆成兩段——mock 主腦 client 回純散文、mock 副大腦 client（`controlClient`）回 JSON。既有案例覆蓋的行為（積分增減、wiki_reveals、mode_transition、auto-advance、降級路徑）维持不變，只是 mock 注入方式改變。
- 新增/調整測試：副大腦 call 失敗（網路錯誤/JSON 壞掉/Schema 不符）時的降級路徑，驗證敘事仍落地、`now.md` 仍 bump、`awaiting_user_input=true`。
- `schema.ts`：`TurnControlSchema` 不變；`parseTurnOutput`（目前同時處理「找 sentinel 切敘事」與「解析 JSON」）職責拆分——主腦這邊不再需要切分敘事；副大腦這邊的「JSON 解析」變成「整段輸出就是 JSON」，不需要找 sentinel，可以簡化或新增一個專用的 `parseControlOutput`。
- `stream-split.ts`/`stream-split.test.ts`：主回合敘事路徑不再使用 `createNarrativeSplitter`，需確認該模組是否還有其他呼叫點；若無，移除對應呼叫並評估模組本身是否仍需保留（測試與既有匯出視整理結果調整，非本次設計重點）。

## 範圍外

- 不改變骰值生成機制本身。
- 不改變 `TurnControlSchema` 欄位定義。
- 不改變 raw 層/wiki 提煉/commit 的落地邏輯與時機。
- 不引入第三個 LLM agent。
- `character-pre-pass.ts` 維持原樣，不在本次設計範圍內調整。
