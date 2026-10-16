import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { bindAiContext, currentAiRecorder, traceAiCall } from '../planning/ai-recorder.js';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  ModelSettingsSchema,
  type ModelSettings,
  type ModelOption,
  type ModelSettingsResponse,
} from '@stree/shared';
import path from 'node:path';
import { config, runtimeRoot } from '../config.js';
import { AppError } from '../errors.js';

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string; code: number };
};
export type DynamicTool = {
  type: 'function';
  name: string;
  description: string;
  inputSchema: object;
};
type ToolHandler = (name: string, args: unknown) => Promise<unknown>;
export class CodexClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private startup: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private events = new EventEmitter();
  private handlers = new Map<string, ToolHandler>();
  private model = '';
  private models: ModelOption[] = [];
  private selection: ModelSettings = { model: null, effort: null };
  private authenticated = false;
  private closed = false;
  private agentDirectory = path.join(runtimeRoot, 'agent');
  constructor(
    private binary = config.CODEX_BIN,
    private settingsPath = path.join(runtimeRoot, 'model-settings.json'),
  ) {
    this.events.setMaxListeners(100);
  }
  private write(message: RpcMessage) {
    if (!this.process || this.process.stdin.destroyed)
      throw new AppError('Codex App Server 未连接。', 503);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private request<T = any>(method: string, params: any = {}, timeout = 30000): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(`Codex 接口 ${method} 响应超时。`, 504));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private async receive(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error)
        pending.reject(
          new AppError(
            'Codex 接口返回错误，请检查 CLI 版本、模型配置及账户额度。',
            502,
            'CODEX_RPC_ERROR',
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (message.method === 'item/tool/call') {
        const params = message.params;
        const handler = this.handlers.get(params.threadId);
        try {
          if (!handler) throw new AppError('该规划任务已结束。');
          const output = await handler(params.tool, params.arguments);
          this.write({
            id: message.id,
            result: {
              contentItems: [{ type: 'inputText', text: JSON.stringify(output) }],
              success: true,
            },
          });
        } catch (error) {
          const text = error instanceof AppError ? error.message : '工具执行失败，请调整查询条件。';
          this.write({
            id: message.id,
            result: {
              contentItems: [{ type: 'inputText', text: JSON.stringify({ error: text }) }],
              success: false,
            },
          });
        }
      } else if (message.method.includes('requestApproval'))
        this.write({ id: message.id, result: { decision: 'decline' } });
      else
        this.write({
          id: message.id,
          error: { code: -32601, message: 'This travel client does not support this request.' },
        });
      return;
    }
    this.events.emit('message', message);
  }
  private fail(error: Error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.events.emit('disconnect', error);
    this.authenticated = false;
    this.startup = null;
    this.process = null;
  }
  async start() {
    if (this.closed) throw new AppError('Codex 服务已关闭。', 503);
    if (this.startup) return this.startup;
    this.startup = this.connect().catch((error) => {
      this.process?.kill('SIGTERM');
      this.startup = null;
      throw error;
    });
    return this.startup;
  }
  private async connect() {
    await mkdir(this.agentDirectory, { recursive: true });
    const proc = spawn(
      this.binary,
      [
        'app-server',
        '-c',
        'features.shell_tool=false',
        '-c',
        'features.apps=false',
        '-c',
        'features.plugins=false',
        '-c',
        'web_search="disabled"',
      ],
      { cwd: this.agentDirectory, stdio: 'pipe' },
    );
    this.process = proc;
    proc.stdin.on('error', () => {
      if (this.process === proc)
        this.fail(new AppError('Codex App Server 连接中断，请重试。', 503, 'CODEX_DISCONNECTED'));
    });
    proc.on('error', () => {
      if (this.process === proc)
        this.fail(
          new AppError(
            '找不到 Codex CLI，请安装 Codex 并设置 CODEX_BIN。',
            503,
            'CODEX_NOT_INSTALLED',
          ),
        );
    });
    proc.on('exit', () => {
      if (this.process === proc)
        this.fail(
          new AppError('Codex App Server 已退出，请重新发起规划。', 503, 'CODEX_DISCONNECTED'),
        );
    });
    proc.stderr.on('data', () => undefined); // Never forward upstream diagnostics or credentials to browsers.
    createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        void this.receive(JSON.parse(line)).catch(() => undefined);
      } catch {
        /* Ignore non-protocol startup output. */
      }
    });
    await this.request('initialize', {
      clientInfo: { name: 'stree_travel', title: 'STREE Travel', version: '2.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
    const account = await this.request('account/read', { refreshToken: false });
    this.authenticated = Boolean(account.account) || account.requiresOpenaiAuth === false;
    const available: any[] = [];
    let cursor: string | null = null;
    do {
      const listing: { data: any[]; nextCursor?: string | null } = await this.request(
        'model/list',
        {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        },
      );
      available.push(...(listing.data ?? []));
      cursor = listing.nextCursor ?? null;
    } while (cursor);
    this.models = available.map((item) => ({
      model: item.model,
      displayName: item.displayName || item.model,
      description: item.description || '',
      isDefault: Boolean(item.isDefault),
      defaultReasoningEffort: item.defaultReasoningEffort ?? null,
      supportedReasoningEfforts: item.supportedReasoningEfforts ?? [],
    }));
    this.model =
      config.CODEX_MODEL ||
      available.find((item: any) => item.isDefault)?.model ||
      available[0]?.model ||
      '';
    try {
      this.selection = ModelSettingsSchema.parse(
        JSON.parse(await readFile(this.settingsPath, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError('模型设置读取失败，请检查本地配置文件。', 503);
    }
  }
  async settings(): Promise<ModelSettingsResponse> {
    await this.start();
    return {
      settings: { ...this.selection },
      effectiveModel: this.selection.model || this.model || null,
      defaultModel: this.model || null,
      models: this.models,
    };
  }
  async saveSettings(input: ModelSettings): Promise<ModelSettingsResponse> {
    await this.start();
    const settings = ModelSettingsSchema.parse(input);
    const model = settings.model || this.model;
    const option = this.models.find((item) => item.model === model);
    if (settings.model && !option && settings.model !== this.model)
      throw new AppError('该模型不在当前模型目录中，请重新选择。', 400);
    if (
      settings.effort &&
      !option?.supportedReasoningEfforts.some((item) => item.reasoningEffort === settings.effort)
    )
      throw new AppError('该模型不支持所选思考强度，请重新选择。', 400);
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
    await rename(temporary, this.settingsPath);
    this.selection = settings;
    return this.settings();
  }
  async status() {
    try {
      await this.start();
      return {
        available: true,
        authenticated: this.authenticated,
        model: this.selection.model || this.model || null,
      };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        model: null,
        error: error instanceof AppError ? error.message : 'Codex 尚未就绪。',
      };
    }
  }
  async generate(options: {
    settings?: ModelSettings;
    tools: DynamicTool[];
    instructions: string;
    prompt: string;
    outputSchema: object;
    handleTool: ToolHandler;
    signal: AbortSignal;
    onProgress: (message: string) => void;
  }): Promise<{ text: string; threadId: string; model: string; usage?: unknown }> {
    await this.start();
    const selection = options.settings ?? this.selection;
    const model = selection.model || this.model;
    const option = this.models.find((item) => item.model === model);
    const effort = selection.effort || option?.defaultReasoningEffort;
    options.signal.throwIfAborted();
    if (!this.authenticated)
      throw new AppError(
        '请先在终端执行 codex login，或为 Codex 配置 API 认证。',
        503,
        'CODEX_NOT_AUTHENTICATED',
      );
    const started = await this.request('thread/start', {
      ...(model ? { model } : {}),
      cwd: this.agentDirectory,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: options.instructions,
      developerInstructions: '只使用 STREE 提供的旅行工具。不要运行命令、读写文件或使用其他工具。',
      ephemeral: true,
      environments: [],
      dynamicTools: options.tools,
      serviceName: 'stree',
    });
    const threadId: string = started.thread.id;
    if (options.signal.aborted) {
      await this.request('thread/unsubscribe', { threadId }, 5000).catch(() => undefined);
      options.signal.throwIfAborted();
    }
    this.handlers.set(
      threadId,
      bindAiContext((name, args) =>
        traceAiCall('tool', args, () => options.handleTool(name, argsObject(args)), { name }),
      ),
    );
    let turnId: string | undefined;
    let stopped = false;
    let text = '';
    let writingProgressSent = false;
    let usage: unknown = null;
    const recorder = currentAiRecorder();
    const completed = new Promise<void>((resolve, reject) => {
      const interrupt = async () => {
        if (turnId)
          await this.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => undefined);
      };
      const abort = () => {
        void interrupt();
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const disconnect = (error: Error) => {
        cleanup();
        reject(error);
      };
      const listener = (message: RpcMessage) => {
        const params = message.params;
        if (params?.threadId !== threadId) return;
        if (params.tokenUsage) {
          usage = params.tokenUsage;
          recorder?.event('token_usage', usage);
        }
        if (message.method === 'turn/started') turnId = params.turn.id;
        if (message.method === 'item/agentMessage/delta') {
          text += params.delta ?? '';
          if (params.delta && !writingProgressSent) {
            writingProgressSent = true;
            options.onProgress('正在编写路线与逐站攻略');
          }
        }
        if (
          message.method === 'item/completed' &&
          params.item?.type === 'agentMessage' &&
          params.item.phase !== 'commentary'
        )
          text = params.item.text || text;
        if (message.method === 'item/started' && params.item?.type === 'dynamicToolCall') {
          writingProgressSent = false;
          options.onProgress(toolLabel(params.item.tool));
        }
        if (message.method === 'turn/completed') {
          cleanup();
          if (params.turn.status === 'completed') resolve();
          else
            reject(
              new AppError(
                params.turn.status === 'interrupted'
                  ? '规划已取消。'
                  : 'Codex 未能完成本次规划，请检查模型权限并重试。',
                502,
                'CODEX_TURN_FAILED',
              ),
            );
        }
      };
      const cleanup = () => {
        stopped = true;
        this.events.off('message', listener);
        this.events.off('disconnect', disconnect);
        options.signal.removeEventListener('abort', abort);
      };
      this.events.on('message', listener);
      this.events.on('disconnect', disconnect);
      options.signal.addEventListener('abort', abort, { once: true });
      this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: options.prompt }],
        outputSchema: options.outputSchema,
        ...(effort ? { effort } : {}),
      })
        .then((result) => {
          turnId = result.turn.id;
          if (options.signal.aborted || stopped) void interrupt();
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
    try {
      await completed;
      return { text, threadId, model, ...(usage ? { usage } : {}) };
    } finally {
      this.handlers.delete(threadId);
      await this.request('thread/unsubscribe', { threadId }, 5000).catch(() => undefined);
    }
  }
  async close() {
    this.closed = true;
    this.process?.kill('SIGTERM');
  }
}
function argsObject(args: unknown) {
  if (typeof args === 'string') return JSON.parse(args);
  return args;
}
function toolLabel(tool: string) {
  return (
    {
      search_places: '正在搜索目的地的景点与街区',
      search_hotels: '正在查询适合过夜的酒店',
      measure_route: '正在核对景点之间的真实交通',
      check_plan: '正在检查行程与预算',
    }[tool] ?? '正在核对旅行信息'
  );
}
