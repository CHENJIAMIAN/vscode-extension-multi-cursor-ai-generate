import { fetch, Headers, RequestInit, Pool, ProxyAgent, type Dispatcher } from 'undici';
import { exponentialJitter } from './backoff';
import type { LogLevel } from '../log/logger';

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  authScheme: string;
  timeoutMs: number;
  proxy?: string;
  rejectUnauthorized: boolean;
  requestPath: string;
  modelsPath: string;
  httpMaxConnections: number;
  useStreaming: boolean;
  logger?: {
    error: (msg: string, err?: unknown) => void;
    warn: (msg: string, details?: unknown) => void;
    info: (msg: string, details?: unknown) => void;
    debug: (msg: string, details?: unknown) => void;
    trace: (msg: string, details?: unknown) => void;
  };
  onRateLimitHint?: (hint: ServerRateLimitHint) => void;
}

export interface ServerRateLimitHint {
  retryAfterMs?: number;
  limitPerMinuteHint?: number;
}

export interface GenerateParams {
  model: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant' | string; content: string }>;
  prompt?: string; // 用于 /v1/completions
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  requestBodyMode: 'auto' | 'chat' | 'completions';
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  onDelta?: (deltaText: string) => void; // SSE 增量文本
}

export interface GenerateResult {
  text: string;
  raw?: unknown;
}

type Closeable = { close: () => Promise<void> | void };

export class HttpClient {
  private opts: HttpClientOptions;
  private dispatcher?: Dispatcher & Partial<Closeable>;
  private baseOrigin: string;

  constructor(options: HttpClientOptions) {
    this.opts = { ...options };
    this.baseOrigin = normalizeOrigin(options.baseUrl);
    this.rebuildDispatcher();
  }

  public updateOptions(next: Partial<HttpClientOptions>) {
    const prev = this.opts;
    this.opts = { ...this.opts, ...(next as HttpClientOptions) };
    const newOrigin = normalizeOrigin(this.opts.baseUrl);
    const needRebuild =
      newOrigin !== this.baseOrigin ||
      next.proxy !== undefined ||
      (typeof next.rejectUnauthorized === 'boolean') ||
      (typeof next.httpMaxConnections === 'number');

    if (needRebuild) {
      this.baseOrigin = newOrigin;
      this.rebuildDispatcher();
      this.log('info', 'HTTP dispatcher 已重建', {
        baseOrigin: this.baseOrigin,
        proxy: !!this.opts.proxy,
        rejectUnauthorized: this.opts.rejectUnauthorized,
        connections: this.opts.httpMaxConnections,
      });
    }
  }

  public async dispose() {
    try {
      if (this.dispatcher && 'close' in this.dispatcher && typeof this.dispatcher.close === 'function') {
        await this.dispatcher.close();
      }
    } catch {
      // ignore
    }
  }

  private rebuildDispatcher() {
    // 优先使用代理；否则使用 Pool 以获得 Keep-Alive 与连接池
    if (this.opts.proxy && this.opts.proxy.trim()) {
      this.dispatcher = new ProxyAgent(this.opts.proxy.trim());
    } else {
      // Pool 绑定到 base origin
      this.dispatcher = new Pool(this.baseOrigin, {
        connections: Math.max(1, Math.floor(this.opts.httpMaxConnections || 1)),
        connect: {
          // TLS 校验
          rejectUnauthorized: this.opts.rejectUnauthorized !== false,
        },
        // 尝试保活；undici 默认会 Keep-Alive
        pipelining: 1,
      });
    }
  }

  public async getModels(signal?: AbortSignal): Promise<string[]> {
    const url = new URL(this.opts.modelsPath || '/v1/models', this.opts.baseUrl).toString();
    const res = await this.doFetch(url, {
      method: 'GET',
      headers: this.authHeaders(),
      signal,
    });
    this.applyRateLimitHint(res);
    if (!res.ok) {
      const errText = await safeReadText(res);
      throw createHttpError('获取模型失败', res.status, errText);
    }
    const json = await res.json().catch(() => undefined as any);
    // 兼容 OpenAI 风格
    if (json && Array.isArray(json.data)) {
      const ids = json.data.map((m: any) => m.id).filter((s: any) => typeof s === 'string');
      return ids;
    }
    // 其他形态，尝试字符串数组
    if (Array.isArray(json)) {
      return json.filter((s: any) => typeof s === 'string');
    }
    return [];
  }

  /**
   * 发送生成请求：自动选择 chat/completions 或根据 requestBodyMode 强制
   * - 非流式：返回完整文本
   * - 流式：解析 SSE，逐步回调 onDelta，并返回最终拼接文本
   */
  public async generate(params: GenerateParams): Promise<GenerateResult> {
    const {
      model,
      messages,
      prompt,
      temperature,
      maxTokens,
      stream = this.opts.useStreaming,
      signal,
      requestBodyMode,
      maxRetries,
      baseBackoffMs,
      maxBackoffMs,
      onDelta,
    } = params;

    const url = new URL(this.opts.requestPath || '/v1/chat/completions', this.opts.baseUrl).toString();

    const bodyMode = decideBodyMode(requestBodyMode, this.opts.requestPath);
    const body = buildOpenAIStyleBody({
      bodyMode,
      model,
      messages,
      prompt,
      temperature,
      maxTokens,
      stream,
    });

    const headers = this.authHeaders();
    headers.set('content-type', 'application/json');

    // 带重试的发送
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        const res = await this.doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });

        this.applyRateLimitHint(res);

        if (!res.ok) {
          const errText = await safeReadText(res);
          // 429/503 进入重试
          if ((res.status === 429 || res.status === 503) && attempt <= maxRetries) {
            const retryAfterMs = parseRetryAfterMs(res);
            this.opts.onRateLimitHint?.({ retryAfterMs });
            const delay = retryAfterMs ?? exponentialJitter(attempt, baseBackoffMs, maxBackoffMs);
            this.log('warn', `HTTP ${res.status}，将在 ${delay}ms 后重试（第 ${attempt - 1}/${maxRetries} 次重试后）。`, errText);
            await sleep(delay, signal);
            continue;
          }
          throw createHttpError('生成请求失败', res.status, errText);
        }

        const ctype = res.headers.get('content-type') || '';
        if (stream && ctype.includes('text/event-stream')) {
          const text = await this.consumeSSE(res, onDelta, signal);
          return { text };
        } else {
          const json = await res.json().catch(async () => {
            // 某些服务端在流模式关闭或错误时仍返回文本
            const t = await safeReadText(res);
            return t;
          });
          const text = extractTextFromOpenAIResponse(json);
          return { text, raw: json };
        }
      } catch (err: any) {
        lastErr = err;
        // 网络/超时/取消处理
        if (isAbortError(err)) {
          throw err;
        }
        if (attempt <= maxRetries) {
          const delay = exponentialJitter(attempt, baseBackoffMs, maxBackoffMs);
          this.log('warn', `请求异常，将在 ${delay}ms 后重试（第 ${attempt}/${maxRetries} 次）。`, err?.message || err);
          await sleep(delay, signal);
          continue;
        }
        break;
      }
    }
    throw lastErr ?? new Error('unknown error');
  }

  private async consumeSSE(res: Response, onDelta?: (deltaText: string) => void, signal?: AbortSignal): Promise<string> {
    const reader = (res.body as any)?.getReader?.();
    if (!reader) {
      // 不支持 WebReadableStream（Node 低版本），退化为一次性读取
      const text = await safeReadText(res);
      return text;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    let totalText = '';

    while (true) {
      if (signal?.aborted) {
        throw new Error('aborted');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            completed = true;
            break;
          }
          try {
            const j = JSON.parse(data);
            const delta = extractDeltaFromSSE(j);
            if (delta) {
              totalText += delta;
              onDelta?.(delta);
            }
          } catch {
            // 非 JSON 行忽略
          }
        }
      }
      if (completed) break;
    }
    return totalText;
  }

  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = this.opts.timeoutMs ?? 60000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const externalSignal = init.signal as AbortSignal | undefined;

    const onAbort = () => {
      controller.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // 合并 signal
    const mergedInit: RequestInit = {
      ...init,
      signal: controller.signal,
      dispatcher: this.dispatcher,
    };

    if (timeout > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeout);
    }

    try {
      this.log('debug', 'HTTP 请求', { url, method: init.method });
      const res = await fetch(url, mergedInit);
      return res as unknown as Response;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  private authHeaders(): Headers {
    const h = new Headers();
    const val = (this.opts.apiKey || '').trim();
    if (val) {
      h.set('authorization', `${this.opts.authScheme || 'Bearer'} ${val}`);
    }
    return h;
  }

  private applyRateLimitHint(res: Response) {
  const hint: ServerRateLimitHint = {};
  const retryAfterMs = parseRetryAfterMs(res);
  if (retryAfterMs !== undefined) {
    hint.retryAfterMs = retryAfterMs;
  }
  const perMin = parseLimitPerMinute(res);
  if (perMin !== undefined) {
    hint.limitPerMinuteHint = perMin;
  }

  this.log('trace', '已完成服务端速率限制提示头检查', {
    hasRetryAfter: retryAfterMs !== undefined,
    hasLimitPerMinute: perMin !== undefined,
    statusCode: res.status,
    url: res.url,
  });

  // 有提示时：记录详情并通知回调
  if (hint.retryAfterMs !== undefined || hint.limitPerMinuteHint !== undefined) {
    this.log('debug', '检测到服务端速率限制提示', {
      retryAfterMs: hint.retryAfterMs,
      limitPerMinuteHint: hint.limitPerMinuteHint,
      headers: {
        'retry-after': res.headers.get('retry-after'),
        'x-ratelimit-limit-requests': res.headers.get('x-ratelimit-limit-requests'),
        'x-ratelimit-limit-tokens': res.headers.get('x-ratelimit-limit-tokens'),
        'x-ratelimit-remaining-requests': res.headers.get('x-ratelimit-remaining-requests'),
        'x-ratelimit-minute': res.headers.get('x-ratelimit-minute'),
        'x-requests-per-minute': res.headers.get('x-requests-per-minute'),
        'ratelimit-limit': res.headers.get('ratelimit-limit'),
      },
    });
    this.opts.onRateLimitHint?.(hint);
  }
}


  private log(level: LogLevel, msg: string, details?: unknown) {
    try {
      if (!this.opts.logger) return;
      this.opts.logger[level](msg, details);
    } catch {
      // ignore
    }
  }
}

/** 根据配置选择 body 模式 */
function decideBodyMode(mode: 'auto' | 'chat' | 'completions', requestPath: string): 'chat' | 'completions' {
  if (mode === 'chat' || mode === 'completions') return mode;
  const p = (requestPath || '').toLowerCase();
  if (p.includes('/chat/completions')) return 'chat';
  if (p.includes('/completions')) return 'completions';
  return 'chat';
}

function buildOpenAIStyleBody(input: {
  bodyMode: 'chat' | 'completions';
  model: string;
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}) {
  const common: any = {
    model: input.model,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    stream: !!input.stream,
  };
  if (input.bodyMode === 'chat') {
    return {
      ...common,
      messages: input.messages ?? [{ role: 'user', content: input.prompt ?? '' }],
    };
  } else {
    return {
      ...common,
      prompt: input.prompt ?? joinMessagesToPrompt(input.messages),
    };
  }
}

function joinMessagesToPrompt(messages?: Array<{ role: string; content: string }>): string | undefined {
  if (!messages || messages.length === 0) return undefined;
  return messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
}

function extractTextFromOpenAIResponse(json: any): string {
  if (!json) return '';
  // chat/completions
  const choices = json.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && first.message && typeof first.message.content === 'string') {
      return first.message.content;
    }
    if (typeof first.text === 'string') {
      return first.text;
    }
    // 某些兼容实现把 delta 合在 content 中
    if (first.delta && typeof first.delta.content === 'string') {
      return first.delta.content;
    }
  }
  // 兜底
  if (typeof json === 'string') return json;
  try {
    return JSON.stringify(json);
  } catch {
    return '';
  }
}

function extractDeltaFromSSE(json: any): string {
  // OpenAI SSE: { choices: [ { delta: { content?: string } } ] }
  const c = json?.choices?.[0];
  if (c?.delta?.content) return String(c.delta.content);
  if (typeof c?.text === 'string') return c.text;
  // 一些供应商直接使用 { data: "..." }
  if (typeof json?.data === 'string') return json.data;
  return '';
}

function parseRetryAfterMs(res: Response): number | undefined {
  const rh = res.headers.get('retry-after');
  if (!rh) return undefined;
  const asNum = Number(rh);
  if (Number.isFinite(asNum)) {
    // 秒
    return Math.max(0, Math.floor(asNum * 1000));
  }
  const date = Date.parse(rh);
  if (Number.isFinite(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

function parseLimitPerMinute(res: Response): number | undefined {
  // 尝试多种头
  const keys = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-minute',
    'x-requests-per-minute',
    'ratelimit-limit',
  ];
  for (const k of keys) {
    const v = res.headers.get(k);
    if (!v) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      return Math.floor(n);
    }
    // 一些格式可能是 "600, minute"
    const n2 = Number(String(v).split(',')[0]);
    if (Number.isFinite(n2) && n2 > 0) {
      return Math.floor(n2);
    }
  }
  return undefined;
}

function normalizeOrigin(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    // 只保留协议+主机+端口
    return `${u.protocol}//${u.host}`;
  } catch {
    // 失败则直接返回
    return baseUrl;
  }
}

function isAbortError(err: any): boolean {
  if (!err) return false;
  return err.name === 'AbortError' || /abort/i.test(err.message || '');
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// 新增：标准化的 HTTP 错误对象
function createHttpError(message: string, status: number, body?: string): Error {
  const err = new Error(`${message} (status=${status})${body ? `: ${truncate(body, 200)}` : ''}`);
  (err as any).status = status;
  (err as any).body = body;
  return err;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}