---
name: start-story
description: Switch into in-character narrative mode for main-space (主神空间/安全区) dialogue between dungeon runs - status checks, point exchanges, NPC interactions, deciding what's next. Use when the user wants to begin or continue the story outside of a dungeon run, as opposed to repo-maintenance conversations (editing CLAUDE.md, skills, git operations) which stay in normal assistant mode.
---

# start-story

這個 skill 是「切換成劇情模式」的入口，用來跟一般的倉庫維護對話（例如改 CLAUDE.md、調整 skill、討論架構）區分開——維護對話不代入角色，劇情模式才嚴格代入 `world/setting.md` 的主神/系統語氣與主角第一視角。

副本之間的「主空間」時間（兌換積分、休整、NPC 互動、決定下一步）不需要開 branch/PR，直接在當前分支（通常是 main）上對話與 commit 即可；只有進副本才需要 `enter-dungeon` 的 branch+PR 流程。

## 步驟

1. **讀取必要狀態**（不要讀多餘文件）：
   - `world/now.md`（**resume 第一手**：當前篇章、此刻場景、在場同伴、進行中的副本、下一步；接劇情先讀這份，不要去讀整份 `journal.md`）
   - `world/setting.md`
   - `world/gm-notes.md`（保持暗線一致用，**不可**在對話中提前講出尚未揭露的內容）
   - `world/characters/index.md` → 按需再讀相關 `world/characters/<id>.md`
   - 若 `now.md`「進行中的副本」欄**不是「無」**：先用一兩句過渡敘事，再呼叫 `enter-dungeon` 接續該 `<dungeon-id>` + `<run-id>` 的 run，不要在主空間硬接副本劇情。
2. **代入敘事**：以 `world/setting.md` 定義的主神/系統語氣與主角視角推進對話，不可憑空更改已設定的規則、屬性數值。機率事件一律先呼叫 `roll-random`。
3. **每回合結束跑「回合收束協議」**（見下方專節）：把本回合的記錄、狀態提煉、索引更新、提交一次做完，不留「之後再收斂」的延遲點。
4. **偵測強制進入副本**：依 `world/setting.md` 規則，若劇情發展到系統/主神宣布開啟副本、強制傳送等節點，主動呼叫 `enter-dungeon`（不必等使用者明確說「我要進副本」）；使用者也可以隨時主動要求進入某個副本。

## 回合收束協議（每個敘事回合結束時執行）

每個敘事回合**結束時**依序執行；步驟 2–3 為條件式（本回合沒對應變動就略過），步驟 1、4、5 每回合都做。

**敘事前（query）**：重提任何已存在 NPC 前，先看 `world/characters/index.md` 的「鎖定事實」，細節不足才 Read 完整角色檔；不要憑印象派生設定。機率事件一律先呼叫 `roll-random`。

1. **記錄（raw 層）**：把本回合關鍵敘事＋骰子結果 append 到 `world/journal.md`，段落開頭帶時間戳 `## [YYYY-MM-DD] <一句標題>`。不重寫舊段，只增。
2. **提煉（wiki 層）**：把本回合**實際發生**的狀態變動寫進 canonical 檔——`world/characters/protagonist.md`（積分／屬性／技能／物品／buff-debuff）、出場 NPC 的 `world/characters/<id>.md`（關係／狀態變化）。
3. **索引（index 層）**：若本回合**新出現**一個 NPC/實體，在 `world/characters/index.md` 加一行＋一段「鎖定事實」。
4. **更新提煉頁（覆寫 `world/now.md`）**：覆寫（不是 append）七個欄位，反映本回合結束後的當前局勢；保持精簡（≤50 行），不要把 journal 內容塞進來。
5. **提交（git 層）**：commit 到當前分支（主空間不需要 PR），message 一句摘要，不要把整段敘事塞進 message。

## 敘事語言規範

- **全程使用繁體中文 + 台灣用詞**，禁止簡體習慣用詞混入。常見地雷：「信息」→「資訊」、「視頻」→「影片」、「軟件」→「軟體」、「網絡」→「網路」、「質量」（指品質時）→「品質」、「內存」→「記憶體」。輸出前自查一遍用詞。
- 旁白與對話都要用繁體；面板/系統提示文字也用繁體。

## 敘事節奏與人物一致性

- **開場/重大設定衝擊不要一步到位陳述完**：被選中、傳送、面板出現這類衝擊，先給感官細節與主角情緒反應（混亂、恐懼、抗拒、好奇……），再帶出機制說明，不要旁白直接條列規則。
- **新機制（面板、兌換、系統對話）第一次出現時放慢**：讓主角有摸索、驚訝、遲疑的反應，不要表現得像主角早已熟悉這套規則。
- **人物一致性**：每次引入或重新提及一個 NPC 前，先確認這個人之前的外觀/身份/名字描述（必要時重讀 `world/characters/<id>.md` 或回顧對話上文），不要憑印象重新「派生」一個新設定給同一個人，也不要把不同人的特徵混到一起。如果記不清前文設定的細節，寧可少寫細節，不要編造可能矛盾的內容。
- **場景邏輯要交代清楚**：道具/機關的觸發條件如果對不同角色有不同反應（例如某扇門有人推不開、主角一靠近就開），要在敘事中給出可被理解的原因，不能毫無解釋地前後矛盾。

## 注意

- 本 skill 不處理副本內的敘事（那是 `enter-dungeon` 之後的事），只處理副本之間的常態劇情。
- 若使用者的請求明顯是倉庫維護性質（改文件結構、討論 skill 設計），不要套用本 skill 的角色代入語氣，正常以助理身份回應即可。
