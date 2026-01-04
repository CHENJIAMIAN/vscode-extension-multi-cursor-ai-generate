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
            vscode.window.showInformationMessage(`流式传输 (Use Streaming): ${!current ? '已启用' : '已禁用'}`);
        })
    );

    // 设置采样温度
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.setTemperature', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<number>('temperature') ?? 0.2;
            const input = await vscode.window.showInputBox({
                prompt: '设置采样温度 (0.0 - 2.0)',
                value: current.toString(),
                validateInput: (value) => {
                    const num = parseFloat(value);
                    if (isNaN(num) || num < 0 || num > 2) {
                        return '请输入 0.0 到 2.0 之间的数字';
                    }
                    return null;
                }
            });
            if (input !== undefined) {
                const temp = parseFloat(input);
                await config.update('temperature', temp, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`采样温度 (Temperature) 已设置为: ${temp}`);
            }
        })
    );

    // 设置插入内容前的分隔符
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.setPreSeparator', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<string>('preSeparator') ?? ' ';
            const input = await vscode.window.showInputBox({
                prompt: '设置插入内容前的分隔符',
                value: current,
                placeHolder: '例如: " " 或 "\\n"'
            });
            if (input !== undefined) {
                // 处理转义字符
                const processed = input.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
                await config.update('preSeparator', processed, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`前置分隔符 (Pre Separator) 已设置`);
            }
        })
    );

    // 切换是否修剪结果
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.toggleTrimResult', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<boolean>('trimResult');
            await config.update('trimResult', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`修剪结果 (Trim Result): ${!current ? '已启用' : '已禁用'}`);
        })
    );

    // 设置日志级别
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.setLogLevel', async () => {
            const levels = ['error', 'warn', 'info', 'debug', 'trace'];
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<string>('logLevel') ?? 'info';

            const picked = await vscode.window.showQuickPick(levels, {
                title: '选择日志级别',
                placeHolder: `当前: ${current}`,
                canPickMany: false
            });

            if (picked) {
                await config.update('logLevel', picked, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`日志级别 (Log Level) 已设置为: ${picked}`);
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
                title: '选择推理强度 (Cerebras Reasoning)',
                placeHolder: `当前: ${current}`,
                canPickMany: false
            });

            if (picked) {
                await config.update('reasoningEffort', picked, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`推理强度 (Reasoning Effort) 已设置为: ${picked}`);
            }
        })
    );

    // 切换是否禁用推理
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.toggleDisableReasoning', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<boolean>('disableReasoning');
            await config.update('disableReasoning', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`禁用推理 (Disable Reasoning): ${!current ? '已启用' : '已禁用'}`);
        })
    );

    // 切换单行输出模式
    disposables.push(
        vscode.commands.registerCommand('multiCursorAI.toggleSingleLineOutput', async () => {
            const config = vscode.workspace.getConfiguration('multiCursorAI');
            const current = config.get<boolean>('singleLineOutput');
            await config.update('singleLineOutput', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`单行输出 (Single Line Output): ${!current ? '已启用' : '已禁用'}`);
        })
    );

    return disposables;
}
