# Changelog

所有显著更改都会记录在此文件中。

## 0.1.0

初始版本，核心能力：
- 多光标/多选区并发生成与插入，命令：[package.json](package.json) 中 multiCursorAI.generate 与 multiCursorAI.syncModels
- 模板渲染与上下文变量：[src/prompt/template.render()](src/prompt/template.ts:1)
- 并发池 + 令牌桶限流与动态调整：[src/net/rateLimiter.TokenBucketPool](src/net/rateLimiter.ts:1)
- 指数退避 + 抖动重试：[src/net/backoff.exponentialJitter()](src/net/backoff.ts:1)
- HTTP 客户端（undici Pool + Keep-Alive + SSE）：[src/net/httpClient.HttpClient](src/net/httpClient.ts:1)
- 流式/非流式插入：[src/edit/insert.applyInsertions()](src/edit/insert.ts:1)，[src/edit/insert.StreamInserter](src/edit/insert.ts:1)
- 状态栏吞吐与可取消进度：[src/ui/status.StatusBarController](src/ui/status.ts:1)，[src/ui/progress.withCancellableProgress()](src/ui/progress.ts:1)
- SecretStorage 与环境变量 Key 管理：[src/config/index.getEffectiveConfig()](src/config/index.ts:1)
- 单元测试（mocha + chai + ts-node）：[test/backoff.test.ts](test/backoff.test.ts:1)，[test/rateLimiter.test.ts](test/rateLimiter.test.ts:1)，[test/template.test.ts](test/template.test.ts:1)