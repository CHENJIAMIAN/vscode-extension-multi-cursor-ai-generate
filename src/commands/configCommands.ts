import * as vscode from 'vscode';

/**
 * 注册配置相关的命令
 */
export function registerConfigCommands(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // 切换是否使用流式传输
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.toggleUseStreaming', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<boolean>('useStreaming');
            await config.update('useStreaming', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(vscode.l10n.t('Use Streaming: {0}', !current ? vscode.l10n.t('Enabled') : vscode.l10n.t('Disabled')));
        })
    );

    // 设置采样温度
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.setTemperature', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<number>('temperature') ?? 0.2;
            const input = await vscode.window.showInputBox({
                prompt: vscode.l10n.t('Set Temperature (0.0 - 2.0)'),
                value: current.toString(),
                validateInput: (value) => {
                    const num = parseFloat(value);
                    if (isNaN(num) || num < 0 || num > 2) {
                        return vscode.l10n.t('Please enter a number between 0.0 and 2.0');
                    }
                    return null;
                }
            });
            if (input !== undefined) {
                const temp = parseFloat(input);
                await config.update('temperature', temp, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(vscode.l10n.t('Temperature set to: {0}', temp));
            }
        })
    );

    // 设置插入内容前的分隔符
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.setPreSeparator', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<string>('preSeparator') ?? ' ';
            const input = await vscode.window.showInputBox({
                prompt: vscode.l10n.t('Set Pre-Separator'),
                value: current,
                placeHolder: vscode.l10n.t('For example: " " or "\\n"')
            });
            if (input !== undefined) {
                // 处理转义字符
                const processed = input.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
                await config.update('preSeparator', processed, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(vscode.l10n.t('Pre-Separator has been set'));
            }
        })
    );

    // 切换是否修剪结果
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.toggleTrimResult', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<boolean>('trimResult');
            await config.update('trimResult', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(vscode.l10n.t('Trim Result: {0}', !current ? vscode.l10n.t('Enabled') : vscode.l10n.t('Disabled')));
        })
    );

    // 设置日志级别
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.setLogLevel', async () => {
            const levels = ['error', 'warn', 'info', 'debug', 'trace'];
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<string>('logLevel') ?? 'info';

            const picked = await vscode.window.showQuickPick(levels, {
                title: vscode.l10n.t('Select Log Level'),
                placeHolder: vscode.l10n.t('Current: {0}', current),
                canPickMany: false
            });

            if (picked) {
                await config.update('logLevel', picked, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(vscode.l10n.t('Log Level set to: {0}', picked));
            }
        })
    );

    // 设置推理强度
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.setReasoningEffort', async () => {
            const efforts = ['none', 'low', 'medium', 'high'];
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<string>('reasoningEffort') ?? 'medium';

            const picked = await vscode.window.showQuickPick(efforts, {
                title: vscode.l10n.t('Select Reasoning Effort (Cerebras Reasoning)'),
                placeHolder: vscode.l10n.t('Current: {0}', current),
                canPickMany: false
            });

            if (picked) {
                await config.update('reasoningEffort', picked, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(vscode.l10n.t('Reasoning Effort set to: {0}', picked));
            }
        })
    );

    // 切换是否禁用推理
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.toggleDisableReasoning', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<boolean>('disableReasoning');
            await config.update('disableReasoning', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(vscode.l10n.t('Disable Reasoning: {0}', !current ? vscode.l10n.t('Enabled') : vscode.l10n.t('Disabled')));
        })
    );

    // 切换单行输出模式
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.toggleSingleLineOutput', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<boolean>('singleLineOutput');
            await config.update('singleLineOutput', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(vscode.l10n.t('Single Line Output: {0}', !current ? vscode.l10n.t('Enabled') : vscode.l10n.t('Disabled')));
        })
    );

    return disposables;
}
