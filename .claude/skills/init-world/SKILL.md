---
name: init-world
description: Reset the entire world. Archives the current world/ state and works with the user to generate a brand-new setting (system/主神 rules, protagonist origin, tone). Use when the user runs /init, asks to reset the world, start a new lifetime, or begin a new story from scratch.
---

# init-world

重置整個無限恐怖世界。這是一個**破壞性、需要明確確認**的操作，執行前必須先跟用戶確認「真的要重置」。

## 步驟

1. **確認**：跟用戶確認是否真的要重置世界（這會讓當前主角的故事線結束）。除非用戶已經在本次對話中明確要求 `/init-world`，否則先用 AskUserQuestion 確認一次。
2. **封存舊世界**：
   - 若 `world/setting.md` 顯示「尚未初始化」，跳過封存，直接進入步驟 3。
   - 否則，將整個 `world/` 目錄複製到 `archives/<UTC timestamp, 格式 YYYYMMDD-HHMMSS>/world/`。
3. **與用戶對話生成「玩家可見」設定**：透過對話了解用戶想要的世界基調（可參考的無限恐怖類作品、恐怖/驚悚強度、主神表面性格、新手保護規則等）。這部分只討論**遊戲開始就該讓玩家知道**的規則；關鍵的玩家可見設定（主神表面人設、副本機制、新手保護規則）必須先跟用戶過一輪，不要自己憑空決定。
4. **自主生成「隱藏」設定，不跟用戶討論**：依據步驟 3 定下的基調，自行編寫主神/系統的真實動機、世界背後的真相、最終目的、暗線伏筆等「尚未揭露」的設定，寫進 `world/gm-notes.md`。**不要把這部分內容講給用戶確認或預覽**，保留劇情懸念；之後的敘事 skill 會讀這份文件來保持暗線一致，但只在劇情真正揭露到的節點才會顯性透露。
5. **寫入新設定**：
   - 改寫 `world/setting.md`，移除「尚未初始化」狀態，填入玩家可見的完整設定。
   - 改寫 `world/gm-notes.md`，移除「尚未生成」狀態，填入隱藏真相（步驟 4 的產出），「揭露記錄」留空。
   - 改寫 `world/characters/protagonist.md`：姓名、出身、初始屬性、初始積分（一般為 0）。
   - 清空/重建 `world/characters/index.md` 表格與「鎖定事實」區塊，只保留 protagonist 一行＋一段鎖定事實。
   - 重建 `world/journal.md`：清空舊內容，只留標題與說明，並 append 一段 `## [YYYY-MM-DD] 新世界啟用` 起始時間戳。
   - 重建 `world/now.md`：覆寫為新世界起始局勢——當前篇章=開場、此刻場景=主角初始位置、在場同伴=（無或開場既定）、進行中的副本=無、下一步=（開場行動）、最後更新=今日時間戳。
   - 清空 `world/dungeons/` 下舊的副本子目錄（已封存在 archives，不用擔心丟失）。
6. **提交**：commit message 只描述「重置世界、生成新設定」這類事實，**不要把 `gm-notes.md` 的具體內容寫進 commit message**（commit message 在 git log 裡很容易被無意間看到，等同劇透）。**不要自動 push**，除非用戶要求。

## 注意

- 這個 skill 只負責「重置 + 生成設定文本」，不負責進入副本，進入副本用 `enter-dungeon`（副本本身的隱藏設定在 `enter-dungeon` 首次進入時才生成，見該 skill 說明）。
- 新設定必須寫清楚「新手保護」具體規則，因為 `settle-dungeon` 會依賴這個規則判斷角色死亡時的結算方式。
- `gm-notes.md` 是劇透文件，任何 skill 在敘事中引用它的內容時，只能拿來確保暗線一致，不能讓對話內容提前講出尚未揭露的真相。
