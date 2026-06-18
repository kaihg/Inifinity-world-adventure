---
name: settle-dungeon
description: Settle a finished dungeon run (cleared, died, or retreated) - distill the run log into the dungeon wiki and update character/index files, then merge the PR back to main. Use when a dungeon run has reached an end state and needs to be closed out, or when triggered by the settle-on-merge GitHub Action.
---

# settle-dungeon

副本結束後的結算流程。**無論通關、死亡還是中途撤退，都走這個流程並合併回 main**——死亡不代表丟棄這個 PR，新手保護等後果由結算規則處理。

## 步驟

1. **讀取本次 run 的完整記錄**：`world/dungeons/<dungeon-id>/runs/<run-id>.md`（即該 PR branch 上累積的全部 commit 內容）。
   - **若這份 log 很長**（多輪對話、篇幅明顯超過一般單次副本），不要自己整篇讀完去消化，改用 Agent 工具派一個 `Explore` subagent 去讀 `runs/<run-id>.md`（必要時也帶上現有的 `wiki.md`、相關 `characters/*.md` 做對照），請它回報**結構化結論**：本次積分增減依據、哪些 NPC 狀態有變化（要具體到「變化前→變化後」）、wiki 該新增哪些條目、是否有死亡/重傷等關鍵事件。subagent 只負責消化文本、回報結論，不直接寫文件，也不能代替步驟 2～5 的規則判定。
   - 若 log 不長，直接自己讀即可，不必為了短文件也派 subagent。
2. **判定結束類型**：通關 / 死亡 / 中途撤退，並依 `world/setting.md` 當前規則（含新手保護條款）決定積分增減、懲罰或獎勵。
3. **提煉進 wiki（不是複製貼上全文）**：
   - 更新（或新建）`world/dungeons/<dungeon-id>/wiki.md`：本次新發現的地圖/機關/規則/NPC，已經死亡或消耗掉的資源。
   - 對照 `world/dungeons/<dungeon-id>/secrets.md`（若存在）與 `world/gm-notes.md`：**只把這次劇情裡實際揭露出來的部分**寫進 `wiki.md`，未揭露的隱藏真相留在 secrets/gm-notes 裡，不要因為結算而提前曝光。若本次有揭露，在 `gm-notes.md` 的「揭露記錄」補一筆。
   - 原始 `runs/<run-id>.md` 保留不刪，作為可回溯的原始記錄。
4. **更新角色狀態**：
   - `world/characters/protagonist.md`：積分、屬性變化、新增/消耗的技能與物品、buff/debuff、新手保護剩餘次數等。
   - 涉及到的 NPC：更新對應 `world/characters/<id>.md`，若是新出現的重要角色，新建檔案並在 `index.md` 加一行。
5. **死亡的特殊處理**：若設定中新手保護允許死亡不等於 game over，依規則記錄「死亡懲罰」（例如扣積分、清空部分物品、留下後遺症 debuff），而不是直接結束故事——除非設定明確寫了保護已用盡。
6. **提交並合併**：
   - 把以上更新 commit 到該 dungeon run 的 branch。
   - 合併 PR 回 main（無論結果好壞都合併）。
   - 合併後可刪除該 run 的臨時分支（`runs/<run-id>.md` 內容已經在 main 上保留，不會丟失）。

## 注意

- 這個 skill 也是 `.github/workflows/settle-on-merge.yml` 在 PR 合併後會提示調用的同一套邏輯；手動結算與 Action 觸發的結算必須遵守同一份規則，不要為了自動化場景簡化判定標準。
