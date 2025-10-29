import * as vscode from 'vscode';

export interface ProgressCounters {
  total: number;
  done: number;
  failed: number;
  canceled: number;
}

export interface ProgressController {
  isCanceled(): boolean;
  reportIncrement(by?: number): void;
  markDone(): void;
  markFailed(): void;
  markCanceled(): void;
  getCounters(): ProgressCounters;
}

/**
 * 以可取消的形式展示进度，内部维护计数并在标题与消息上显示。
 * 使用方式：
 *   await withCancellableProgress('AI 生成中', total, async (ctrl) => {
 *     for (const t of tasks) {
 *       if (ctrl.isCanceled()) break;
 *       try { ...; ctrl.markDone(); } catch { ctrl.markFailed(); }
 *     }
 *   });
 */
export async function withCancellableProgress<T>(
  title: string,
  total: number,
  fn: (ctrl: ProgressController) => Promise<T>
): Promise<T> {
  return await vscode.window.withProgress<T>(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken
    ) => {
      const counters: ProgressCounters = { total, done: 0, failed: 0, canceled: 0 };

      const updateMessage = () => {
        const parts: string[] = [];
        parts.push(`总数 ${counters.total}`);
        parts.push(`完成 ${counters.done}`);
        if (counters.failed) parts.push(`失败 ${counters.failed}`);
        if (counters.canceled) parts.push(`取消 ${counters.canceled}`);
        progress.report({
          message: parts.join(' · '),
          increment: 0,
        });
      };

      const controller: ProgressController = {
        isCanceled: () => token.isCancellationRequested,
        reportIncrement: (by?: number) => {
          const inc = typeof by === 'number' ? by : 0;
          progress.report({ increment: inc });
          updateMessage();
        },
        markDone: () => {
          counters.done += 1;
          const inc = counters.total > 0 ? 100 / counters.total : 0;
          progress.report({ increment: inc });
          updateMessage();
        },
        markFailed: () => {
          counters.failed += 1;
          updateMessage();
        },
        markCanceled: () => {
          counters.canceled += 1;
          updateMessage();
        },
        getCounters: () => ({ ...counters }),
      };

      updateMessage();
      try {
        const ret = await fn(controller);
        return ret;
      } finally {
        // no-op, 让通知自动关闭
      }
    }
  );
}