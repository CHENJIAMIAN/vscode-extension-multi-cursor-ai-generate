import * as vscode from 'vscode';
import { getEffectiveConfig } from '../config';
import { render, collectContextVars } from '../prompt/template';
import { applyInsertions, StreamInserter, type InsertionResult, type SelectionTaskSpec } from '../edit/insert';
import type { Logger } from '../log/logger';
import type { TokenBucketPool } from '../net/rateLimiter';
import type { HttpClient } from '../net/httpClient';
import { withCancellableProgress } from '../ui/progress';

interface GenerateCommandDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  httpClient: HttpClient;
  rateLimiter: TokenBucketPool;
  statusBar: { update: (m: { concurrency?: number; rpm?: number; queued?: number }) => void };
}

const LAST_MODEL_KEY = 'multiCursorAI.lastModel';

export function registerGenerateCommand(deps: GenerateCommandDeps): vscode.Disposable {
  const cmd = vscode.commands.registerCommand('multiCursorAI.generate', async () => {
    const { logger, httpClient, rateLimiter, context } = deps;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('未检测到活动编辑器。');
      return;
    }

    const doc = editor.document;
    if (doc.isClosed) {
      vscode.window.showWarningMessage('当前文档已关闭。');
      return;
    }

    // 选区：空选区按整行处理；过滤空内容
    const ranges = computeSelectionRanges(editor);
    if (ranges.length === 0) {
      vscode.window.showInformationMessage('未选择文本，且所在行为空。');
      return;
    }

    const cfg = getEffectiveConfig();

    // 提示词
    const userPrompt = await vscode.window.showInputBox({
      prompt: '输入你的提示词（将对每个选区独立生成）',
      placeHolder: '例如：将所选代码重构为异步函数并添加错误处理',
      ignoreFocusOut: true,
    });
    if (userPrompt === undefined) {
      return;
    }

    // 模型选择
    const models = (cfg.modelList && cfg.modelList.length > 0) ? cfg.modelList : [cfg.modelDefault];
    const lastModel = context.globalState.get<string>(LAST_MODEL_KEY) || cfg.modelDefault;
    const picked = await vscode.window.showQuickPick(models, {
      title: '选择模型',
      placeHolder: '选择用于生成的模型',
      canPickMany: false,
      ignoreFocusOut: true,
    });
    const model = picked || lastModel || cfg.modelDefault;
    await context.globalState.update(LAST_MODEL_KEY, model);

    // 装饰器（“生成中”）
    const loadingDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      after: {
        contentText: ' ⏳ 正在生成...',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 8px',
      },
    });

    // 每个任务的装饰范围
    const decoEntries: Array<{ range: vscode.Range; options: vscode.DecorationOptions }> = ranges.map((r) => ({
      range: r,
      options: { range: r },
    }));

    // 应用“生成中”装饰
    try {
      editor.setDecorations(loadingDecoration, decoEntries.map((d) => d.options));
    } catch {
      // ignore
    }

    // 全局取消
    const globalAbort = new AbortController();

    const startTs = Date.now();
    try {
      const result = await withCancellableProgress('AI 生成中', ranges.length, async (progressCtrl) => {
        const nonStreamingResults: InsertionResult[] = [];
        const useStreaming = cfg.useStreaming === true;

        // 任务并发提交
        const taskPromises = ranges.map(async (range, idx) => {
          const taskController = new AbortController();
          // 透传全局取消
          const onGlobalAbort = () => taskController.abort();
          if (globalAbort.signal.aborted) {
            taskController.abort();
          } else {
            globalAbort.signal.addEventListener('abort', onGlobalAbort, { once: true });
          }

          try {
            if (progressCtrl.isCanceled()) {
              progressCtrl.markCanceled();
              return;
            }

            // 渲染模板
            const selectionText = doc.getText(range);
            const ctxVars = collectContextVars({
              fileName: doc.fileName,
              languageId: doc.languageId,
              uri: { toString: () => doc.uri.toString(), path: (doc as any).uri?.path },
            });

            const rendered = render({
              template: cfg.promptTemplate,
              userPrompt: userPrompt ?? '',
              selection: selectionText,
              systemPromptEnabled: cfg.systemPromptEnabled,
              globalPrependInstruction: cfg.globalPrependInstruction,
              context: ctxVars,
              trimSelection: true,
            });

            // 构造请求
            const baseReq = {
              model,
              messages: rendered.messages,
              prompt: rendered.promptText,
              temperature: cfg.temperature,
              maxTokens: cfg.maxTokens,
              stream: useStreaming,
              signal: taskController.signal,
              requestBodyMode: cfg.requestBodyMode,
              maxRetries: cfg.maxRetries,
              baseBackoffMs: cfg.baseBackoffMs,
              maxBackoffMs: cfg.maxBackoffMs,
            } as const;

            if (useStreaming) {
              // 流式插入
              const inserter = new StreamInserter({
                editor,
                range,
                mode: cfg.insertMode,
                preSeparator: cfg.preSeparator,
                postSeparator: cfg.postSeparator,
                trimResult: cfg.trimResult,
              } satisfies SelectionTaskSpec);

              await inserter.start(range);
              const genRes = await deps.rateLimiter.schedule(() =>
                httpClient.generate({
                  ...baseReq,
                  onDelta: async (delta) => {
                    // 逐步插入
                    await inserter.appendDelta(delta);
                  },
                })
              , taskController.signal);

              await inserter.finish();
              progressCtrl.markDone();
              return;
            } else {
              // 非流式：生成完成后统一插入
              const genRes = await deps.rateLimiter.schedule(
                () => httpClient.generate({ ...baseReq }),
                taskController.signal
              );

              nonStreamingResults.push({
                range,
                mode: cfg.insertMode,
                preSeparator: cfg.preSeparator,
                postSeparator: cfg.postSeparator,
                trimResult: cfg.trimResult,
                text: genRes.text ?? '',
              });
              progressCtrl.markDone();
              return;
            }
          } catch (err: any) {
            if (err?.message === 'aborted') {
              progressCtrl.markCanceled();
            } else {
              progressCtrl.markFailed();
              deps.logger.error('生成失败', err);
              showFriendlyError(err);
            }
          } finally {
            // 移除每个任务的“生成中”装饰（通过整体重设实现）
            try {
              // 重置时略过该 range
              // 简化：所有任务结束后统一移除（见 finally 外层）
            } catch {
              // ignore
            }
            globalAbort.signal.removeEventListener('abort', () => taskController.abort());
          }
        });

        // 监听取消 -> 终止在途与排队
        const cancelWatcher = (token: vscode.CancellationToken) => {
          if (token.isCancellationRequested) {
            try {
              rateLimiter.cancelAll();
              globalAbort.abort();
            } catch {
              // ignore
            }
          }
        };

        // 通过 withProgress 无法直接拿 token，这里依赖 ctrl 的 isCanceled 轮询即可
        // 额外设置一个间歇检查器
        const cancelInterval = setInterval(() => {
          if (progressCtrl.isCanceled()) {
            try {
              rateLimiter.cancelAll();
              globalAbort.abort();
            } catch {
              // ignore
            } finally {
              clearInterval(cancelInterval);
            }
          }
        }, 200);

        await Promise.allSettled(taskPromises);
        clearInterval(cancelInterval);

        // 统一插入（非流式）
        if (nonStreamingResults.length > 0) {
          const ok = await applyInsertions(nonStreamingResults);
          if (!ok) {
            vscode.window.showWarningMessage('部分编辑操作未能成功应用（可能是只读或文件已更改）。');
          }
        }
      });

      const elapsed = Date.now() - startTs;
      logger.info(`生成完成，用时 ${Math.round(elapsed)}ms`);
    } finally {
      try {
        // 移除装饰
        editor.setDecorations(loadingDecoration, []);
        loadingDecoration.dispose();
      } catch {
        // ignore
      }
    }
  });

  return cmd;
}

/** 计算选区：空选区按整行，过滤掉空内容的行/选区 */
function computeSelectionRanges(editor: vscode.TextEditor): vscode.Range[] {
  const doc = editor.document;
  const res: vscode.Range[] = [];
  for (const sel of editor.selections) {
    if (!sel || sel.isEmpty) {
      const line = doc.lineAt(sel.active.line);
      const text = line.text;
      if (text.trim().length === 0) {
        continue;
      }
      // 使用整行范围（包含行尾换行插入更自然，这里使用 line.range 以末尾前插）
      res.push(line.range);
    } else {
      const text = doc.getText(sel);
      if (text.trim().length === 0) {
        continue;
      }
      res.push(new vscode.Range(sel.start, sel.end));
    }
  }
  return res;
}

function showFriendlyError(err: any) {
  // 常见错误处理
  const msg = (err && (err.message || err.toString())) ?? String(err);
  if (/timeout/i.test(msg)) {
    vscode.window.showWarningMessage('请求超时，请稍后重试或增大超时设置（multiCursorAI.timeoutMs）。');
  } else if (/429|rate.?limit/i.test(msg)) {
    vscode.window.showWarningMessage('触发限流，已进行退避重试。可降低并发或提高限额。');
  } else if (/ENOTFOUND|ECONN|network|fetch/i.test(msg)) {
    vscode.window.showWarningMessage('网络错误，请检查代理、baseUrl 与网络连接。');
  } else if (/aborted/i.test(msg)) {
    // 取消无需提示
  } else {
    vscode.window.showWarningMessage(`生成失败：${truncate(msg, 200)}`);
  }
}

function truncate(s: string, max = 200): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}