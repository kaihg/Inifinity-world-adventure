---
name: roll-random
description: Produce a verifiable random number for any probability-based event in a dungeon run (skill success chance, critical hit, random encounter, dice roll, etc). Use whenever the narrative needs to determine an outcome that the setting defines as having a probability — never narrate a probabilistic outcome without calling this first.
---

# roll-random

无限恐怖的世界设定里，凡是「有机率」的事件（技能命中率、暴击率、随机遭遇、骰子检定……）都不能由 LLM 直接「叙述」出结果，必须先用真实随机数源产生数值，再依数值叙事，确保结果可验证、不是凭空编造。

## 步骤

1. 先讲清楚这次判定的规则：数值范围、判定门槛/公式（例如「命中率 65%，roll 1-100，≤65 视为命中」）。这句话要写进 log，方便事后稽核规则有没有被正确套用。
2. 用 Bash 工具执行下面其中一种命令产生随机数（务必让命令与原始输出都出现在对话/log 里，不要自行口算或转述）：
   ```bash
   python3 -c "import random; print(random.randint(1, 100))"
   ```
   范围不是 1-100 时，把 `1, 100` 换成实际范围；需要多个独立随机数时，分开各跑一次命令（不要用同一次输出拆成多个数字）。
3. 拿到输出后，依步骤 1 定义的规则判定结果，并把「规则 + 指令 + 实际输出 + 判定结果」整段原样写入对应的 `world/dungeons/<dungeon-id>/runs/<run-id>.md`。
4. 再继续叙事，叙事内容必须与这个真实判定结果一致。

## 注意

- 不允许「先编故事结果，再编一个凑巧符合的随机数」——必须先掷骰再叙事。
- 同一事件不要重掷（除非设定里明确有「重掷道具/技能」之类的机制，且也要记录触发原因）。
