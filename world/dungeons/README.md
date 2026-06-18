# 副本目录结构

每个副本一个子目录：`world/dungeons/<dungeon-id>/`

```
world/dungeons/<dungeon-id>/
  wiki.md            # 该副本的累积知识：地图、机关、NPC、已知规则、跨次进入的记忆
  runs/
    <run-id>.md       # 单次进入的完整对话 log（对应一个 PR/branch），append-only
```

- `wiki.md` 是**精炼后**的canonical 知识，每次进入副本时优先读这份，不读历史 `runs/*.md` 全文。
- `runs/<run-id>.md` 是该次 PR branch 上的原始流水账（含 `roll-random` 的实际指令与输出），结算时由 `settle-dungeon` 提炼合并进 `wiki.md` 与 `characters/*.md`，原始记录保留供事后查证矛盾。
- 同一个副本可以被多次进入（不同 `run-id`），`wiki.md` 在多次 run 之间延续。
