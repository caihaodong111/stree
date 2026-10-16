import { randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ProviderModel } from '@stree/shared';
import type { CodexClient } from '../codex/client.js';
import type { StoredProvider } from './providers.js';
import { AppError, publicError } from '../errors.js';
import { config, runtimeRoot } from '../config.js';
import { currentAiRecorder, traceAiCall, withAiResponse } from '../planning/ai-recorder.js';
import { createOutputDecoder, queryKey, unwrapModelJSON } from './output.js';

export type GenerateOptions = Parameters<CodexClient['generate']>[0] & {
  limits?: {
    maxToolRounds?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
    requestTimeoutMs?: number;
  };
};
export type GenerateResult = Awaited<ReturnType<CodexClient['generate']>> & {
  engine?: 'codex-app-server' | 'custom-provider';
};
const recordSchema = z.record(z.string(), z.unknown());
const asRecord = (value: unknown) => recordSchema.parse(value);
const asArray = (value: unknown): unknown[] => z.array(z.unknown()).parse(value);
const asString = (value: unknown) => z.string().parse(value);
const unwrapJSON = unwrapModelJSON;
function nonThinkingParameters(provider: StoredProvider, model: string) {
  if (new URL(provider.baseURL).hostname === 'api.openai.com') return { reasoning_effort: 'none' };
  return {
    enable_thinking: false,
    ...(/qwen/i.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...(new URL(provider.baseURL).hostname.endsWith('bigmodel.cn')
      ? { thinking: { type: 'disabled' } }
      : {}),
  };
}
function assertNonThinking(data: Record<string, any>) {
  const tokens = Math.max(
    Number(data.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    Number(data.usage?.output_tokens_details?.reasoning_tokens ?? 0),
  );
  const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
  const thinking =
    list(data.choices).some((choice: any) =>
      [
        choice.message?.reasoning_content,
        choice.message?.reasoning,
        typeof choice.message?.content === 'string'
          ? choice.message.content.match(/<think>([\s\S]+?)<\/think>/i)?.[1]
          : '',
      ].some((value) => typeof value === 'string' && value.trim()),
    ) ||
    list(data.output).some((item: any) => item.type === 'reasoning') ||
    list(data.content).some((item: any) => ['thinking', 'redacted_thinking'].includes(item.type));
  if (tokens > 0 || thinking)
    throw new AppError(
      '当前模型仍返回推理内容，不符合已永久关闭推理的设置，请选择支持非思考模式的模型。',
      422,
      'THINKING_MODE_UNSUPPORTED',
    );
}
function providerErrorMessage(data: unknown, apiKey: string): string | null {
  const parsed = recordSchema.safeParse(data);
  if (!parsed.success) return null;
  const error = recordSchema.safeParse(parsed.data.error);
  const message =
    (error.success ? error.data.message : parsed.data.error) ??
    parsed.data.message ??
    parsed.data.detail;
  if (typeof message !== 'string' || !message.trim()) return null;
  const redacted = apiKey ? message.split(apiKey).join('[已隐藏密钥]') : message;
  return redacted
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏密钥]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[已隐藏密钥]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 2000);
}

function endpoint(provider: StoredProvider, route: string) {
  let base = provider.baseURL.replace(/\/+$/, '');
  if (provider.protocol === 'anthropic-messages' && !base.endsWith('/v1')) base += '/v1';
  return `${base}/${route}`;
}

/** Request only the configured endpoint; expose only redacted upstream error messages. */
async function performRequestJSON(
  provider: StoredProvider,
  route: string,
  signal: AbortSignal,
  body?: object,
  maximumBytes?: number,
) {
  if (provider.apiKey && !/^[\x21-\x7e]+$/.test(provider.apiKey))
    throw new AppError('API 密钥包含无法用于认证的字符，请重新填写该提供方的密钥。', 400);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (provider.protocol === 'anthropic-messages') {
      headers['anthropic-version'] = '2023-06-01';
      if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    } else if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const response = await fetch(endpoint(provider, route), {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const detail = providerErrorMessage(await response.json().catch(() => null), provider.apiKey);
      const hint =
        response.status === 401 || response.status === 403
          ? '请检查 API 密钥和模型访问权限。'
          : response.status === 429
            ? '请求受限，请检查账户额度或稍后重试。'
            : response.status === 404
              ? '请检查 API 地址、协议和模型 ID。'
              : '请检查模型 ID、协议及输出上限。';
      throw new AppError(
        `模型接口返回 HTTP ${response.status}：${detail || hint}`,
        502,
        response.status === 401 || response.status === 403
          ? 'PROVIDER_AUTH_REJECTED'
          : 'PROVIDER_HTTP_ERROR',
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError('模型接口返回空响应。', 502);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (maximumBytes && bytes > maximumBytes)
          throw new AppError('模型目录响应过大，请手动添加所需的模型 ID。', 502);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const data = asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (data.error || data.status === 'failed')
      throw new AppError(
        `模型接口返回错误：${providerErrorMessage(data, provider.apiKey) || '上游未提供错误说明。'}`,
        502,
        'PROVIDER_GENERATION_FAILED',
      );
    return data;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppError) throw error;
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new AppError(
        '模型接口返回格式不符合所选协议，请检查 API 地址和协议。',
        502,
        'PROVIDER_INVALID_RESPONSE',
      );
    throw new AppError(
      '无法连接模型接口，请检查 API 地址和网络；接口重定向不会被自动跟随。',
      502,
      'PROVIDER_UNREACHABLE',
    );
  }
}

async function requestJSON(
  provider: StoredProvider,
  route: string,
  signal: AbortSignal,
  body?: object,
  maximumBytes?: number,
) {
  return traceAiCall(
    'model',
    body ?? {},
    () => performRequestJSON(provider, route, signal, body, maximumBytes),
    {
      name: route,
      provider: provider.name,
      protocol: provider.protocol,
      model: body && 'model' in body && typeof body.model === 'string' ? body.model : null,
    },
    [provider.apiKey],
  );
}

export async function discoverModels(provider: StoredProvider): Promise<ProviderModel[]> {
  const signal = AbortSignal.timeout(30000);
  try {
    const data = await requestJSON(
      provider,
      provider.protocol === 'anthropic-messages' ? 'models?limit=1000' : 'models',
      signal,
      undefined,
      4 * 1024 * 1024,
    );
    const candidates = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : data.models && typeof data.models === 'object'
          ? Object.entries(data.models).flatMap(([id, value]) => {
              const entry = recordSchema.safeParse(value);
              return entry.success ? [{ ...entry.data, id: id.trim() || entry.data.id }] : [];
            })
          : [];
    const models = new Map<string, ProviderModel>();
    for (const item of candidates) {
      const entry = recordSchema.safeParse(item);
      if (!entry.success || typeof entry.data.id !== 'string' || !entry.data.id.trim()) continue;
      const id = entry.data.id.trim();
      if (id.length > 200) continue;
      const name =
        [entry.data.display_name, entry.data.name, entry.data.displayName].find(
          (value) => typeof value === 'string' && value.trim(),
        ) ?? id;
      const positive = (...values: unknown[]) =>
        values.find(
          (value): value is number =>
            typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
        );
      const limit = recordSchema.safeParse(entry.data.limit);
      const topProvider = recordSchema.safeParse(entry.data.top_provider);
      const contextWindow = positive(
        entry.data.contextWindow,
        entry.data.context_window,
        entry.data.context_length,
        entry.data.max_input_tokens,
        limit.success ? limit.data.context : undefined,
      );
      const maxTokens = positive(
        entry.data.maxTokens,
        entry.data.max_tokens,
        entry.data.maxOutputTokens,
        entry.data.max_output_tokens,
        limit.success ? limit.data.output : undefined,
        topProvider.success ? topProvider.data.max_completion_tokens : undefined,
      );
      if (!models.has(id))
        models.set(id, {
          id,
          name: typeof name === 'string' ? name.slice(0, 100) : id.slice(0, 100),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
        });
    }
    if (!models.size) throw new AppError('接口未返回可用模型，可以手动添加模型 ID。', 422);
    return [...models.values()];
  } catch (error) {
    if (signal.aborted) throw new AppError('获取模型超时，可以重试或手动添加模型 ID。', 504);
    if (error instanceof AppError && error.code === 'PROVIDER_AUTH_REJECTED')
      throw new AppError(
        `${error.message}。请填写该 API 地址对应的有效密钥后重试；留空会继续使用已保存的密钥。`,
        error.statusCode,
        error.code,
      );
    throw error;
  }
}

/** Run the same allowlisted travel tools through three common vendor protocols. */
export async function generateWithProvider(
  provider: StoredProvider,
  model: string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const limits = {
    maxToolRounds: options.limits?.maxToolRounds ?? config.MODEL_MAX_TOOL_ROUNDS,
    maxToolCalls: options.limits?.maxToolCalls ?? config.MODEL_MAX_TOOL_CALLS,
    timeoutMs: options.limits?.timeoutMs ?? config.MODEL_TIMEOUT_MS,
    requestTimeoutMs: options.limits?.requestTimeoutMs ?? config.MODEL_REQUEST_TIMEOUT_MS,
  };
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits.timeoutMs)]);
  const decode = createOutputDecoder(options.outputSchema);
  // SiliconFlow's schema mode is verified for the deployed provider. Other gateways
  // retain their explicit JSON-object opt-in instead of receiving unsupported parameters.
  let schemaOutput =
    provider.jsonMode && new URL(provider.baseURL).hostname === 'api.siliconflow.cn';
  const request = async (route: string, body: object) => {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)]);
    try {
      try {
        return await requestJSON(provider, route, requestSignal, body);
      } catch (error) {
        if (
          schemaOutput &&
          route === 'chat/completions' &&
          'response_format' in body &&
          error instanceof AppError &&
          error.code === 'PROVIDER_HTTP_ERROR' &&
          error.message.includes('HTTP 400') &&
          /json_schema|response_format|structured.output/i.test(error.message) &&
          /unsupported|not support|不支持/i.test(error.message)
        ) {
          schemaOutput = false;
          currentAiRecorder()?.event('output_constraint_fallback', {
            from: 'json_schema',
            to: 'json_object',
          });
          return await requestJSON(provider, route, requestSignal, {
            ...body,
            response_format: { type: 'json_object' },
          });
        }
        throw error;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (requestSignal.aborted)
        throw new AppError(
          '模型单次响应超时，任务记录已保留，请稍后重试。',
          504,
          'PROVIDER_REQUEST_TIMEOUT',
        );
      throw error;
    }
  };
  const system = `${options.instructions}\n查询预算最多 ${limits.maxToolRounds} 轮、${limits.maxToolCalls} 次工具请求。优先使用已提供的地点，只查询最终采用路线的必要区间；不要穷举交通方式或反复确认同一信息。资料足够就输出，不必用满预算。\n最终输出必须是完整 JSON，符合以下 JSON Schema：\n${JSON.stringify(options.outputSchema)}\n如果用户要求续写因长度限制中断的 JSON，本轮只输出从上次末尾开始的剩余内容；各段拼接后的完整 JSON 必须符合上述 Schema。`;
  const messages: object[] =
    provider.protocol === 'openai-completions'
      ? [
          { role: 'system', content: system },
          { role: 'user', content: options.prompt },
        ]
      : [{ role: 'user', content: options.prompt }];
  const input: object[] = [{ role: 'user', content: options.prompt }];
  const generationId = randomUUID();
  let partialText = '';
  let calls = 0;
  let latestResponse: unknown;
  const successfulQueries = new Map<string, unknown>();
  const recentQueries: boolean[] = [];
  let toolFailures = 0;
  let toolRounds = 0;
  let finalRequests = 0;
  let repairs = 0;
  let continuations = 0;
  let finalizationAnnounced = false;
  let finalizeOnly = false;
  let originId: string | undefined;
  try {
    originId = JSON.parse(options.prompt).origin?.id;
  } catch {
    /* Non-planning callers may use prose. */
  }
  const finishResearch = () => {
    finalizeOnly = true;
  };
  const result = (text: string): GenerateResult => ({
    text: unwrapJSON(text),
    threadId: `provider-${generationId}`,
    model,
    engine: 'custom-provider',
  });
  const recordTruncation = async (
    data: Record<string, unknown>,
    reason: string,
    text: string,
    reasoning: string,
  ) => {
    const parsed = recordSchema.safeParse(data.usage);
    const usage = parsed.success
      ? Object.fromEntries(
          Object.entries(parsed.data).filter(([, value]) => typeof value === 'number'),
        )
      : {};
    const recorder = currentAiRecorder();
    if (recorder) {
      recorder.event('output_truncated', {
        model,
        protocol: provider.protocol,
        reason,
        usage,
        outputCharacters: text.length,
        reasoningCharacters: reasoning.length,
        toolCalls: calls,
      });
      await recorder.flush();
      return;
    }
    const directory = path.join(runtimeRoot, 'model-runs');
    // Diagnostics must never interrupt a model run; credentials and raw reasoning are not logged.
    await mkdir(directory, { recursive: true })
      .then(() =>
        appendFile(
          path.join(directory, `${generationId}.jsonl`),
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            model,
            protocol: provider.protocol,
            reason,
            usage,
            outputCharacters: text.length,
            reasoningCharacters: reasoning.length,
            toolCalls: calls,
          })}\n`,
          { mode: 0o600 },
        ),
      )
      .catch(() => undefined);
  };
  const runTool = async (name: string, args: unknown) => {
    const output = await withAiResponse(latestResponse, () =>
      traceAiCall(
        'tool',
        args,
        async () => {
          signal.throwIfAborted();
          if (finalizeOnly || calls >= limits.maxToolCalls) {
            finishResearch();
            return { error: '资料查询阶段已结束，请复用已有结果完成行程；未知信息标注待确认。' };
          }
          options.onProgress(`正在调用旅行工具：${name}（第 ${++calls} 次）`);
          try {
            if (!options.tools.some((tool) => tool.name === name)) {
              toolFailures++;
              return { error: '未知旅行工具。' };
            }
            const parsed = typeof args === 'string' ? JSON.parse(args) : args;
            const key = queryKey(name, parsed, originId);
            const cached = successfulQueries.has(key);
            recentQueries.push(cached);
            if (recentQueries.length > 6) recentQueries.shift();
            const value = cached
              ? structuredClone(successfulQueries.get(key))
              : await options.handleTool(name, parsed);
            signal.throwIfAborted();
            if (value && typeof value === 'object' && !('error' in value)) {
              if (!cached) successfulQueries.set(key, structuredClone(value));
              toolFailures = 0;
            } else toolFailures++;
            if (cached) currentAiRecorder()?.event('tool_cache_hit', { name });
            return value;
          } catch (error) {
            signal.throwIfAborted();
            toolFailures++;
            if (error instanceof SyntaxError)
              return { error: '工具参数 JSON 不完整或无效，请重新调用该工具并提供完整参数。' };
            return { error: publicError(error) };
          }
        },
        { name },
        [provider.apiKey],
      ),
    );
    if (
      calls >= limits.maxToolCalls ||
      toolFailures >= 3 ||
      recentQueries.filter(Boolean).length >= 4
    )
      finishResearch();
    return output;
  };
  try {
    // Bound research and recovery independently; all already requested tools receive a reply.
    while (true) {
      signal.throwIfAborted();
      if (toolRounds >= limits.maxToolRounds) finishResearch();
      if (finalizeOnly && !finalizationAnnounced) {
        finalizationAnnounced = true;
        const finish = {
          role: 'user',
          content:
            '资料查询阶段已结束。停止工具调用，复用已有地点、住宿和交通，立即输出符合 schema 的完整行程 JSON；缺少的政策、费用或路线标注估算/待确认，不再穷举组合。每天的 stops、legs、hotelPoiId、foodTips 必须放在同一个 day 对象中。',
        };
        if (provider.protocol === 'openai-responses') input.push(finish);
        else messages.push(finish);
        currentAiRecorder()?.event('research_finished', {
          toolRounds,
          toolCalls: calls,
          cachedQueries: recentQueries.filter(Boolean).length,
        });
        options.onProgress('资料查询已完成，正在使用已有结果生成最终行程');
      }
      const activeTools = finalizeOnly ? [] : options.tools;
      if (finalizeOnly) {
        if (++finalRequests > 12)
          throw new AppError(
            '模型未能在格式恢复次数内完成行程，记录已保留，请重试。',
            502,
            'AI_OUTPUT_RECOVERY_EXHAUSTED',
          );
      } else toolRounds++;
      let text = '';
      let truncated = false;
      let reasoning = '';
      let reason = '';
      if (provider.protocol === 'openai-completions') {
        const data = await request('chat/completions', {
          model,
          messages,
          stream: false,
          ...nonThinkingParameters(provider, model),
          ...(provider.maxOutputTokens !== null ? { max_tokens: provider.maxOutputTokens } : {}),
          // A JSON suffix is not a standalone JSON object; do not constrain continuation chunks.
          ...(provider.jsonMode &&
          !partialText &&
          (!schemaOutput || finalizeOnly || !activeTools.length)
            ? {
                response_format: schemaOutput
                  ? {
                      type: 'json_schema',
                      json_schema: {
                        name: 'travel_plan',
                        strict: true,
                        schema: options.outputSchema,
                      },
                    }
                  : { type: 'json_object' },
              }
            : {}),
          ...(finalizeOnly ? { tool_choice: 'none' } : {}),
          tools: activeTools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        });
        assertNonThinking(data);
        const choice = asRecord(asArray(data.choices)[0]);
        latestResponse = data;
        const message = asRecord(choice.message);
        text = typeof message.content === 'string' ? message.content : '';
        reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
        truncated = choice.finish_reason === 'length';
        reason = 'finish_reason=length';
        if (truncated) await recordTruncation(data, reason, text, reasoning);
        messages.push({
          role: 'assistant',
          content: message.content ?? null,
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        });
        const toolCalls = message.tool_calls ? asArray(message.tool_calls) : [];
        if (toolCalls.length) {
          for (const raw of toolCalls) {
            const call = asRecord(raw);
            const fn = asRecord(call.function);
            messages.push({
              role: 'tool',
              tool_call_id: asString(call.id),
              content: JSON.stringify(await runTool(asString(fn.name), fn.arguments)),
            });
          }
          continue;
        }
      } else if (provider.protocol === 'openai-responses') {
        const data = await request('responses', {
          model,
          instructions: system,
          input,
          stream: false,
          store: false,
          reasoning: { effort: 'none' },
          ...(provider.maxOutputTokens !== null
            ? { max_output_tokens: provider.maxOutputTokens }
            : {}),
          ...(finalizeOnly ? { tool_choice: 'none' } : {}),
          tools: activeTools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          })),
        });
        assertNonThinking(data);
        latestResponse = data;
        if (data.status === 'incomplete') {
          const details = recordSchema.safeParse(data.incomplete_details);
          const incompleteReason =
            details.success && typeof details.data.reason === 'string'
              ? details.data.reason
              : '上游未提供原因';
          if (incompleteReason !== 'max_output_tokens')
            throw new AppError(
              `模型服务返回未完成的输出（status=incomplete，reason=${incompleteReason}）。`,
              502,
              'PROVIDER_OUTPUT_INCOMPLETE',
            );
          truncated = true;
          reason = 'status=incomplete，reason=max_output_tokens';
        }
        const output = asArray(data.output).map(asRecord);
        input.push(...output);
        text = output
          .filter((item) => item.type === 'message')
          .flatMap((item) => asArray(item.content).map(asRecord))
          .filter((part) => part.type === 'output_text')
          .map((part) => asString(part.text))
          .join('');
        reasoning = output.some((item) => item.type === 'reasoning') ? 'reasoning' : '';
        if (truncated) await recordTruncation(data, reason, text, reasoning);
        const toolCalls = output.filter((item) => item.type === 'function_call');
        if (toolCalls.length) {
          for (const call of toolCalls)
            input.push({
              type: 'function_call_output',
              call_id: asString(call.call_id),
              output: JSON.stringify(await runTool(asString(call.name), call.arguments)),
            });
          continue;
        }
      } else {
        const data = await request('messages', {
          model,
          system,
          messages,
          stream: false,
          thinking: { type: 'disabled' },
          ...(provider.maxOutputTokens !== null ? { max_tokens: provider.maxOutputTokens } : {}),
          tools: activeTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        });
        assertNonThinking(data);
        const content = asArray(data.content).map(asRecord);
        latestResponse = data;
        messages.push({ role: 'assistant', content });
        text = content
          .filter((part) => part.type === 'text')
          .map((part) => asString(part.text))
          .join('');
        reasoning = content
          .filter((part) => part.type === 'thinking')
          .map((part) => (typeof part.thinking === 'string' ? part.thinking : ''))
          .join('');
        truncated = data.stop_reason === 'max_tokens';
        reason = 'stop_reason=max_tokens';
        if (truncated) await recordTruncation(data, reason, text, reasoning);
        const toolCalls = content.filter((part) => part.type === 'tool_use');
        if (toolCalls.length) {
          const results = [];
          for (const call of toolCalls) {
            const result = await runTool(asString(call.name), call.input);
            results.push({
              type: 'tool_result',
              tool_use_id: asString(call.id),
              content: JSON.stringify(result),
              ...(result && typeof result === 'object' && 'error' in result
                ? { is_error: true }
                : {}),
            });
          }
          messages.push({ role: 'user', content: results });
          continue;
        }
      }
      // A provider can mark a fully formed JSON document as length-limited.
      // Prefer a complete replacement if the model restarted instead of continuing.
      const combined = partialText + text;
      const combinedOutput = decode(combined);
      const currentOutput = partialText ? decode(text) : combinedOutput;
      if (!combinedOutput.error) return result(combinedOutput.text);
      if (!currentOutput.error) return result(currentOutput.text);
      if (partialText || truncated) partialText = combined;
      if (truncated) {
        if (!text && !reasoning)
          throw new AppError(
            `模型服务结束输出（${reason}），未提供可续写内容。`,
            502,
            'PROVIDER_OUTPUT_INCOMPLETE',
          );
        if (++continuations > 8)
          throw new AppError(
            '模型多次达到输出长度上限，仍未完成行程。请提高最大输出 Token 或减少行程天数。',
            502,
            'PROVIDER_OUTPUT_INCOMPLETE',
          );
        // A JSON continuation must not restart research or receive a conflicting
        // instruction to emit a new document; a complete replacement is still accepted.
        finishResearch();
        finalizationAnnounced = true;
        options.onProgress('模型达到单次输出长度，正在继续生成剩余行程');
        const continuation = {
          role: 'user',
          content: partialText
            ? '上一段 JSON 因单次输出长度限制中断。请从上一段最后一个字符之后继续，只输出剩余 JSON 原文，不重复已输出内容，不添加 Markdown、说明或省略号，不重新开始。即使截断发生在字符串中间，也直接接着写；保留原来的行程安排和所有字段。'
            : '上一轮推理因单次输出长度限制中断，还没有行程 JSON。请利用已有查询结果和推理，继续完成并直接输出完整行程 JSON。',
        };
        if (provider.protocol === 'openai-responses') input.push(continuation);
        else messages.push(continuation);
        continue;
      }
      const failure = partialText ? decode(partialText) : currentOutput;
      if (repairs >= 2)
        throw new AppError(
          '模型行程格式异常，自动恢复后仍未通过格式检查。记录已保留，请重试或更换模型。',
          502,
          'AI_OUTPUT_FORMAT',
        );
      repairs++;
      finishResearch();
      finalizationAnnounced = true;
      // Re-emit the whole object; a malformed document cannot safely be continued or patched.
      partialText = '';
      continuations = 0;
      const repair = {
        role: 'user',
        content: `上一份输出未通过展示格式检查：${failure.error}\n仅修正 JSON 语法和 schema 字段结构，保持已选地点、行程与事实，不要编造数据或省略天数/景点。复用全部现有工具结果，禁止再次调用工具。重新输出一份完整 JSON 对象，不输出标签、Markdown、说明或省略号。`,
      };
      if (provider.protocol === 'openai-responses') input.push(repair);
      else messages.push(repair);
      currentAiRecorder()?.event('output_recovery', { attempt: repairs, reason: failure.error });
      options.onProgress(`正在自动恢复行程输出格式（${repairs}/2），无需重新查询资料`);
    }
  } catch (error) {
    options.signal.throwIfAborted();
    if (signal.aborted)
      throw new AppError(
        '行程生成超过时间上限，任务记录已保留，请稍后重试或更换模型。',
        504,
        'PROVIDER_TIMEOUT',
      );
    if (error instanceof z.ZodError)
      throw new AppError('模型响应不符合所选 API 协议，请检查协议配置。', 502);
    throw error;
  }
}
