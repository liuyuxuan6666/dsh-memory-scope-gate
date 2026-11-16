# dsh-memory-scope-gate · 记忆披露闸

给 DeepSeek Harness 的 `@kenz1117/dsh-engram` 记忆系统加一层**会话级披露闸**。

默认情况下 engram 的检索工具在**省略 `scope`** 时会把「私人库 + 当前项目库 + 共享库」三库合并
（源码 `scopesOf(undefined) → ["user","project","shared"]`），于是任何工作区的会话都能读到
别处写进私人库的记忆。这个插件把默认改成**只看本工作区**，并把"要不要升到全局"交回给用户。

## 它做什么

| 层级 | `engram_*` 允许的 scope |
|---|---|
| `workspace`（默认） | 只放行 `"project"`；省略 scope、`user`、`shared`、`all` 在 dispatch 前拦下 |
| `global` | 不拦（= 现在的行为） |

另有一条 **id 白名单防线**：`engram_examine` / `engram_neighbors` 只吃 id、没有 scope 可查，
所以「本区」档位下它们只接受**本会话检索结果里出现过、且标注为 `[project/...]` 的记忆 id**。
`[user/...]`、`[shared/...]` 行的 id 永不入白名单；切回「本区」会清空白名单。

层级是**按会话**的，落在 `$DSH_HOME/dsh-memory-scope-gate/levels.json`。
输入框左侧有开关：「记忆·本区」⇄「记忆·全局」，点一下即时生效。

被拦时模型拿到的原因里写清了下一步（改用 `scope:"project"` 重试，或请用户切层级），
另外注册了一条系统提示词，让模型第一次就传对 scope，减少往返。

## 为什么不是改 engram

- `tools/pre-execute` 只能 allow/deny，`tools/execute` 的文档写明 *wrappers may change only `exec.signal`*，
  所以外部插件**没法**把 `scope:"all"` 悄悄改写成 `"project"`。要"默认"语义只能 fork engram。
- 这个插件走的是**拦截 + 明确指令**：不 fork、不碰 engram 的库，engram 升级不受影响。
  认不出的新工具/新参数会放行并写日志，宁可漏也不锁死。
- 零外部服务：跑在 DSH 进程内，随 DSH 生死，不需要开机链。

## 已知边界（重要）

1. **只管调用层**。engram 的自动摄取（`config.ingest`）不经过工具调用，本插件拦不住它往私人库写。
   要连写入一起收紧，得改 engram 自己，或者把 `ingest` 关掉。
2. **没有 scope 的工具**走 id 白名单（见上）。`engram_assess` 只对给定 ref 做判定、不吃 id，不受影响。
3. **面板不受影响**。侧栏「记忆宫殿」的浏览与 scope 三宫格仍然是全局视图，那是你自己看的地方。
4. 层级按会话存，**不写进会话日志**；DSH 重启后仍在（文件持久化），会话归档后条目留着不清理。

## 安装

```bash
dsh plugin --profile desktop add github:liuyuxuan6666/dsh-memory-scope-gate
```

或在 DSH 里用 `plugin_manager` 的 `install_bundle`，target 填 `github:liuyuxuan6666/dsh-memory-scope-gate`。

## 配置

`cordis.patch.yml` 里那一行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `defaultLevel` | `"workspace"` | 没有显式选择的会话用哪个层级 |

## 自检

```bash
# 闸拦没拦（workspace 层级下应该被 deny）
# 在会话里让 agent 调 engram_search 且不传 scope，应看到 [dsh-memory-scope-gate] 的拒绝原因
cat ~/.dsh/dsh-memory-scope-gate/denials.jsonl   # 每次拦截/切换都有一行
```

## 许可

MIT
