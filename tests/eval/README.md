# 检索评测集（D11）

`npm run eval` 跑的就是这里的脚本。评测回答一个问题：**这次改动让检索变好还是变坏**。
没有它，所有「优化检索」都只是猜。

## 一条命令做什么

```
npm run eval              # 跑评测并与基线对比（holdout 退化超阈值则非零退出）
npm run eval:baseline     # 跑评测并把本次结果写成新基线
```

流程（全部在**临时目录**里发生，不读也不写仓库里的 `Data/`）：

1. 装配语料 → `os.tmpdir()/sd-eval-<ts>/corpus/`；
2. `createRuntime(tempDataDir)` 起一个干净库，`vector_enabled=true`、`chunk_size=512`；
3. 导入语料并等解析队列 `idle()`（文档、块、向量都落库）；
4. 每条问题分别跑 `fulltext` / `semantic` / `hybrid` 三档，各取 top10；
5. 算指标、分桶、打印报告，写明细到 `<tmp>/eval/run-<ts>.json` 与 `report.md`；
6. 与 `baseline.json` 比较。

## 指标口径

| 指标 | 定义 |
|---|---|
| `recall@k`（k=1/3/5/10） | 等级 ≥2 的期望文档里，出现在 top-k 的比例 |
| `MRR` | 第一条相关结果的 1/名次（有等级 3 的期望时优先看它），再对全部题目取平均 |
| `nDCG@10` | 用相关性等级加权的折扣累计增益，衡量排序质量 |
| `precision@5` | 仅当题目给了 `grade: 0` 的负样本时才计算 |
| 块级命中 | 结果里带回的 `matched_chunk.content` 是否包含期望的关键片段 |

**分桶口径**（避免把「通道对比」和「生产路径质量」混在一起）：

- `channel:fulltext` / `channel:semantic` / `channel:hybrid`：三个通道各自跑**全部**题目，用来判断融合是否真的优于单通道；
- `all` / `split:dev` / `split:holdout` / `query_mode:*` / `tag:*`：只统计 `hybrid`（生产默认路径）。

## 数据集格式（`queries.jsonl`）

每行一条 JSON：

```json
{"id":"q001","query":"RRF k=60","mode":"fulltext","split":"dev",
 "expect_documents":[{"file":"混合检索设计.md","grade":3}],
 "expect_chunks":[{"file":"混合检索设计.md","contains":"k=60"}],
 "tags":["字面命中","公式"]}
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一编号；改动某题时**不要复用旧编号**，否则逐题回归表会串 |
| `query` | 用户会真的这么问的一句话（禁止拿文档标题反推问题，那样 recall 会虚高） |
| `mode` | 这题**最适合**的通道（`fulltext` / `semantic` / `hybrid`），用于分桶归因 |
| `split` | `dev`（可看分调参）或 `holdout`（只在发版前跑，**不参与调参**） |
| `expect_documents[].file` | 期望命中的语料**文件名**（不是数据库 id：id 随运行环境变化，写进数据集就不可复现） |
| `grade` | `3` 必须命中 / `2` 应命中 / `1` 相关但非必需 / `0` 明确不相关（算 precision 用） |
| `expect_chunks[]` | `{file, contains}`：期望返回的块正文里包含该片段（块级溯源是否真的落到对的段） |
| `tags` | 分组归因（字面命中 / 改写问法 / 表格 / 英文 / 锚点 / 截断语义…） |

> `expect_chunks` 用「关键片段」而不是硬编码 `chunk_index`：块的切分随设置变化，
> 硬编码序号会让数据集在改一次分块参数后集体失效，而片段是稳定的语义锚点。

## 语料

- `corpus/` 下的**纯文本语料**（`.md` / `.txt` / `.csv`）已提交进仓库，可直接审阅与 diff；
- `.docx` / `.xlsx` 由 `corpus.js` 在运行时生成到临时目录（避免把二进制塞进仓库，同时让评测真的覆盖 OOXML 解析路径）；
- 语料只用**自造的小样本**（12 篇 / 约 23 KB），不放用户真实文件。

## 如何扩充

1. **加语料**：把新的 `.md` / `.txt` / `.csv` 丢进 `tests/eval/corpus/`（或在 `corpus.js` 里加一个生成器）；
2. **加问题**：往 `queries.jsonl` 追加一行，`expect_documents` 里写上语料文件名与等级；
   每加一批问题，先想清楚它属于哪一类（字面命中 / 改写问法 / 表格 / 作用域 / 锚点），并打上 `tags`；
3. **维持划分比例**：`holdout` 保持在 25% 左右，且**只有在想验证「泛化」时才用**；
4. **改基线**：确认指标变化是预期内的，再跑 `npm run eval:baseline`（把 `baseline.json` 的 diff 一起提交，方便回溯）；
5. **别做的事**：为了提分而反复看 holdout 的逐题结果——那等于把 holdout 变成了 dev，门槛就失效了。

## 防过拟合的机制

- **固定随机种子**：`SD_VECTOR_SEED=20260920`（`run.cjs` 里设定）让向量索引的 k-means 初始化可复现，
  这样「换参数」与「换随机初始化」不会混为一谈；
- **holdout 只当门槛**：只有 `split:holdout` 的 `recall@5` 与 `MRR` 参与退化判定，阈值 0.02；
- **分桶 + 逐题名次**：`baseline.json` 里存了 `per_query_rank`，掉榜的题能直接看出来；
- **多格式多语言语料**：中文 / 英文 / 表格 / 文档齐备，避免得出「分词器只对某种语言友好」这类单一结论。

## 已知限制（如实记录）

- **本机没有 ffmpeg / ffprobe**，语料中不含音频与视频，因此**音视频时间锚点未被评测覆盖**；
- PPTX / EPUB 未纳入评测语料（语料覆盖 `txt/md/csv/docx/xlsx` 五种格式）；
  这两种格式的锚点在 `tests/integration.cjs` 里另有断言；
- 语料规模刻意很小（12 篇），指标绝对值只适合**纵向对比**（同一数据集上前后对比），
  不能拿来说「这个检索系统在真实库上就是 0.9 的 recall」；
- 题目由开发者自行撰写，不是用户真实提问（R12 的已知风险）；
  扩充时优先补真实使用场景里出现过的问题。
