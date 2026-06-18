---
name: enter-dungeon
description: Start (or resume) a dungeon run. Creates a branch and PR for the run, sets up the run log, and begins the narrative dialogue strictly following world/setting.md and the current character/dungeon state. Use when the user asks to enter a dungeon, start a new 副本, or re-enter a previously visited dungeon — and also use proactively, without waiting for user request, when the ongoing story (in start-story main-space dialogue) reaches a point where the setting's 主神/系统 forcibly pulls the protagonist into a dungeon (半強制進入機制).
---

# enter-dungeon

開啟一次副本「進入」。一次進入 = 一個 git branch + 一個 PR，整個副本期間的劇情對話都發生在這個 branch 上，並以 commit 的形式逐步落地成 log。

## 觸發方式

副本進入在無限恐怖設定裡通常是**半強制**的，兩種觸發路徑都要支援，不要預設只有使用者主動要求才能進：

- **使用者主動要求**：直接進入下面的步驟。
- **劇情強制觸發**：在 `start-story` 的主空間對話中，依 `world/setting.md` 的規則判斷「系統/主神宣布即將開啟副本、時間到、或強制傳送」時，由 LLM 自己判斷該呼叫本 skill，不必等使用者下指令。觸發前先用一兩句敘事給出「察覺到副本即將開啟」的過渡（例如系統提示音、空間震動），再正式進入步驟 1，避免沒有任何預警就硬切場景。

## 步驟

1. **確認副本身份**：
   - 新副本：與用戶商定 `dungeon-id`（短英文/拼音 slug）。**第一次進入**時，仿照 `init-world` 的隱藏設定模式，自主生成 `world/dungeons/<dungeon-id>/secrets.md`（副本真正的機關原理、暗藏的轉折、NPC 的真實動機等），**不跟用戶討論或預覽**，寫完即可開始敘事；只有故事裡真的揭露到的部分才會進到 `wiki.md`。
   - 已存在的副本（重新進入）：讀取 `world/dungeons/<dungeon-id>/wiki.md`（已揭露的既有事實，不可矛盾）與 `world/dungeons/<dungeon-id>/secrets.md`（尚未揭露的真相，僅供保持暗線一致，不可提前講出來）。
2. **讀取必要狀態**（不要讀多餘文件）：
   - `world/setting.md`（系統規則、新手保護）
   - `world/gm-notes.md`（世界隱藏真相，保持暗線一致用，不可提前劇透）
   - `world/characters/index.md` → 按需再讀相關 `world/characters/<id>.md`
   - `world/dungeons/<dungeon-id>/wiki.md`、`secrets.md`（若存在）
3. **建立 branch + run 目錄**：
   - 新建分支，例如 `dungeon/<dungeon-id>/<run-id>`（`run-id` 用日期或序號，例如 `run-3`）。
   - 建立 `world/dungeons/<dungeon-id>/runs/<run-id>.md`，文件開頭寫明：進入時間、當前角色狀態摘要、本次副本目標（若已知）。
4. **開 PR**：以草稿/進行中狀態開 PR，標題包含 dungeon-id 與 run-id，方便辨識。
5. **開始敘事**：
   - 嚴格依據 `world/setting.md` 與角色檔案敘事，不可憑空更改已設定的規則、屬性數值。
   - 凡是涉及機率判定（技能命中、暴擊、隨機事件、NPC 反應等），**必須**調用 `roll-random` skill 取得真實隨機數，禁止直接用文字「演」出結果。
   - 每個回合結束跑「回合收束協議」（見下方專節），逐回合 append + commit，不要等到最後一次性寫完。
6. **副本結束的判定**（通關 / 死亡 / 中途撤退）由敘事內容自然產生。結束後呼叫 `settle-dungeon` skill 處理結算與合併，不要自己手動改 `characters/*.md` 或 `wiki.md`。

## 回合收束協議（副本內每個敘事回合結束時執行）

每個敘事回合**結束時**依序執行；步驟 2–4 為條件式，本回合沒對應變動就略過。

**敘事前（query）**：重提任何已存在 NPC 前，先看 `world/characters/index.md` 的「鎖定事實」，細節不足才 Read 完整角色檔。機率判定一律先呼叫 `roll-random`，再依數值敘事。

1. **記錄（raw 層）**：把本回合關鍵敘事＋骰子結果 append 到 `world/dungeons/<dungeon-id>/runs/<run-id>.md`，段落開頭帶時間戳 `## [YYYY-MM-DD] <一句標題>`。append-only，不改舊段。
2. **提煉（wiki 層）**：把本回合**實際發生**且**已在劇情中揭露**的狀態變動寫進 canonical 檔——`world/characters/protagonist.md`、出場 NPC 的 `world/characters/<id>.md`、`world/dungeons/<dungeon-id>/wiki.md`（只寫已揭露的地圖/機關/規則，嚴守 `secrets.md`，未揭露不寫）。
3. **索引（index 層）**：若本回合**新出現**一個重要 NPC/實體，在 `world/characters/index.md` 加一行＋一段「鎖定事實」。
4. **提交（git 層）**：commit 到副本 branch，message 一句摘要。

> 注意：角色屬性/積分的「最終結算」仍由 `settle-dungeon` 統一處理（步驟 6）。回合中只記錄已明確發生的變動，不要在副本中途自行做新手保護等結算判定。

## 注意

- 死亡也算「副本結束」，**不是**要放棄這個 PR——仍然走 `settle-dungeon` 流程合併回 main（新手保護機制由結算規則處理，而不是靠不合併來逃避後果）。
- 同一 dungeon-id 可以有多個 run-id（多次進入），`wiki.md` 在多次 run 間累積延續，`runs/*.md` 彼此獨立、append-only。
- `secrets.md` 只在第一次進入該 dungeon-id 時生成一次，之後重複進入不要重新生成或覆寫，只能由 `settle-dungeon` 視劇情揭露程度補充到 `wiki.md`。
