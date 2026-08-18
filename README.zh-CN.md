# DSH Context Lens

[English](README.md) | [简体中文](README.zh-CN.md)

> 看见每个插件向模型放入了什么。

DSH Context Lens 是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的只读可观测性插件。它在 Chat 和 Trajectory 旁添加独立的 **Lens** 视图，重建每次普通 Agent 请求，并展示 system prompt、runtime context、tools 和 plugin messages 分别由哪些插件贡献。

> [!WARNING]
> **项目仍在施工中。** Context Lens 正在积极开发，可能仍有不少问题或未完成的行为。部分指标可能不准确，尤其是估算上下文 token 数和 KV cache 读取/命中比例。重要结论请同时核对 Provider 报告的数据；如果发现异常，欢迎[提交 Issue](https://github.com/KinomotoMio/dsh-context-lens/issues/new)。
>
> 近期工作：[前端体验](https://github.com/KinomotoMio/dsh-context-lens/issues/1) · [数据准确性](https://github.com/KinomotoMio/dsh-context-lens/issues/2) · [插件归因覆盖与 DSH 版本兼容性](https://github.com/KinomotoMio/dsh-context-lens/issues/3)。

## 界面预览

![Context Lens 构成视图，展示插件贡献占比、请求变化与 KV cache 用量](docs/images/context-lens-overview.png)

截图来自 DSH `0.1.0-rc.7` Web UI，使用的是说明性、非敏感请求快照。

界面复用 DSH Web 的 UI primitives、字体、surface 和 `--dsw-*` design tokens。本地 CSS 只定义 Lens 特有的贡献占比条、渐进披露行和有序阅读布局。

### 按请求顺序阅读

![Context Lens 阅读视图，按 System、Tools 和 Messages 顺序展示完整请求](docs/images/context-lens-reader.png)

**Reader** 把选中的请求呈现为一份连续文档。System sections、tools、runtime context、plugin messages 和 conversation messages 会保留 DSH 请求顺序，因此贡献可以呈现为 A–B–A 穿插，而不会按插件重新分组。选择一个贡献者可以在不移动内容的情况下聚焦相关 block，也可以在可读和原始表示之间切换。

<details>
<summary>渐进披露：先查看贡献项，再按需加载正文</summary>

![Context Lens 展开 Tool Registry 并加载一个 tool schema](docs/images/context-lens-detail.png)

</details>

## Lens 展示什么

默认的 **Breakdown** 视图停留在归因层：

- 有 Provider usage 时，堆叠占比条展示 Provider 报告的模型输入，否则展示估算输入；
- 每个插件一行，展示估算 token、占比和相对上一次请求的变化；
- 明确的 `Conversation`、`Unattributed` 和 `Conflicted` 行；
- Provider 报告的未缓存输入、cache read、可选的 cache write，以及 cache read / prompt tokens；
- 与缓存数据并列的新增、移除、修改和移动贡献项。

选择插件可以查看它贡献的命名 section、runtime context、tool 和 plugin message。完整 prompt 文本和 JSON schema 只有在选择 **Reveal content** 后才会读取，不会包含在初始 snapshot 响应里。

Breakdown 的行和堆叠条片段按估算占比排序，表达的是构成比例，不是请求时间线。**Reader** 才是有序视图：它把 System、Tools 和 Messages 保持为不同的请求 plane，再保留各 plane 内的原始顺序。这是 DSH 的 provider-neutral 请求顺序；Provider 在 wire 上可能采用不同的 role、tool schema 或 framing 序列化方式。

请求选择器默认定位最新一次普通 generation。Compaction、Session 标题生成和其他辅助模型调用不在 v1 请求目录内。

## 安装

版本 `0.1.0` 面向 DSH `0.1.0-rc.7` 的公开 API。npm 包发布前，可以把本仓库放在 Harness checkout 旁并构建 tarball：

```text
projects/
├── deepseek-harness/
└── dsh-context-lens/
```

```sh
cd dsh-context-lens
pnpm install
pnpm build
pnpm pack --pack-destination .artifacts

dsh plugin --profile web add .artifacts/kinomotomio-dsh-context-lens-0.1.0.tgz
dsh --profile web
```

该包同时声明了 `dsh.bundle.patch` 和 `dsh.client` 元数据。安装后，Host observer 会加入 profile，浏览器 client 会加入 Web roster；无需修改 DeepSeek Harness 源码。

## 为你的插件声明归因

Context Lens 首先使用 Session event 已经携带的显式 provenance。对于命名 system section、runtime context 和 tool，插件可以通过当前 Cordis fiber 注册精确 claim：

```ts
export function apply(ctx: Context): void {
  ctx.pluginContextLens.claim({
    label: 'Repository Map',
    sections: ['repo-map:instructions'],
    contexts: ['repo-map:snapshot'],
    tools: ['repo_map'],
  })
}
```

返回的 disposer 归调用方 effect scope 所有，因此插件卸载时 claim 会随之消失。名称精确匹配且区分大小写；Context Lens 不使用前缀、包名猜测或模糊匹配。

对于无法调用该 seam 的第三方插件，可以使用同样的 claim 进行静态配置：

```yaml
- id: plugin-context-lens
  name: '@kinomotomio/dsh-context-lens'
  config:
    claims:
      - plugin: '@example/repository-map'
        label: Repository Map
        sections: ['repo-map:instructions']
        contexts: ['repo-map:snapshot']
        tools: ['repo_map']
```

归因优先级为：

1. contribution event 的 `source.plugin`；
2. 贡献方 fiber 注册的 live `claim()`；
3. 操作者配置的 claim；
4. 内置 DSH manifest，并且逐包要求版本完全匹配；
5. `Unattributed`。

同一优先级出现两个 owner 时显示为 `Conflicted`，Harness 会继续运行。首个内置 manifest 覆盖 DSH `0.1.0-rc.7`。如果某个已安装包的版本不匹配，该包不会使用 manifest 归因，Lens 会显示准确度说明。

## KV cache 分析

Context Lens 把 Provider 的 token accounting 与结构性贡献变化并列展示。Cache read 占比计算方式为：

```text
cache read / prompt tokens
```

其中 `prompt tokens = uncached input + cache read`，对应 DeepSeek 的 `prompt_tokens` 恒等式（`hit + miss`）。Cache write 只在 Provider 报告时展示，且不进入分母。DeepSeek 不报告 cache write。

这些 Provider 数据与插件 token 估算始终分开。贡献变化与 cache 变化同时出现，可以作为调试 prefix 稳定性的相关性线索，但不能证明二者存在因果关系。如果 Provider 没有报告 cache 字段，Lens 会明确显示数据缺失，不会推算命中率。只有 write、没有 read 时也不会显示读取占比。

## 准确度模型

- 标题总量在有 Provider usage 时使用 `inputTokens + cacheReadTokens`。贡献者行和 Reader 份额仍用 token-meter 估算，并始终显示 `≈`。
- 估算器与 DSH token-meter 相同，按 chars/4 计密度，不是 DeepSeek tokenizer。对照 `deepseek-v4-flash`：英文长 prompt 接近 1×，中文大约低估 2×，tool schema 大约低估 2.4×，短请求会漏掉大约 70 个模板 token。
- 不要把估算当成 Provider 真值，也不要用 CJK 系数去“修正”它。Provider 不会按插件报告 token，插件份额没有可对照的真值。
- 在 DeepSeek 上，cache read 和 `hit / (miss + hit)` 是真实报告。缺失的 cache 字段保持省略，Lens 不会把 write 或命中率填成 `0`。
- Provider input 和 cache token 按原始报告展示，不会重新分摊给各插件。
- 只有捕获到的结构化 assembly 渲染结果与最终 `request/header.system` 完全一致时，才保留 live system section 边界。若不匹配，完整 system prompt 会折叠为 `Unattributed`，不会猜测。
- Cold Session 通过 `sessionPersistence.inspect()` 读取并从日志重建。结构化 system 边界只存在于当前进程，因此 cold request 通常使用保守的扁平 fallback。
- Tool 和 message surface replacement 遵循 DSH 的公开 Session fold，包括被 compact 或替换的 history。
- Reader 保留 analyzer 的 DSH 请求顺序，不会按插件重新分组 block；它不声称复现 Provider 特有的 wire 或 KV-cache prefix 序列化。

## 隐私与生命周期

插件不会追加 Session event、写入 sidecar 文件、上传数据或增加 telemetry。默认只在内存中保留每个 live Session 最近两次结构化 system assembly，并在 Session 释放时清除。Snapshot、document 和 detail RPC 使用独立的 `/dsh-plugin-context-lens` trusted-host channel，并采用带版本号的严格 schema。

初始 Breakdown snapshot 只包含元数据，不包含贡献正文。**Reveal content** 会加载单项正文；进入 **Reader** 则是另一次明确披露，会加载选中请求的全部正文。两种操作都可能把 system prompt、tool schema 和 conversation content 暴露给浏览器，因此只应在你信任其浏览器访问策略的 Host 部署中使用 Lens。

## 开发

类型与集成测试所用的 DSH `0.1.0-rc.7` 包从相邻的 `deepseek-harness` checkout 链接，不会作为 runtime dependency 打进 tarball。Manifest 测试要求该 checkout 位于精确的 `dsh-v0.1.0-rc.7` commit，并会对照源码验证每个内置包版本和 contribution name。

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm pack:check
```

CI 在 Node 22 和 24 上运行这些检查，并验证打包后的 Host、client module wrapper、类型声明和 profile bundle 元数据。

## 许可证

[MIT](LICENSE) © 2026 KinomotoMio。
