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
      title: vscode.l10n.t('Set API Key'),
      prompt: vscode.l10n.t('Enter API Key for OpenAI-compatible endpoint (will be securely saved in SecretStorage)'),
      placeHolder: vscode.l10n.t('For example: sk-****************'),
      password: true,
      ignoreFocusOut: true,
      validateInput: (val) => (val.trim().length === 0 ? vscode.l10n.t('API Key cannot be empty') : undefined),
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
      vscode.window.showInformationMessage(vscode.l10n.t('API Key saved to SecretStorage and now effective.'));
    } catch (err: any) {
      logger.error(vscode.l10n.t('Failed to save API Key'), err);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to save API Key: {0}', err?.message || String(err)));
    }
  });

  const clearCmd = vscode.commands.registerCommand('multiCursorAI.clearApiKey', async () => {
    const confirm = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t('Confirm Clear'), description: vscode.l10n.t('Remove API Key from SecretStorage') },
        { label: vscode.l10n.t('Cancel'), description: vscode.l10n.t('Do nothing') },
      ],
      { title: vscode.l10n.t('Clear API Key'), placeHolder: vscode.l10n.t('This operation only affects local SecretStorage'), ignoreFocusOut: true }
    );
    if (!confirm || confirm.label !== vscode.l10n.t('Confirm Clear')) {
      return;
    }

    try {
      const cfg = getEffectiveConfig();
      await context.secrets.delete(cfg.apiKeySecretId);
      httpClient.updateOptions({ apiKey: '' });
      vscode.window.showInformationMessage(vscode.l10n.t('API Key cleared.'));
    } catch (err: any) {
      logger.error(vscode.l10n.t('Failed to clear API Key'), err);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to clear API Key: {0}', err?.message || String(err)));
    }
  });

  return vscode.Disposable.from(setCmd, clearCmd);
}