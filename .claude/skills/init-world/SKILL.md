---
name: init-world
description: Reset the entire world. Archives the current world/ state and works with the user to generate a brand-new setting (system/主神 rules, protagonist origin, tone). Use when the user runs /init, asks to reset the world, start a new lifetime, or begin a new story from scratch.
---

# init-world

重置整个无限恐怖世界。这是一个**破坏性、需要明确确认**的操作，执行前必须先跟用户确认「真的要重置」。

## 步骤

1. **确认**：跟用户确认是否真的要重置世界（这会让当前主角的故事线结束）。除非用户已经在本次对话中明确要求 `/init`，否则先用 AskUserQuestion 确认一次。
2. **封存旧世界**：
   - 若 `world/setting.md` 显示「尚未初始化」，跳过封存，直接进入步骤 3。
   - 否则，将整个 `world/` 目录复制到 `archives/<UTC timestamp, 格式 YYYYMMDD-HHMMSS>/world/`。
3. **与用户对话生成新设定**：透过对话了解用户想要的世界基调（可参考的无限恐怖类作品、恐怖/惊悚强度、主神性格、新手保护规则等）。不要自己凭空决定所有细节，关键设定（主神性质、副本机制、新手保护规则）必须先跟用户过一轮。
4. **写入新设定**：
   - 改写 `world/setting.md`，移除「尚未初始化」状态，填入完整设定。
   - 改写 `world/characters/protagonist.md`：姓名、出身、初始属性、初始积分（一般为 0）。
   - 清空/重建 `world/characters/index.md` 表格，只保留 protagonist 一行。
   - 清空 `world/dungeons/` 下旧的副本子目录（已封存在 archives，不用担心丢失）。
5. **提交**：以清晰的 commit message（例如 `init-world: archive previous lifetime, generate new setting`）提交到当前分支。**不要自动 push**，除非用户要求。

## 注意

- 这个 skill 只负责「重置 + 生成设定文本」，不负责进入副本，进入副本用 `enter-dungeon`。
- 新设定必须写清楚「新手保护」具体规则，因为 `settle-dungeon` 会依赖这个规则判断角色死亡时的结算方式。
