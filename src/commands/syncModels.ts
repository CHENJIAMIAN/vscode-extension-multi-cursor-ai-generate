import * as vscode from 'vscode';
import type { Logger } from '../log/logger';
import type { HttpClient } from '../net/httpClient';
import { syncModels as syncRegistry } from '../model/modelRegistry';

interface SyncModelsDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  httpClient: HttpClient;
}

export function registerSyncModelsCommand(deps: SyncModelsDeps): vscode.Disposable {
  const { logger, httpClient } = deps;

  const cmd = vscode.commands.registerCommand('multiCursorAI.syncModels', async () => {
    const controller = new AbortController();
    const pick = await vscode.window.showQuickPick(
      [
        { label: '开始同步', description: '从远端拉取模型列表并更新设置' },
        { label: '取消', description: '不进行任何操作' },
      ],
      { placeHolder: '模型同步', ignoreFocusOut: true }
    );
    if (!pick || pick.label !== '开始同步') {
      return;
    }

    try {
      const models = await vscode.window.withProgress<string[]>(
        {
          location: vscode.ProgressLocation.Notification,
          title: '正在同步模型列表…',
          cancellable: true,
        },
        async (_progress, token) => {
          const onAbort = () => controller.abort();
          token.onCancellationRequested(onAbort);
          try {
            return await syncRegistry({ httpClient, logger }, controller.signal);
          } finally {
            token.onCancellationRequested(onAbort).dispose();
          }
        }
      );

      if (models && models.length > 0) {
        const picked = await vscode.window.showQuickPick(models, {
          title: `同步成功（${models.length}）- 选择一个模型作为参考`,
          canPickMany: false,
          ignoreFocusOut: true,
        });
        if (picked) {
          await vscode.workspace.getConfiguration('multiCursorAI').update('modelDefault', picked, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`已将默认模型设置为：${picked}`);
        }
      }
    } catch (err: any) {
      if (err?.message === 'aborted') {
        vscode.window.showInformationMessage('模型同步已取消。');
        return;
      }
      logger.error('模型同步执行失败', err);
      vscode.window.showErrorMessage(`模型同步失败：${err?.message || String(err)}`);
    }
  });

  return cmd;
}