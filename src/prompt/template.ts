/* 不引入 vscode 以便在测试环境（mocha/ts-node）中无需依赖 vscode 运行时 */

export interface RenderContextVars {
  fileName?: string;
  languageId?: string;
  relativePath?: string;
  now?: string; // ISO
}

export interface RenderInput {
  template: string;
  userPrompt: string;
  selection: string;
  systemPromptEnabled: boolean;
  globalPrependInstruction?: string;
  context: RenderContextVars;
  trimSelection?: boolean;
  maxSelectionChars?: number;
}

export interface RenderOutput {
  // OpenAI 风格 chat 消息
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  // 若需要 completions 兼容，可拼为 prompt
  promptText: string;
}

/**
 * 渲染模板：
 * - 变量替换 {userPrompt} / {selection} / {fileName} / {languageId} / {relativePath} / {now}
 * - 可选地在最前拼接 globalPrependInstruction
 * - 如果启用 systemPromptEnabled，则将 globalPrependInstruction 作为 system 消息发送
 */
export function render(input: RenderInput): RenderOutput {
  const selectionClean = input.trimSelection !== false
    ? trimBlankLines(limitLength(input.selection ?? '', input.maxSelectionChars ?? 120000))
    : limitLength(input.selection ?? '', input.maxSelectionChars ?? 120000);

  const vars: Record<string, string> = {
    userPrompt: input.userPrompt ?? '',
    selection: selectionClean,
    fileName: input.context.fileName ?? '',
    languageId: input.context.languageId ?? '',
    relativePath: input.context.relativePath ?? '',
    now: input.context.now ?? new Date().toISOString(),
  };

  const userBody = interpolate(input.template, vars);
  let promptText = '';
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];

  if (input.systemPromptEnabled && input.globalPrependInstruction?.trim()) {
    messages.push({
      role: 'system',
      content: input.globalPrependInstruction.trim(),
    });
  }

  let userContent = userBody;
  if (!input.systemPromptEnabled && input.globalPrependInstruction?.trim()) {
    // 若未用 system，则把全局指令作为用户提示前置
    userContent = input.globalPrependInstruction.trim() + '\n\n' + userBody;
  }

  messages.push({
    role: 'user',
    content: userContent,
  });

  promptText = joinMessagesAsPrompt(messages);

  return {
    messages,
    promptText,
  };
}

/**
 * 将变量形如 {var} 替换为值，未匹配的保留原样
 */
function interpolate(tpl: string, vars: Record<string, string>): string {
  return (tpl ?? '').replace(/\{([a-zA-Z0-9_.]+)\}/g, (_m, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key] ?? '');
    }
    return _m;
  });
}

/**
 * 去掉首尾空行并 Trim
 */
function trimBlankLines(text: string): string {
  const lines = (text ?? '').split(/\r?\n/);
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && lines[start].trim() === '') start++;
  while (end >= start && lines[end].trim() === '') end--;
  const sliced = lines.slice(start, end + 1).join('\n');
  return sliced.trim();
}

function limitLength(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return text ?? '';
  const s = text ?? '';
  return s.length > max ? s.slice(0, max) : s;
}

function joinMessagesAsPrompt(messages: Array<{ role: string; content: string }>): string {
  return messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
}

/**
 * 收集上下文变量：安全实现，不依赖 vscode 模块
 * - 仅基于传入对象的 fileName/languageId/uri 推断
 * - relativePath 若无法确定工作区，相当于 fileName
 */
export function collectContextVars(
  doc: { fileName?: string; languageId?: string; uri?: { toString?: () => string; path?: string } } | undefined
): RenderContextVars {
  if (!doc) return { now: new Date().toISOString() };
  const fileName = doc.fileName ? basename(doc.fileName) : '';
  const languageId = doc.languageId || '';
  const now = new Date().toISOString();

  let relativePath = '';
  try {
    // 尝试从 uri.path / fileName 近似得到
    if (doc.uri && typeof doc.uri.toString === 'function') {
      const p = (doc.uri as any).path ?? (doc.uri as any).toString?.() ?? fileName;
      relativePath = String(p || fileName);
    } else {
      relativePath = fileName;
    }
  } catch {
    relativePath = fileName;
  }

  return {
    fileName,
    languageId,
    relativePath,
    now,
  };
}

function basename(p: string): string {
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export const __test__ = {
  interpolate,
  trimBlankLines,
  limitLength,
  joinMessagesAsPrompt,
};