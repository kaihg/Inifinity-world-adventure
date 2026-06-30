# 設計：wiki-llm 回合收束協議與一致性流程

- 日期：2026-06-19
- 狀態：已通過 brainstorming 討論，待實作
- 參考：Karpathy「LLM wiki」模式（ingest → query → lint、markdown 為底材、git 為版本控制、LLM 為維護常駐程序）

## 1. 背景與要解決的問題

本 repo 是「無限流」小說的文本保存站，所有世界狀態以 Markdown 存於 `world/`，git 歷史即故事版本記錄（見 `CLAUDE.md`）。經討論，現行設計有兩個真正的阻礙：

1. **狀態更新紀律沒有著力點**：`start-story` 只在被呼叫當下把指令塞進 context，長對話後指令被稀釋，「隨手 commit 狀態」全靠 LLM 自律，容易漏。沒有 mode 旗標、也沒有主空間的結帳點。
2. **人物/劇情一致性缺乏保障機制**：重提 NPC 時可能憑印象派生出矛盾設定；敘事揭露可能牴觸既定事實，且沒有任何合併前的檢查。

關鍵約束（討論中確認，不可違背）：

- 角色狀態與 wiki 是 canonical truth，**必須是可讀、可 diff、可合併的 Markdown**——排除 sqlite/JSON 化。
- 不引入會製造「第二個真相來源」的機制（排除 agentmemory）。
- 不引入需要靠紀律維護的額外狀態（排除 mode 旗標）。
- 一致性工具不適用程式碼索引（排除 codegraph）。

## 2. 設計原則：Karpathy wiki-llm 三層對映

| wiki-llm | 本 repo |
|---|---|
| Raw sources（不可變輸入） | `world/dungeons/<id>/runs/*.md`（副本）、`world/journal.md`（主空間，**新增**） |
| Wiki（LLM 維護、cross-link） | `world/characters/*.md`、`world/dungeons/<id>/wiki.md` |
| Schema（維護規則） | `CLAUDE.md`、`world/setting.md`、`.claude/skills/*` |
| index.md（每次更新的目錄） | `world/characters/index.md` |
| log.md（append-only、時間戳） | `runs/*.md`、`world/journal.md` |
| ingest → query → lint | 回合收束協議 → 敘事前先讀 canon → settle 一致性檢查 |
| typed edges（contradicts/extends） | 既有的「隱藏層 vs 揭露層」：`gm-notes.md`/`secrets.md` ↔ `setting.md`/`wiki.md` |

理念：**人類出題與策展，LLM 做簿記**；維護負擔趨近零，因為 LLM 不會忘記更新交叉引用。

## 3. 變更清單

### 變更 1（核心）：回合收束協議

在 `start-story` 與 `enter-dungeon` 兩個 skill 都寫死同一套固定清單，每個敘事回合**結束時**依序執行。步驟 2–4 為**條件式**（無變動則略過），多數回合很輕。

**敘事前（query 階段）**：重提任何 NPC 前，先讀 `characters/index.md` 的「鎖定事實」；細節不足才 Read 完整角色檔。機率事件一律先呼叫 `roll-random`。

**回合結束（收束）**：

1. **記錄（raw 層）**：把本回合關鍵敘事＋骰子結果 append 到原始 log，段落開頭帶時間戳，格式 `## [YYYY-MM-DD] <一句標題>`。
   - 副本中：append 到 `world/dungeons/<id>/runs/<run-id>.md`。
   - 主空間：append 到 `world/journal.md`。
2. **提煉（wiki 層）**：把本回合**實際發生**的狀態變動落到 canonical 檔：
   - `world/characters/protagonist.md`：積分／屬性／技能／物品／buff-debuff。
   - `world/characters/<npc>.md`：本回合出場 NPC 的關係／狀態變化。
   - `world/dungeons/<id>/wiki.md`（限副本）：本回合**在劇情中真正揭露**的地圖／機關／規則；嚴守 `secrets.md`，未揭露的不寫。
3. **索引（index 層）**：若本回合**新出現**一個 NPC/實體 → 在 `world/characters/index.md` 加一行＋鎖定事實。
4. **提交（git 層）**：commit，message 一句摘要（不要把整段敘事塞進 message）。

**不留延遲結帳點**：狀態變動在發生的同一回合就寫入，不寫「之後再收斂」這類需要 LLM 記得回來的指示。

### 變更 2：新增 `world/journal.md`（主空間 raw 層）

- 主空間（副本之間：兌換、休整、NPC 互動）也要有 append-only 原始時間線，與副本的 `runs/*.md` 對稱。
- 由回合收束協議步驟 1 維護；`init-world` 重置時一併歸檔（隨 `world/` 進 `archives/<timestamp>/`）並新建空白 journal。
- 在 `CLAUDE.md` 目錄結構與核心循環中補上此檔說明。

### 變更 3：raw log 採 B1（檔案 append + 摘要 commit），明確否決替代方案

- 確立原始 log 用獨立檔案、每回合 append 一小段、commit message 只寫摘要。提煉時 Read 檔案。
- 在 `CLAUDE.md`「關鍵約定」補一條，記錄並說明否決理由，避免日後回繞：
  - **否決 sqlite**：二進位 blob 殺掉 git 防竄改與人工審閱、在 branch+PR 模型下幾乎無法 merge、比 JSON 更結構化而違背 markdown 哲學。
  - **否決 commit-message-as-log**：純敘事、無狀態變動的回合需要 `--allow-empty` 空 commit 當載體（製造假 diff），且提煉需靠 `git log` 撈、不如 Read 檔順手。

### 變更 4：新增 Stop hook（確定性兜底提醒）

- 位置：專案 `.claude/settings.json`（或 `settings.local.json`）的 `hooks.Stop`。
- 行為：回合結束時跑 `git status --porcelain world/`；若 `world/` 有未提交改動，輸出一句提醒注入 context：「你有未提交的世界狀態變更，結束前先 commit。」
- 性質：觸發靠 harness 的 Stop 事件、條件靠 git diff，**完全確定性**，不需要 mode 旗標。維護對話通常不碰 `world/`，天然幾乎不誤報。
- 限制（誠實記錄）：hook 只能抓「寫了沒提交」，無法抓「敘事講了卻沒寫檔」；後者靠變更 1 的「同回合耦合寫入」壓到最小。

### 變更 5：`characters/index.md` 升級為「鎖定事實檯帳」

- 每個 NPC 條目除了一句話索引，加一個 `鎖定事實` 區塊：外觀、身份、與主角關係、立場——**絕不可寫矛盾的底線**。
- `start-story`／`enter-dungeon` 的 query 規範指向此區塊（見變更 1 敘事前）。
- 同步更新現有條目：`protagonist`、`linsiyu`、`yeqing`。

### 變更 6：`settle-dungeon` 新增一致性檢查 subagent（lint 階段）

- 在「提煉進 wiki」前，派一個 `Explore` subagent，拿 `runs/<run-id>.md` 比對既有 `wiki.md`／相關 `characters/*.md`／`secrets.md`／`index.md` 鎖定事實，回報**矛盾清單**：NPC 細節漂移、過時宣稱、劇情牴觸、孤立事實。
- 有矛盾 → 結算時先處理（修正敘事認定或標註），再合併。
- **重要教導**：`gm-notes.md`/`secrets.md` 牴觸 `setting.md`/`wiki.md` 是**設計上的隱藏層（typed edge：隱藏/揭露）**，不是 bug，subagent 不可把它標成矛盾。
- 沿用 settle 既有「長 log 派 subagent」模式，不額外引工具。

### 明確排除（不做）

- ❌ codegraph：程式碼索引，不解析散文。
- ❌ agentmemory：第二真相來源，違背單一 canonical truth。
- ❌ mode 旗標：又一個要靠紀律維護的狀態。
- ❌ sqlite / JSON 化狀態：見變更 3。
- ⏸️ graphify 定期稽核：等故事變長、真感到亂再說（可選，非本次範圍）。

## 4. 受影響檔案清單

- `CLAUDE.md`：補 `world/journal.md`、回合收束協議概述、log 方式的關鍵約定。
- `.claude/skills/start-story/SKILL.md`：加回合收束協議、query 先讀鎖定事實、主空間寫 journal。
- `.claude/skills/enter-dungeon/SKILL.md`：加回合收束協議（副本版，寫 runs/*.md）、query 先讀鎖定事實。
- `.claude/skills/settle-dungeon/SKILL.md`：加一致性檢查 subagent（lint）步驟與隱藏層教導。
- `.claude/skills/init-world/SKILL.md`：歸檔與重建時納入 `world/journal.md`。
- `.claude/settings.json`（或新建）：新增 Stop hook。
- `world/characters/index.md`：升級為鎖定事實檯帳，更新三個現有條目。
- `world/journal.md`：新建（主空間 raw log，初始可空或寫一句起始時間戳）。

## 5. 風險與但書

- **Stop hook 每回合觸發**：在維護對話若剛好動到 `world/` 也會提醒，但那是正確行為；不動 `world/` 的維護對話不受影響。
- **「敘事講了卻沒寫檔」無法被 hook 偵測**：屬內容層，只能靠變更 1 的同回合耦合 + 變更 6 的 lint 補抓，無法 100% 確定化。
- **回合收束協議增加每回合的工具呼叫量**：以「條件式略過」與「append 小段而非重寫」控制成本。

## 6. 驗證計畫（手動，本 repo 無測試框架）

1. **Stop hook**：在 `world/` 製造一個未提交改動，結束一回合，確認提醒出現；`world/` 乾淨時確認不出現。
2. **回合收束協議**：跑一段 `start-story` 主空間互動（含一次積分變動與一次新 NPC 出場），確認 journal append、protagonist.md 更新、index.md 新增鎖定事實、各自 commit。
3. **一致性 lint**：在一個 run log 故意埋一個與 index 鎖定事實矛盾的 NPC 細節，跑 `settle-dungeon`，確認 subagent 回報該矛盾，且**不**把 secrets/gm-notes 的隱藏層誤報為矛盾。
4. **index query**：重提既有 NPC 時，確認先讀 index 鎖定事實而非憑印象。
