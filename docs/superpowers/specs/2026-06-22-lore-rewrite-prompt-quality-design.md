# Layer 3 Lore 重寫 Prompt 品質強化 設計

## 背景

`app/src/engine/turn/lore-rewrite.ts`、`lore-sync.ts` 是 Layer 3（reactive-lore-sync）：每回合把主腦敘事中摸到的 NPC/道具/場景/技能/副本，整檔重寫進對應的 `wiki.md`（玩家可見的累積知識）與 `secrets.md`（劇透暗線，首次接觸生成一次）。

目前的 prompt 偏簡陋，有幾個實際問題：

1. `callLoreRewrite` 的 system prompt 完全沒有語言/用詞規範，容易混入簡體用詞。
2. `callLoreRewrite` 對所有分類（npc/item/location/skill/dungeon）共用同一套泛用指示，沒告訴模型「這類文件具體該寫什麼」，導致 wiki 內容品質不穩定、容易偏向只寫劇情伏筆而漏掉玩家會想知道的基本說明。
3. 現有的「不可發明片段未提及的事實」規則沒有區分「全新建檔」與「更新既有文件」兩種情境，導致實體第一次只被簡單提及時（例如「醫療室」），wiki 沒有合理的擴寫空間，下次劇情真正深入這個實體時容易風格漂移、前後矛盾。
4. 兩個既有 bug：wiki 標題用 `entity.id` 不用 `entity.name`；`generateItemSecrets` 對 location/skill 也套用「道具設計者」措辭。

## 目標

在不改變現有資料結構（`LoreEntityRefSchema`、`LoreContent`、`now.md` 七欄等）、不改變既有「raw append + canonical 提煉 + 覆寫 now.md」三層模型的前提下，純粹強化 Layer 3 重寫時用的 prompt 文字與少量參數傳遞，讓輸出的 wiki/secrets 文件：

- 一律用繁體中文、符合台灣用詞習慣
- 同時涵蓋「玩家一般可見說明」與「劇情伏筆/暗線」，不偏廢
- 對全新建檔的實體做合理的風格擴寫，避免之後敘事深入時的風格漂移
- 標題與措辭跟實體實際分類/名稱一致

## 非目標

- 不引入 wikilink `[[ ]]` 語法或任何 recall 索引層的解析/反向連結邏輯（評估後與目前 chunk+embedding 機制無關，留待之後視需要再開）。
- 不改變「是否生成 secrets.md」的判斷邏輯——維持現狀，所有道具/場景/技能首次接觸都生成一次。

## 設計

### 1. 語言與用詞規範

在 `callLoreRewrite`（[lore-rewrite.ts:54](../../../app/src/engine/turn/lore-rewrite.ts)）與 `generateItemSecrets`（重新命名為 `generateEntitySecrets`，見第 4 點）的 system prompt 鐵則中加入：

> 一律使用繁體中文書寫；避免使用中國大陸簡體中文慣用詞彙（例如「質量」→「品質」、「視頻」→「影片」、「軟件」→「軟體」、「信息」→「資訊」、「打印」→「列印」等），用詞符合台灣繁體中文書寫習慣。

`generateItemSecrets` 原本已有「繁體中文」字樣，這次補上用詞規範；`callLoreRewrite` 原本完全沒提語言要求，這次補齊。

### 2. 各分類的「一般說明大綱」

`callLoreRewrite` 簽名新增 `category: "npc" | "item" | "location" | "skill" | "dungeon"` 參數。System prompt 依 category 插入對應大綱，引導模型涵蓋玩家會想知道的基本面向（純引導、不是強制 JSON 欄位，wiki.md 維持自由格式 Markdown 的既有約定）：

- **item（道具）**：外觀與基本辨識、已知效果/用途（玩家視角已知的）、取得或使用方式/限制、目前已知的來歷或關聯人物事件（僅寫敘事中**已揭露**的部分）
- **location（場景）**：地理/環境描述、已知規則或機關（已揭露部分）、已知危險與資源、出沒生物或 NPC
- **skill（技能）**：效果說明、施展條件/限制、已知代價或副作用、取得方式
- **npc**：基本資訊（外觀/身份/性格）、與主角的關係、已知情報（自述/可驗證情報）、備註/未解疑點——對齊現有角色檔案（如 `world/characters/chenzhe.md`）已經在用的結構
- **dungeon**：已揭露地圖/環境、已知規則或機關、已知危險與資源、相關人物事件

大綱後統一附加提醒：

> 以上只列出常見的可寫面向，不是每筆都要填滿；本回合片段沒提到、也沒有合理依據可擴寫的面向不要硬湊。

呼叫端調整：
- `rewriteLoreEntity`（[lore-rewrite.ts:104](../../../app/src/engine/turn/lore-rewrite.ts)）依 `entity.category` 傳對應 category 給 `callLoreRewrite`。
- `runLoreSync` 裡處理 `dungeon_wiki_excerpt` 那段（[lore-sync.ts:91-97](../../../app/src/engine/turn/lore-sync.ts)）傳 `"dungeon"`。

### 3. 全新建檔 vs 更新既有文件：擴寫邊界

把 `callLoreRewrite` 鐵則中「不可發明片段未提及的事實」拆成兩種情境（模型可從 user message 既有的「現有文件全文 / 目前沒有現有文件，這是全新建檔」字樣判斷自己屬於哪種情境，不需要新增參數）：

- **全新建檔**：可以在**風格/氛圍類細節**上做簡單合理的擴寫——視覺風格、材質、光線、氣味、（道具）外觀質感等，讓內容有畫面感、之後好沿用。**不可**發明會卡住劇情走向的具體事實：真正用途、特殊機關、隱藏效果、與主線人物事件的關聯——這些留給之後敘事片段揭露，或由 `secrets.md` 暗線承接。
- **更新既有文件**：維持原規則，只在片段明確提供新資訊/訂正時才改動對應部分；**本次（或之前）擴寫過的風格細節從此視為既定事實，不可無故更動**。

效果：例如「醫療室」第一次只是被順口一提，Layer 3 會給它定一個自洽的風格基調（科幻/老舊/簡陋等，依世界基調合理判斷），下次劇情真正深入時，模型重寫 wiki 會看到上次定的風格並延續，不會風格漂移或前後矛盾。

### 4. 順手修正

- **wiki 標題用 name 不用 id**：[lore-rewrite.ts:138](../../../app/src/engine/turn/lore-rewrite.ts) 改成 `` `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.name}）` ``（原本誤用 `entity.id`）。
- **`generateItemSecrets` 泛化為 `generateEntitySecrets`**：新增 `category: "item" | "location" | "skill"` 參數，比照 `ENTITY_CATEGORY_TITLE` 的模式建一份「設計者角色」對照表（道具設計者/場景設計者/技能設計者），system prompt 依 category 套用正確措辭與「道具名稱/場景名稱/技能名稱」字樣。呼叫端 `rewriteLoreEntity`（[lore-rewrite.ts:135](../../../app/src/engine/turn/lore-rewrite.ts)）傳入 `entity.category`。

## 影響範圍

- `app/src/engine/turn/lore-rewrite.ts`：`callLoreRewrite` 簽名加 `category` 參數；`generateItemSecrets` → `generateEntitySecrets` 加 `category` 參數；`rewriteLoreEntity` 內兩處呼叫更新；標題 bug 修正。
- `app/src/engine/turn/lore-sync.ts`：`runLoreSync` 呼叫 `callLoreRewrite` 處理 dungeon 時補上 `"dungeon"` category。
- 不動 `app/src/engine/schema.ts`、`app/src/engine/lore.ts`、`app/src/recall/`。
- 既有測試（`lore-rewrite.test.ts`、`lore-sync.test.ts` 等，若存在）需要同步調整呼叫簽名與斷言。

## 測試計畫

- `generateEntitySecrets`：對 item/location/skill 三種 category 各驗證 system prompt 含對應措辭（道具設計者/場景設計者/技能設計者），且不再寫死「道具」。
- `callLoreRewrite`：對每個 category 驗證 system prompt 含對應大綱關鍵字；驗證語言規範字樣存在；驗證「全新建檔可擴寫風格、不可發明劇情事實」與「更新既有文件鎖定既定事實」兩段規則文字存在。
- `rewriteLoreEntity`：驗證最終 `title` 使用 `entity.name` 而非 `entity.id`；驗證呼叫 `callLoreRewrite`/`generateEntitySecrets` 時傳入正確的 `category`。
- 既有測試保持綠燈（簽名變更後的呼叫端調整需同步更新測試 mock）。
