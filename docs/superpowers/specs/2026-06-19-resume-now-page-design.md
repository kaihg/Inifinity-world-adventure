# 設計：主空間 resume 提煉頁 `world/now.md`

- 日期：2026-06-19
- 狀態：已通過 brainstorming 討論，待實作
- 前置：建立在 `2026-06-19-wiki-llm-turn-protocol-design.md`（回合收束協議、`journal.md`、三層模型）之上。
- 參考：Karpathy「LLM wiki」模式——回答時讀提煉頁，不讀 raw source。

## 1. 背景與要解決的問題

上一輪補上了主空間的 raw 層 `world/journal.md`（append-only）。但 resume（新 session 接續劇情）若以 `journal.md` 為入口會有死結：它無限增長，「讀多少」永遠是 fuzzy 的——讀太多 context 爆、讀太少不正確。

根因：主空間有 raw 層（`journal.md`）與逐實體 canonical（`characters/*.md`），卻**缺一個對稱於副本 `wiki.md` 的「提煉頁」**。Karpathy wiki-llm 的核心正是「回答／恢復時讀提煉頁，不讀 raw source」。

解法：新增一個**有界、永遠精簡、覆寫式**的「當前局勢」提煉頁 `world/now.md`，作為唯一 resume 入口。讀它是 O(1) 且永遠是最新；`journal.md` 退化為審計用 raw，平常 resume 不讀。

明確排除（討論中確認）：

- 不新增 `/checkpoint`、`/stop-story`、`/continue-story` 指令——與回合收束協議、`start-story` 重複。
- 不靠「待在同一 session」保存進度——違背「檔案即真相」。
- 不接 `agentmemory:handoff`——第二真相來源，違背單一 canonical truth。

## 2. 三層模型（補上 now.md 後對稱）

| 層 | 主空間 | 副本 |
|---|---|---|
| raw（原始、少讀、append-only） | `world/journal.md` | `dungeons/<id>/runs/*.md` |
| 提煉頁（resume 就讀這個） | **`world/now.md`（新增）** | `dungeons/<id>/wiki.md` |
| 逐實體 canonical | `world/characters/*.md` | `world/characters/*.md` |

## 3. 變更清單

### 變更 1：新增 `world/now.md`（覆寫式「當前局勢」快照）

- 性質：覆寫式（**不是 append**）、永遠精簡（約 30–50 行封頂）；舊版本由 git 保留。
- 同時是 **resume 路由器**：「進行中的副本」欄決定 resume 停在主空間或交給 `enter-dungeon` 接副本。
- 結構：

```markdown
# 當前局勢（Now）

> resume 入口：新 session 接劇情先讀這份（覆寫式快照，永遠精簡）。
> 由回合收束協議每回合覆寫；要回溯更早細節才翻 journal.md / runs/*.md。

- 當前篇章：
- 此刻場景/地點：
- 在場同伴/相關 NPC：（附 character id）
- 進行中的副本：無／<dungeon-id> + <run-id>
- 未解懸念/伏筆：
- 主角下一步打算：
- 最後更新：[YYYY-MM-DD]
```

### 變更 2：`start-story` 作為 continue-story 入口

- step 1 讀取清單**最前面加 `world/now.md`**，作為 resume 第一手。
- 加一句：若 `now.md` 顯示在副本中，先用一兩句過渡敘事，再交給 `enter-dungeon` 接續該 run；不要在主空間硬接副本劇情。

### 變更 3：回合收束協議新增「覆寫 now.md」（`start-story` 與 `enter-dungeon` 兩處）

- 收束步驟新增一項：**覆寫 `world/now.md`**，反映本回合結束後的當前局勢。
- 副本中也維護它：正確填寫「進行中的副本」欄（`<dungeon-id> + <run-id>`），確保不論在主空間或副本中暫停都能正確 resume 與路由。

### 變更 4：`init-world` 重建 now.md

- step 5 重建時新建 `world/now.md`，填入新世界起始局勢（在安全區、無進行中副本、最後更新時間戳）。
- step 2 封存整個 `world/` 已自動涵蓋 `now.md`，無需額外處理。

### 變更 5：`CLAUDE.md` 文件化

- 目錄結構 `world/` 區塊加一行 `now.md`。
- 三層模型/核心循環中釐清：**resume 讀 `now.md`，不讀 `journal.md`**；`now.md` 是主空間提煉頁，對稱副本的 `wiki.md`。

## 4. 受影響檔案清單

- Create: `world/now.md`
- Modify: `.claude/skills/start-story/SKILL.md`（step 1 讀 now.md、收束覆寫 now.md、副本路由）
- Modify: `.claude/skills/enter-dungeon/SKILL.md`（收束覆寫 now.md，含進行中副本欄）
- Modify: `.claude/skills/init-world/SKILL.md`（重建 now.md）
- Modify: `CLAUDE.md`（目錄、三層模型、resume 約定）

## 5. 風險與但書

- **now.md 每回合覆寫的成本**：檔案小（≤50 行），覆寫成本低；以「永遠精簡」紀律控制，不要把 journal 內容塞進來。
- **now.md 與 setting.md「當前篇章」、index.md「最近狀態」重疊**：now.md 是 volatile 的「此刻場景/下一步」聚焦快照，setting.md 留規則與篇章、index.md 留逐角色近況；三者分工不同，now.md 是唯一的 resume 聚合入口。
- **Stop hook 已涵蓋**：now.md 在 `world/` 下，未提交時 Stop hook 會提醒 commit。

## 6. 驗證計畫（手動，本 repo 無測試框架）

1. **resume 主空間**：跑一段 `start-story` 後結束 session；新開 session 跑 `start-story`，確認它先讀 `now.md` 並正確接回當前場景與下一步，未去讀整份 `journal.md`。
2. **resume 路由到副本**：在副本中途結束；新 session 跑 `start-story`，確認 `now.md`「進行中的副本」欄存在，且過渡後交給 `enter-dungeon` 接該 run。
3. **now.md 有界**：連跑多回合後，確認 `now.md` 仍精簡（≤50 行）、為覆寫而非堆積。
4. **init-world**：跑 `init-world` 後確認 `now.md` 重建為起始局勢、舊內容已隨 `world/` 封存到 archives。
