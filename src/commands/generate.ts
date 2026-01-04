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
const PROMPT_HISTORY_KEY = 'multiCursorAI.promptHistory';

export function registerGenerateCommand(deps: GenerateCommandDeps): vscode.Disposable {
  const cmd = vscode.commands.registerCommand('multiCursorAI.generate', async () => {
    const { httpClient, rateLimiter, context } = deps;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(vscode.l10n.t('No active editor detected.'));
      return;
    }

    const doc = editor.document;
    if (doc.isClosed) {
      vscode.window.showWarningMessage(vscode.l10n.t('Current document is closed.'));
      return;
    }

    // 选区：空选区按整行处理；过滤空内容
    const ranges = computeSelectionRanges(editor);
    if (ranges.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('No text selected and current line is empty.'));
      return;
    }

    const cfg = getEffectiveConfig();

    // 提示词（支持历史选择或新增，最多记住 100 条）
    const history = (context.globalState.get<string[]>(PROMPT_HISTORY_KEY) ?? [])
      .filter((s) => typeof s === 'string' && s.trim().length > 0);
    const NEW_PROMPT_LABEL = vscode.l10n.t('$(pencil) Enter new prompt...');
    const quickPickItems = history.length > 0 ? [...history, NEW_PROMPT_LABEL] : [NEW_PROMPT_LABEL];
    const pickedPromptOrNew = await vscode.window.showQuickPick(quickPickItems, {
      title: vscode.l10n.t('Select or Enter Prompt'),
      placeHolder: vscode.l10n.t('Select a history prompt, or choose "Enter new prompt..." to create new'),
      canPickMany: false,
      ignoreFocusOut: true,
    });
    if (pickedPromptOrNew === undefined) {
      return;
    }
    let userPrompt: string | undefined;
    if (pickedPromptOrNew === NEW_PROMPT_LABEL) {
      const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Enter your prompt (will be applied to each selection independently)'),
        placeHolder: vscode.l10n.t('For example: Refactor selected code to async functions with error handling'),
        ignoreFocusOut: true,
      });
      if (input === undefined) {
        return;
      }
      userPrompt = input.trim();
    } else {
      userPrompt = pickedPromptOrNew.trim();
    }
    if (!userPrompt) {
      vscode.window.showInformationMessage(vscode.l10n.t('Prompt cannot be empty.'));
      return;
    }
    // 更新历史：将本次提示词移到最前，去重并限制为最新 100 条
    const newHistory = [userPrompt, ...history.filter((s) => s !== userPrompt)].slice(0, cfg.promptHistoryLimit);
    await context.globalState.update(PROMPT_HISTORY_KEY, newHistory);

    // 模型选择
    const models = (cfg.modelList && cfg.modelList.length > 0) ? cfg.modelList : [cfg.modelDefault];
    const lastModel = context.globalState.get<string>(LAST_MODEL_KEY) || cfg.modelDefault;
    // 若上次选择的模型在当前可用模型中，则将其放到最前
    const modelsForPick = models.includes(lastModel)
      ? [lastModel, ...models.filter((m) => m !== lastModel)]
      : models;

    const picked = await vscode.window.showQuickPick(modelsForPick, {
      title: vscode.l10n.t('Select Model'),
      placeHolder: vscode.l10n.t('Select model for generation'),
      canPickMany: false,
      ignoreFocusOut: true,
    });
    const model = picked || lastModel || cfg.modelDefault;
    await context.globalState.update(LAST_MODEL_KEY, model);

    // 装饰器（"生成中"）
    const loadingDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      after: {
        contentText: vscode.l10n.t(' Generating...'),
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

    // 跟踪未完成的 loading 装饰，便于在流式模式下按任务完成逐个清除
    const keyForRange = (r: vscode.Range) => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
    const pendingLoadingDecos = new Map<string, vscode.DecorationOptions>();
    for (const e of decoEntries) {
      pendingLoadingDecos.set(keyForRange(e.range), e.options);
    }
    const clearLoadingDecorationFor = (r: vscode.Range) => {
      try {
        pendingLoadingDecos.delete(keyForRange(r));
        editor.setDecorations(loadingDecoration, Array.from(pendingLoadingDecos.values()));
      } catch {
        // ignore
      }
    };

    // 全局取消
    const globalAbort = new AbortController();

    const startTs = Date.now();
    try {
      await withCancellableProgress(vscode.l10n.t('AI Generating'), ranges.length, async (progressCtrl) => {
        const nonStreamingResults: InsertionResult[] = [];
        const useStreaming = cfg.useStreaming === true;

        // 任务并发提交
        const taskPromises = ranges.map(async (range, _idx) => {
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
              reasoningEffort: cfg.reasoningEffort,
              disableReasoning: cfg.disableReasoning,
            } as const;

            if (useStreaming) {
              // 流式插入
              // 保存原内容，以便在 AI 返回空内容时恢复
              const originalText = selectionText;

              const inserter = new StreamInserter({
                editor,
                range,
                mode: cfg.insertMode,
                preSeparator: cfg.preSeparator,
                postSeparator: cfg.postSeparator,
                trimResult: cfg.trimResult,
              } satisfies SelectionTaskSpec);

              await inserter.start();
              const res = await deps.rateLimiter.schedule(() =>
                httpClient.generate({
                  ...baseReq,
                  onDelta: async (delta) => {
                    // 如果开启单行模式，实时替换换行符
                    if (cfg.singleLineOutput) {
                      delta = delta.replace(/\r\n|\r|\n/g, '\\n');
                    }
                    // 逐步插入
                    await inserter.appendDelta(delta);
                  },
                })
                , taskController.signal);

              await inserter.finish();

              // 流式任务完成后，从全局追踪器中移除，释放资源
              inserter.dispose();

              // 检查生成结果是否为空
              let generatedText = (res.text ?? '').trim();
              if (cfg.singleLineOutput) {
                // 虽流式已替换，但在完整性检查时保持逻辑一致 (其实 stream 下 res.text 可能也是原始的，取决于 httpClient 实现，稳妥起见不依赖 res.text 做展示，只做非空检查)
                // 注意：httpClient.generate 返回的 text 是累积后的完整文本。
                // 如果我们在 onDelta 里替换了，累积的 text 可能还是原始的（取决于 httpClient 是否用 onDelta 的结果去累积）。
                // 查看 httpClient 代码通常是直接累积 raw delta。
                // 但这里只用来判空，所以无所谓是否转义。
              }

              if (!generatedText) {
                // AI 返回空内容（可能是推理被截断等情况），需要恢复原内容
                deps.logger.warn(vscode.l10n.t('AI returned empty content, restoring original text'), {
                  reasoningLength: res.reasoning?.length ?? 0,
                  originalTextLength: originalText.length
                });
                try {
                  // 调用 inserter 的恢复方法来正确删除已插入的分隔符并恢复原文
                  await inserter.restoreOriginal(originalText);
                } catch (restoreErr) {
                  deps.logger.error(vscode.l10n.t('Failed to restore original content'), restoreErr);
                }
                vscode.window.showWarningMessage(vscode.l10n.t('AI returned empty content, original text preserved. The model reasoning may have been truncated, please retry.'));
              }

              progressCtrl.markDone();
              return;
            } else {
              // 非流式：生成完成后统一插入
              const genRes = await deps.rateLimiter.schedule(
                () => httpClient.generate({ ...baseReq }),
                taskController.signal
              );

              let finalText = genRes.text ?? '';
              if (cfg.singleLineOutput) {
                finalText = finalText.replace(/\r\n|\r|\n/g, '\\n');
              }

              nonStreamingResults.push({
                range,
                mode: cfg.insertMode,
                preSeparator: cfg.preSeparator,
                postSeparator: cfg.postSeparator,
                trimResult: cfg.trimResult,
                text: finalText,
              });
              progressCtrl.markDone();
              return;
            }
          } catch (err: any) {
            if (err?.message === 'aborted') {
              progressCtrl.markCanceled();
            } else {
              progressCtrl.markFailed();
              deps.logger.error(vscode.l10n.t('Generation failed'), err);
              showFriendlyError(err);
            }
          } finally {
            // 流式模式：该选区任务结束（成功/失败/取消）即移除对应的 loading 装饰
            try {
              if (useStreaming) {
                clearLoadingDecorationFor(range);
              }
            } catch {
              // ignore
            }
            globalAbort.signal.removeEventListener('abort', onGlobalAbort);
          }
        });

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
            vscode.window.showWarningMessage(vscode.l10n.t('Some edit operations failed to apply (file may be read-only or changed).'));
          }
        }
      });

      const elapsed = Date.now() - startTs;
      deps.logger.info(vscode.l10n.t('Generation completed in {0}ms', Math.round(elapsed)));
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
    vscode.window.showWarningMessage(vscode.l10n.t('Request timeout. Please retry later or increase timeout setting (multiCursorAI.timeoutMs).'));
  } else if (/429|rate.?limit/i.test(msg)) {
    vscode.window.showWarningMessage(vscode.l10n.t('Rate limit triggered, backoff retry performed. Consider reducing concurrency or increasing quota.'));
  } else if (/ENOTFOUND|ECONN|network|fetch/i.test(msg)) {
    vscode.window.showWarningMessage(vscode.l10n.t('Network error. Please check proxy, baseUrl and network connection.'));
  } else if (/aborted/i.test(msg)) {
    // 取消无需提示
  } else {
    vscode.window.showWarningMessage(vscode.l10n.t('Generation failed: {0}', truncate(msg, 200)));
  }
}

function truncate(s: string, max = 200): string {
  if (!s) {
    return '';
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}