# 劇情節奏停滯偵測與 Nudge 注入設計

## 背景

LLM 驅動敘事在「無限恐怖」這種長線、自由行動的遊玩模式下，容易出現兩種節奏問題：

1. **短期鬼打牆**：連續幾回合沒有實質劇情/狀態進展（反覆描寫「觀察」、戰鬥卡住沒有傷害變化）。即使玩家輸入只是「繼續」這類不帶明確意圖的詞，停滯判定也該照樣運作——鬼打牆是「故事本身沒進展」，跟玩家有沒有表態無關。
2. **長期節奏失衡**：單回合內看不出來，要拉長時間跨度才看得出來的節奏問題，例如「已經離開副本 10 回合了，主空間一直沒有明確事件，該插入支線或開啟下一個副本了」。這需要「劇本大師」視角，依長期歷史摘要＋近期走勢做主觀判斷，不是單回合規則能判斷的。

目前的回合管線（`buildMainSpaceMessages`／`buildDungeonMessages`／`runTurnLoop`，見 `app/src/engine/turn/`）沒有任何停滯偵測或節奏控制機制，也沒有任何跨回合的歷史摘要索引——`AUTO_ADVANCE_MAX`（預設 4，`app/.env.example`）只是防止自動推進迴圈跑到無限長的安全閥，跟劇情有沒有進展無關。

這份設計提供**兩個獨立但共享同一份歷史資料的機制**：規則式的短期停滯偵測（每回合都跑，幾乎零成本），和 LLM 式的長期節奏審閱（每 K 回合跑一次，成本攤提）。

## 已否決的方向（及原因，避免重新討論同一條死路）

- **每回合都跑一個獨立判斷 LLM**：同步延遲在自動推進迴圈裡是乘法累積（迴圈跑 4 回合就多 4 次呼叫），且跟「nudge 要插在哪一回合」的時序對不上——若放在迴圈外才注入，玩家輸入可能已經改變方向，nudge 反而誤導。**注意**：這條否決只針對「每回合」頻率；下方的長期節奏審閱是每 K 回合（預設 10）才跑一次 LLM，成本攤提後可接受，不違反這條否決。
- **用 `now.md` 的 `chapter` 欄位當「是否合理停滯（例如 boss 戰）」的豁免依據**：不可靠。Schema 裡沒有 boss/小怪分類欄位，且角色戰力會隨遊玩膨脹，同一個副本表面 boss 前期是硬仗、後期可能變雜魚，標籤本身會失真。
- **新增一個欄位給敘事 LLM 自己回報「有沒有進展」**：自報式判斷有動機問題（LLM 不會誠實承認自己在水戰鬥），且重複輸出新欄位是多餘的——`commit_summary`（`app/src/engine/schema.ts:47-56`）本來就是每回合必填的一句話敘事摘要，已經逐回合進 git log，可以直接重用，不需要新欄位、不需要額外 append 動作。
- **比對「玩家輸入」與「本回合 commit_summary」是否相符（無論用關鍵字或 embedding 相似度），來判定『輸入有沒有被回應』，並以此作為觸發條件**：這會把「敘事是否照著玩家字面意圖走」錯誤地當成「故事有沒有進展」的代理指標——敘事 LLM（劇本大師）對長期節奏該有自己的主觀判斷與經營空間，不該被綁著去匹配玩家輸入的字面意圖（敘事可能選擇用不同方式升級張力，那不算迴避）。更根本的問題是：玩家輸入「繼續」這類不帶意圖的詞時，這條規則完全失能，但鬼打牆判定不該因為玩家沒表態就停擺。玩家輸入因此被降級為**附加方向提示**（見短期規則的「輸出」），不參與觸發判斷。

## 目標

在組裝**當前這一回合**的主敘事 prompt 之前（主空間與副本兩種模式都要）：

1. **短期停滯規則**（每回合都跑）：多數時候回傳空字串（無建議），幾乎零成本；偵測到重複時，回傳一句模板化的節奏建議文字。
2. **長期節奏審閱**（每 K 回合跑一次，K 預設 10，讀取 .env 參數）：用一支獨立的「劇本大師」LLM 呼叫，讀歷史摘要做主觀的節奏判斷（例如該不該插支線/開副本），輸出一段建議文字。

兩者都當場注入正在組裝的 `buildMainSpaceMessages()`／`buildDungeonMessages()` system prompt，各自獨立成一個區塊（`nudgeBlock`／`pacingBlock`），互不覆蓋。

關鍵設計原則：**兩者的產生與消費都在同一輪迴圈迭代內完成**，不存在「算出建議→存起來→等下一回合才能用」的跨回合搬運問題。**主空間與副本都要接**——背景提到的戰鬥停滯，多半實際發生在副本回合（`runDungeonTurn`／`buildDungeonMessages`），只接主空間無法解決最核心的案例。

## 共用基礎：`world/journal_summary.md`

兩個機制都需要跨回合的歷史摘要，且都需要在伺服器重啟後仍然有效（不能像純 in-memory 狀態一樣重啟就清零），所以新增一份持久化、append-only 的摘要索引：

- **路徑**：`world/journal_summary.md`，跟 `journal.md`／`dungeons/<id>/runs/*.md` 同層級，屬於 `world/`，每回合自動 commit 時一併進 git。
- **格式**：每回合一行，跨主空間/副本統一時間線（不像 `journal.md` 按模式分檔），方便兩個機制讀「最近 N 筆」或「最近 K 筆」時不用分別讀兩種來源再合併。時間標記用**到秒的 ISO timestamp**（不是 `today`/`YYYY-MM-DD` 這種日期粒度）——同一天可能多次遊玩、甚至短時間內自動推進好幾回合，純日期無法分辨先後與唯一性：
  ```
  - [2026-06-23T14:32:05] (主空間) 沈奕在安全區整理裝備，發現背包裡多了一張陌生符紙
  - [2026-06-23T14:33:41] (副本:abandoned-hospital) 葉晴擊倒第一個喪屍，但走廊深處傳來更多腳步聲
  ```
  `(主空間)` 或 `(副本:<dungeonId>)` 標出模式，讓長期審閱能自己數「已經離開副本幾回合」，不需要引擎額外維護一個計數器。
- **寫入點**：`turn-core.ts` 裡，`summary`（`turn-core.ts:60`）算出來、Layer 2 落地完成後，呼叫新增的 `appendJournalSummary(worldDir, { timestamp, mode, summary })`（新檔案，例如 `app/src/engine/journal-summary.ts`，append-only 風格對齊既有 `journal.ts` 的 `appendJournal`）。`timestamp` 用新增的 `nowISOSeconds()`（`app/src/engine/turn/shared.ts`，`new Date().toISOString().slice(0, 19)`，獨立於既有只到日期粒度的 `todayISO()`，不影響其他既有呼叫端）。`mode` 由 `plan.dungeonId` 是否存在判斷：有則 `副本:${plan.dungeonId}`，否則 `主空間`。
- **定位**：這是 canonical 的衍生摘要索引（不是劇透文件，不是玩家直接會讀的敘事），但因為要跨重啟存活、且本質上只是「逐回合 `commit_summary` 的時間線」，比照 `journal.md` 的「raw log 用檔案 append」慣例處理，進 git。

## 機制一：短期停滯規則

### 偵測邏輯

- 每回合讀 `world/journal_summary.md` 的最後 N 行（N 預設 5，可調），用 `app/src/recall/embedder.ts` 既有的 `createLocalEmbedder()`（本地嵌入模型，非聊天 LLM 呼叫）把這 N 行的 `commit_summary` 部分轉成向量。
- 計算這 N 筆之間的 cosine similarity；連續高度重複（高於門檻，門檻為可調參數，需要實際遊玩後 empirical tune）時，視為停滯訊號。
- **不維護任何 in-memory 狀態**——每回合都是現算現查 `journal_summary.md` 的最後 N 行，天然跨重啟存活，不需要額外的 service 物件持有滾動窗口。
- 純規則式向量比較，不呼叫聊天 LLM，符合「不引入第三個獨立 LLM agent」的限制；重用 `app/src/recall/` 既有基礎設施，不需要額外引入新的相似度計算依賴。
- 不讀 `setting.md`/`gm-notes.md`/角色檔：避免無關背景稀釋判斷焦點。
- **已知限制**：這是粗 heuristic，不是精確判斷。「`commit_summary` 之間相似度高」是「故事沒進展」的代理指標，不是充要條件；接受這個誤判成本，因為命中後的後果只是注入一句溫和建議文字，不影響既定事實或 canonical 數值。

### 輸出

- 空字串（預設、多數情況）。
- 命中時回傳模板化建議文字，不需要 LLM 生成；若「最近一筆真實玩家輸入」（排除自動推進的系統 placeholder，見 `AUTO_CONTINUE_INPUT`，由呼叫端從 `input` 參數直接取得，不需要額外儲存）存在，夾帶進去當方向提示（僅供敘事 LLM 參考，不是指令）：
  > 最近幾回合的劇情進展趨於重複，這回合請讓故事有實質推進（事件發生、衝突結果、新資訊揭露等）。（若有參考價值）玩家最近表達的方向：「<最近一筆真實玩家輸入>」。

### 觸發點

- 沿用既有 `app/src/engine/turn/context-blocks.ts` 的 pattern（`runPrePassBlock`/`runRecallBlock`）：新增 `runNudgeBlock(deps, input, log?)`，內部讀 `journal_summary.md` 尾段、跑 embedding 相似度比較，回傳格式化後的 `nudgeBlock` 字串。
- 在 `runMainSpaceTurn` 與 `runDungeonTurn`（`app/src/engine/turn/index.ts`）裡，於組裝 `plan.messages` 之前呼叫 `runNudgeBlock`，把結果傳進 `BuildMessagesParams`（新增 `nudgeBlock?: string` 欄位），用既有 `appendOptionalBlocks` 機制串接到 system prompt 尾端——跟 `intentsBlock`/`recallBlock` 完全同一套接法。

## 機制二：長期節奏審閱（劇本大師）

### 觸發頻率

- 每 K 回合跑一次（K 預設 10，可調），用 `world/journal_summary.md` 的**總行數 mod K**判斷是否該觸發，不需要額外持久化計數器——行數本身就是回合序號。
- 其餘回合直接回傳空字串，不呼叫 LLM。

### 輸入

- `world/journal_summary.md`（讀尾段，例如最近 30~50 筆，避免無上限增長後 context 過大；確切上限留給實作階段依實測調整）。
- 當前 `now.md` 的 canonical 局勢快照（複用 `prompts.ts` 既有的 `canonicalBlock()`）。
- 當前模式（主空間／副本，含副本 id）：讓 LLM 知道自己現在是該建議「插支線/開副本」還是副本內的節奏調整（例如「這層拖太久，該讓劇情升級」），不需要為兩種模式寫兩套 prompt，由 LLM 依當前模式自行判斷該給哪種建議。

### 輸出

- 一段自由文字的節奏建議（非 JSON、非結構化欄位），由獨立 LLM 呼叫產生（非串流，取完整回應）。
- 失敗或回應為空時降級為空字串。

### Persona／Prompt 方向

- System prompt 賦予「劇本大師」視角：依長期歷史摘要與近期走勢，主觀判斷節奏是否需要調整（插支線、催促進副本、副本內升級張力等），輸出給敘事 LLM 參考的一段建議，**不是指令、不直接改變 canonical 狀態**——跟短期規則一樣，最終是否採納由敘事 LLM 自行決定。
- 明確提醒：不可建議揭露 `gm-notes.md`/`secrets.md` 等尚未揭露的暗線（這份審閱不讀這兩份劇透文件，天然不會碰到，但 prompt 仍應提醒避免建議「提前揭露真相」這種泛泛而談的內容）。

### 觸發點與 wiring

- 新增 `runPacingBlock(deps, state, log?)`，放在 `context-blocks.ts` 同一套 pattern 裡，內部判斷行數 mod K、組 prompt、呼叫 LLM、回傳 `pacingBlock` 字串。
- LLM client：新增 `TurnDeps.pacingClient?: LlmClient`，未提供時退回 `deps.controlClient ?? deps.client`（對齊現有 `controlClient`/`loreClient` 的退回慣例）。
- `BuildMessagesParams` 新增 `pacingBlock?: string`，跟 `nudgeBlock` 一樣走 `appendOptionalBlocks`，**獨立成另一個區塊**，不與短期規則的 `nudgeBlock` 合併（兩者性質不同：一個是短模板文字、一個是 LLM 生成的長段落，分開讓 prompt 結構清楚、也方便分別測試與排錯）。
- 在 `runMainSpaceTurn` 與 `runDungeonTurn` 裡，跟 `runNudgeBlock` 一起、在組裝 `plan.messages` 之前呼叫。

## 不變的部分

- `FastControlSchema`/`LoreSyncSchema`（`schema.ts`）欄位定義不變，不新增欄位。
- 機率擲骰、raw 層落地、`now.md` 覆寫、wiki 提煉、commit 時機等下游邏輯完全不變。
- 不引入「每回合」跑的第三個聊天 LLM agent；短期規則只呼叫本地 embedding 模型，長期審閱是每 K 回合才跑一次的聊天 LLM 呼叫，頻率攤提後可接受。
- `character-pre-pass.ts`（NPC 意圖 pre-pass）不受影響。
- `BuildMessagesParams`（`prompts.ts`）新增 `nudgeBlock?: string` 與 `pacingBlock?: string`，走既有 `appendOptionalBlocks` 機制，`buildMainSpaceMessages`／`buildDungeonMessages` 兩處的呼叫端都要傳。

## 錯誤處理與降級

- 短期規則（embedding 推論失敗、比對邏輯拋例外等）與長期審閱（LLM 呼叫失敗、逾時、回應為空）都各自獨立降級為「回傳空字串」，絕不能讓任一機制影響主回合管線的正常產出；兩者互相獨立，一個失敗不影響另一個。
- `journal_summary.md` 寫入失敗（極端情況，如磁碟問題）：應 log 警告但不擋下本回合既有的 `commit()` 流程；下一回合的短期/長期判斷會因為這一筆缺失而暫時失準，這是可接受的降級（跟既有 `pendingLoreSync`/recall 失敗時的「不影響主流程」原則一致）。

## 測試策略

- 短期規則（`runNudgeBlock`，注入假的 embedder stub，回傳固定/可控向量，不依賴真實本地模型載入）：
  - 讀取 `journal_summary.md` 尾段 N 行的邏輯正確（檔案不存在/行數不足 N 時不誤觸發）。
  - 給定連續高相似度向量，應觸發；給定有差異的向量，不應觸發。
  - 命中時若呼叫端傳入「最近一筆真實玩家輸入」，建議文字應包含該輸入；沒有則建議文字仍正常產出，只是不含方向提示那一句。
- 長期審閱（`runPacingBlock`，注入假的 LLM client stub）：
  - 行數 mod K ≠ 0 時不呼叫 LLM，回傳空字串。
  - 行數 mod K === 0 時呼叫 LLM，回傳其輸出內容。
  - LLM 呼叫失敗時降級為空字串，不拋出例外。
- `journal-summary.ts`：`appendJournalSummary` 正確 append 一行、格式符合 `- [timestamp] (mode) summary`（timestamp 到秒）。
- `turn.test.ts`：
  - 驗證 `nudgeBlock`／`pacingBlock` 命中時確實出現在主空間與副本兩種模式的 system prompt 裡，且兩者不互相覆蓋。
  - 驗證每回合 `commit` 完成後 `journal_summary.md` 確實多了一行，內容對應本回合 `summary`。
  - 驗證任一機制異常時不影響該回合敘事正常產出。

## 範圍外

- 不對玩家輸入做任何意圖分類、關鍵字比對或相似度比對；玩家輸入只作為短期規則命中時 nudge 文字裡的方向提示，不參與觸發判斷。
- 不改變現有自動推進迴圈的終止條件（`awaiting_user_input`/`AUTO_ADVANCE_MAX`）。
- 不在 `now.md`/`threads` 等「玩家可見的提煉頁」記錄 nudge/pacing 觸發歷史；`journal_summary.md` 是給機制讀的衍生索引，不是給玩家讀的敘事文件。
- 長期審閱不讀 `gm-notes.md`/`dungeons/<id>/secrets.md`，不參與劇透文件的揭露判斷，只專注節奏建議。
- 不做多 process/多 worker 間的審閱頻率協調（K 回合計數來自共用檔案行數，多 process 部署下若同時寫入可能有 race，但目前單 process 架構下不是問題，暫不在本次範圍內處理）。
- **不做 `journal_summary.md` 的第二層壓縮**（例如超過 100 筆後，把最舊的 20 筆壓成一則小總結、append 到另一份摘要檔）：v1 先讀尾段 30~50 筆，檔案本身無上限增長，但讀取永遠只看尾段、不會因檔案變長而變慢或讓 context 爆掉，現階段不是急迫問題。等實際遊玩跑出真正的長期歷史（數百回合以上）、且確認長期審閱真的需要比尾段 50 筆更久以前的脈絡時，再評估要不要做這層壓縮，避免現在就為了還沒發生的規模問題引入新檔案與壓縮邏輯。
