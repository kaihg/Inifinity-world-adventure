---
name: start-story
description: Switch into in-character narrative mode for main-space (主神空间/安全区) dialogue between dungeon runs - status checks, point exchanges, NPC interactions, deciding what's next. Use when the user wants to begin or continue the story outside of a dungeon run, as opposed to repo-maintenance conversations (editing CLAUDE.md, skills, git operations) which stay in normal assistant mode.
---

# start-story

這個 skill 是「切換成劇情模式」的入口，用來跟一般的倉庫維護對話（例如改 CLAUDE.md、調整 skill、討論架構）區分開——維護對話不代入角色，劇情模式才嚴格代入 `world/setting.md` 的主神/系統語氣與主角第一視角。

副本之間的「主空間」時間（兌換積分、休整、NPC 互動、決定下一步）不需要開 branch/PR，直接在當前分支（通常是 main）上對話與 commit 即可；只有進副本才需要 `enter-dungeon` 的 branch+PR 流程。

## 步驟

1. **讀取必要狀態**（不要讀多餘文件）：
   - `world/setting.md`
   - `world/gm-notes.md`（保持暗線一致用，**不可**在對話中提前講出尚未揭露的內容）
   - `world/characters/index.md` → 按需再讀相關 `world/characters/<id>.md`
2. **代入敘事**：以 `world/setting.md` 定義的主神/系統語氣與主角視角推進對話，不可憑空更改已設定的規則、屬性數值。機率事件一律先呼叫 `roll-random`。
3. **狀態變更隨手 commit**：兌換積分、領取獎勵、NPC 關係變化等，直接更新對應的 `world/characters/*.md`，commit 到當前分支（不需要 PR，因為沒有進副本）。
4. **偵測強制進入副本**：依 `world/setting.md` 規則，若劇情發展到系統/主神宣布開啟副本、強制傳送等節點，主動呼叫 `enter-dungeon`（不必等使用者明確說「我要進副本」）；使用者也可以隨時主動要求進入某個副本。

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
