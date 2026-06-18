# 世界存档（Archives）

每次执行 `/init-world` 重置世界前，会把当前 `world/` 整份打包封存到：

```
archives/<timestamp>/world/...
```

封存只读，不再修改，仅供回溯查阅前一世（lifetime）的设定与角色结局。
