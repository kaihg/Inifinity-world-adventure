# 副本目录结构

每个副本一个子目录：`world/dungeons/<dungeon-id>/`

```
world/dungeons/<dungeon-id>/
  wiki.md            # 已揭露的累积知识：地图、机关、NPC、已知规则、跨次进入的记忆
  secrets.md         # 尚未揭露的隐藏真相（机关原理、NPC真实动机、剧情转折），首次进入时生成，剧透文件
  runs/
    <run-id>.md       # 单次进入的完整对话 log（对应一个 PR/branch），append-only
```

- `wiki.md` 是**精炼后**、**玩家已知**的 canonical 知识，每次进入副本时优先读这份，不读历史 `runs/*.md` 全文。
- `secrets.md` 是该副本的「母版真相」，由 `enter-dungeon` 首次进入时自主生成（不跟使用者讨论），仅供 LLM 叙事时保持暗线一致，**不可提前讲给玩家**。打开它等同剧透，建议不要主动查看。
- `runs/<run-id>.md` 是该次 PR branch 上的原始流水账（含 `roll-random` 的实际指令与输出），结算时由 `settle-dungeon` 提炼合并进 `wiki.md` 与 `characters/*.md`：只有实际剧情中揭露的部分会从 `secrets.md` 移入 `wiki.md`，原始记录保留供事后查证矛盾。
- 同一个副本可以被多次进入（不同 `run-id`），`wiki.md` 在多次 run 之间延续，`secrets.md` 只生成一次不重新覆写。
