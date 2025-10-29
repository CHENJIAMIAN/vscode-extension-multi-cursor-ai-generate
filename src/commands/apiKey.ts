import * as vscode from 'vscode';
import type { Logger } from '../log/logger';
import type { HttpClient } from '../net/httpClient';
import { getEffectiveConfig, setSecret } from '../config';

export interface ApiKeyDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  httpClient: HttpClient;
}

// 提供两个命令：
// - multiCursorAI.setApiKey: 输入并保存 API Key 至 SecretStorage，立即生效
// - multiCursorAI.clearApiKey: 从 SecretStorage 清除 API Key，并将 HttpClient 中的 key 清空
export function registerApiKeyCommands(deps: ApiKeyDeps): vscode.Disposable {
  const { context, logger, httpClient } = deps;

  const setCmd = vscode.commands.registerCommand('multiCursorAI.setApiKey', async () => {
    const input = await vscode.window.showInputBox({
      title: '设置 API Key',
      prompt: '输入用于调用 OpenAI 风格端点的 API Key（将安全保存在 SecretStorage）',
      placeHolder: '例如：sk-****************',
      password: true,
      ignoreFocusOut: true,
      validateInput: (val) => (val.trim().length === 0 ? 'API Key 不能为空' : undefined),
    });
    if (input === undefined) {
      return; // 用户取消
    }

    const key = input.trim();
    try {
      const cfg = getEffectiveConfig();
      await setSecret(context.secrets, cfg, key);
      // 热更新 HttpClient
      httpClient.updateOptions({ apiKey: key });
      vscode.window.showInformationMessage('API Key 已保存至 SecretStorage 并立即生效。');
    } catch (err: any) {
      logger.error('保存 API Key 失败', err);
      vscode.window.showErrorMessage(`保存 API Key 失败：${err?.message || String(err)}`);
    }
  });

  const clearCmd = vscode.commands.registerCommand('multiCursorAI.clearApiKey', async () => {
    const confirm = await vscode.window.showQuickPick(
      [
        { label: '确认清除', description: '从 SecretStorage 移除 API Key' },
        { label: '取消', description: '不进行任何操作' },
      ],
      { title: '清除 API Key', placeHolder: '此操作仅影响本机 SecretStorage', ignoreFocusOut: true }
    );
    if (!confirm || confirm.label !== '确认清除') {
      return;
    }

    try {
      const cfg = getEffectiveConfig();
      await context.secrets.delete(cfg.apiKeySecretId);
      httpClient.updateOptions({ apiKey: '' });
      vscode.window.showInformationMessage('已清除 API Key。');
    } catch (err: any) {
      logger.error('清除 API Key 失败', err);
      vscode.window.showErrorMessage(`清除 API Key 失败：${err?.message || String(err)}`);
    }
  });

  return vscode.Disposable.from(setCmd, clearCmd);
}