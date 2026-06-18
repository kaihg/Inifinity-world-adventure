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
3. **与用户对话生成「玩家可见」设定**：透过对话了解用户想要的世界基调（可参考的无限恐怖类作品、恐怖/惊悚强度、主神表面性格、新手保护规则等）。这部分只讨论**游戏开始就该让玩家知道**的规则；关键的玩家可见设定（主神表面人设、副本机制、新手保护规则）必须先跟用户过一轮，不要自己凭空决定。
4. **自主生成「隐藏」设定，不跟用户讨论**：依据步骤 3 定下的基调，自行编写主神/系统的真实动机、世界背后的真相、最终目的、暗线伏笔等「尚未揭露」的设定，写进 `world/gm-notes.md`。**不要把这部分内容讲给用户确认或预览**，保留剧情悬念；之后的叙事 skill 会读这份文件来保持暗线一致，但只在剧情真正揭露到的节点才会显性透露。
5. **写入新设定**：
   - 改写 `world/setting.md`，移除「尚未初始化」状态，填入玩家可见的完整设定。
   - 改写 `world/gm-notes.md`，移除「尚未生成」状态，填入隐藏真相（步骤 4 的产出），「揭露记录」留空。
   - 改写 `world/characters/protagonist.md`：姓名、出身、初始属性、初始积分（一般为 0）。
   - 清空/重建 `world/characters/index.md` 表格，只保留 protagonist 一行。
   - 清空 `world/dungeons/` 下旧的副本子目录（已封存在 archives，不用担心丢失）。
6. **提交**：commit message 只描述「重置世界、生成新设定」这类事实，**不要把 `gm-notes.md` 的具体内容写进 commit message**（commit message 在 git log 里很容易被无意间看到，等同剧透）。**不要自动 push**，除非用户要求。

## 注意

- 这个 skill 只负责「重置 + 生成设定文本」，不负责进入副本，进入副本用 `enter-dungeon`（副本本身的隐藏设定在 `enter-dungeon` 首次进入时才生成，见该 skill 说明）。
- 新设定必须写清楚「新手保护」具体规则，因为 `settle-dungeon` 会依赖这个规则判断角色死亡时的结算方式。
- `gm-notes.md` 是剧透文件，任何 skill 在叙事中引用它的内容时，只能拿来确保暗线一致，不能让对话内容提前讲出尚未揭露的真相。
