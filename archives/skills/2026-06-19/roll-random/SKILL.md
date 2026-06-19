---
name: roll-random
description: Produce a verifiable random number for any probability-based event in a dungeon run (skill success chance, critical hit, random encounter, dice roll, etc). Use whenever the narrative needs to determine an outcome that the setting defines as having a probability — never narrate a probabilistic outcome without calling this first.
---

# roll-random

無限恐怖的世界設定裡，凡是「有機率」的事件（技能命中率、暴擊率、隨機遭遇、骰子檢定……）都不能由 LLM 直接「敘述」出結果，必須先用真實隨機數源產生數值，再依數值敘事，確保結果可驗證、不是憑空編造。

## 步驟

1. 先講清楚這次判定的規則：數值範圍、判定門檻/公式（例如「命中率 65%，roll 1-100，≤65 視為命中」）。這句話要寫進 log，方便事後稽核規則有沒有被正確套用。
2. 用 Bash 工具執行下面其中一種命令產生隨機數（務必讓命令與原始輸出都出現在對話/log 裡，不要自行口算或轉述）：
   ```bash
   python3 -c "import random; print(random.randint(1, 100))"
   ```
   範圍不是 1-100 時，把 `1, 100` 換成實際範圍；需要多個獨立隨機數時，分開各跑一次命令（不要用同一次輸出拆成多個數字）。
3. 拿到輸出後，依步驟 1 定義的規則判定結果，並把「規則 + 指令 + 實際輸出 + 判定結果」整段原樣寫入對應的 `world/dungeons/<dungeon-id>/runs/<run-id>.md`。
4. 再繼續敘事，敘事內容必須與這個真實判定結果一致。

## 注意

- 不允許「先編故事結果，再編一個湊巧符合的隨機數」——必須先擲骰再敘事。
- 同一事件不要重擲（除非設定裡明確有「重擲道具/技能」之類的機制，且也要記錄觸發原因）。
