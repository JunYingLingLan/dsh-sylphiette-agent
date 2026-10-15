# dsh-sylphiette-agent · 希露菲

把《无职转生》的**希露菲耶特（Sylphiette）**做成 DeepSeek Harness（DSH）的一个角色扮演预设：
装上之后，新建会话时选「希露菲」就能直接和她对话。

- **全中文人设**：身份、外貌、性格、成长经历、说话方式（含"括号内第三人称 / 引号内第一人称"的对话标记规则）
- **453 条六面世界设定**：魔法、剑术流派、种族、地理、国家、组织、魔道具、学园规则……
  按对话**自动调取**（命中关键词才注入），另有 `lore_lookup` 工具可主动检索
- **剧情**：她只钟情于你（原卡的三角恋线已删除）
- **尺度**：成人向（NSFW）

> ⚠️ **本预设包含成人向内容，仅供成年人在本地个人使用。** 请勿传播、转售或用于商业用途。
> 这是《无职转生》的非官方同人二创，原作版权属于理不尽な孫の手及相关出版方。

---

## 安装

本包是一个标准的 DSH **profile bundle**（`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），
所以官方途径和手动兜底都行。

### 方式一：官方命令（推荐）

```bash
# 普通（dsh web / 非桌面版）——把 <profile> 换成你的 profile 名，通常是 web 或 default
dsh plugin --profile <profile> add github:JunYingLingLan/dsh-sylphiette-agent
```

**Desktop（桌面版应用）用户注意**：桌面版把自己的 `desktop` profile 锁给了 Electron 进程，
直接用全局 `dsh` 会报 `profile "desktop" is managed exclusively by the Electron application`。
请改用桌面版自带的 CLI，或干脆用 GUI：

```powershell
# Windows：<DSH安装目录> 换成你装 DeepSeek Harness 的地方
& "<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:JunYingLingLan/dsh-sylphiette-agent
```

或者：打开 DSH 界面 → 侧栏**插件** → 添加插件 → 把包名/URL 粘进去。

> `github:` 这种写法需要机器上有 **git**（DSH 会先 `git ls-remote` 探一下）。
> 没装 git 的话，用下面的 tarball 写法或方式二。

**不想装 git？用 Release 里的 tgz**（`dsh plugin` 支持 tarball URL，不需要 git）：

```bash
dsh plugin --profile <profile> add https://github.com/JunYingLingLan/dsh-sylphiette-agent/releases/download/v1.0.0/dsh-sylphiette-agent-1.0.0.tgz
```

### 方式二：兜底脚本（不碰 pnpm、不需要 git、不需要 DSH CLI）

适合桌面版用户，或者在官方途径上卡住的时候：

```bash
# 先把仓库下载/克隆到本地，进入包根目录，然后：
node bin/install.mjs            # 先预览，什么都不改
node bin/install.mjs --apply    # 真正安装
```

它会：

1. 把整包拷到 `<DSH主目录>/dsh-sylphiette-agent/`（默认 `~/.dsh`，Windows 是 `C:\Users\你\.dsh`）
2. 把包内的 `cordis.patch.yml` 声明内联进 `<DSH主目录>/profiles/<profile>/cordis.patch.yml`，
   并把插件路径转成绝对 `file://` URL
3. 备份原来的 patch，然后逐项验证

可选参数：`--home <DSH主目录>`、`--profile <名字>`、`--patch <文件>`、`--uninstall --apply`。
自动探测失败时先加 `--home` 指明位置。

### 装完之后

**刷新 DSH 的 Web 界面**（桌面版默认 `http://127.0.0.1:19387`）；看不到「希露菲」就重启一次 DeepSeek Harness。
然后新建会话 → Agent 预设 选「希露菲」。

## 她是谁

20 岁，四分之一精灵，白发红眼尖耳。对外是阿斯拉王国第三公主爱丽儿的男装护卫「沉默的菲兹」，
在拉诺亚魔法大学读书，擅长无咏唱施法。**私下只对你一个人软**——
你就是她童年唯一的光：教她无咏唱施法的人、转移事件里和她一起活下来的人、两年里和她过着双重生活的人。

## 世界书是怎么工作的（为什么不用把 453 条全塞进去）

453 条设定约 2.7 万 token。全部塞进系统提示的话，每一轮对话都要付这个成本，还会把真正重要的对话挤到角落。
所以本包用插件 `lib/sylphiette-lore.mjs` 做两条通道：

- **自动调取**：你这轮（及上一轮）说的话命中某个关键词时，对应条目才会被加进系统提示；
  没命中就不加（返回空串的段会被 DSH 丢掉，不留残留）。
- **主动查询**：模型可以调用 `lore_lookup` 工具查任意条目（按关键词或编号）。

关键词做了三层匹配，因为译出来的键常常是「爱丽儿的护卫」这种描述性长词，而你嘴里说的是「爱丽儿」：

| 层 | 例子 | 权重 |
|---|---|---|
| 完整键 | 爱丽儿的护卫 | 2 |
| 按「的 / · / 、」切分的片段 | 爱丽儿、菲兹 | 1 |
| 剥掉类别后缀（王国 / 大学 / 流 / 魔法…） | 阿斯拉王国 → 阿斯拉 | 1 |

想调节强度：改 `cordis.patch.yml` 里 `sylphiette-lore` 的 `maxEntries`（单轮最多注入几条）、
`maxChars`（字符上限）、`scanTurns`（回看几轮）、`excludeUids`（不想自动注入的条目编号）。

## 改成你想要的样子

人设正文在 `cordis.patch.yml` 的 `persona.config.prefix`（一大段中文 YAML 块标量）。
改完**必须重新安装**（内容是被内联进 profile 的，DSH 不会自动监视）：

```bash
node bin/install.mjs --apply     # 方式二装的
# 或
dsh plugin --profile <profile> add <spec>   # 官方方式装的（升级＝卸载重装）
```

⚠️ 两个坑：人设里**不能出现 `{{...}}`**（DSH 的提示词插值遇到未知变量会直接报错），也不能有 Tab。

## 卸载

```bash
node bin/install.mjs --uninstall --apply
```

或走官方：`dsh plugin --profile <profile> remove dsh-sylphiette-agent`。

## 包结构

```
package.json          name / bin / dsh.bundle.patch
cordis.patch.yml      bundle 声明：preset 行 + persona + sylphiette-lore
lib/sylphiette-lore.mjs   世界书插件（关键词自动注入 + lore_lookup 工具）
data/lorebook.zh.json     453 条中文设定
bin/install.mjs       兜底安装器
```

## 来源与许可

- 角色卡原作：SillyTavern 角色卡 `Sylphiette`（作者 **tupapichulo69**）
- 世界观资料：`main_The Six Sided World Lorebook (Mushoku Tensei)_world_info`（453 条）
- 本包的改动：全部译成简体中文、删除鲁迪乌斯相关感情线、尺度调整、世界书改为按需注入
- 《无职转生》版权属于原作者**理不尽な孫の手**及相关出版方；本包是非官方同人二创，请仅作个人娱乐

代码部分以 MIT 许可发布（见 `LICENSE`），其中附加的同人/成人向使用说明请一并遵守。
