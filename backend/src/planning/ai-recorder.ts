import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiCall, AiStore } from '../db/ai-store.js';
import { redactAiData } from '../db/ai-store.js';
import { publicError } from '../errors.js';
import { aiDiagnosticsDirectory } from '../db/ai-diagnostics.js';

const context = new AsyncLocalStorage<{ recorder: AiRecorder; parentCallId: string | null }>();
const responseCalls = new WeakMap<object, string>();
export function currentAiRecorder() {
  return context.getStore()?.recorder;
}
export function bindAiContext<T extends (...args: any[]) => any>(operation: T): T {
  return AsyncLocalStorage.bind(operation);
}
export function withAiResponse<T>(response: unknown, operation: () => Promise<T>): Promise<T> {
  const active = context.getStore();
  const parentCallId =
    response && typeof response === 'object' ? responseCalls.get(response) : undefined;
  return active && parentCallId ? context.run({ ...active, parentCallId }, operation) : operation();
}
type CallMetadata = Partial<Pick<AiCall, 'name' | 'provider' | 'model' | 'protocol'>>;
export class AiRecorder {
  private sequence = 0;
  private pending = Promise.resolve();
  private writeError: unknown;
  constructor(
    readonly runId: string,
    private store: AiStore,
    readonly signal: AbortSignal,
    private diagnosticsDirectory = aiDiagnosticsDirectory,
  ) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    return context.run({ recorder: this, parentCallId: null }, operation);
  }
  event(type: string, payload: unknown) {
    const event = {
      id: randomUUID(),
      runId: this.runId,
      sequence: ++this.sequence,
      type,
      payload: redactAiData(payload),
      createdAt: new Date().toISOString(),
    };
    const task = this.pending.then(() => this.store.appendEvent(event));
    this.pending = task.catch((error) => {
      this.writeError ??= error;
    });
  }
  async flush() {
    await this.pending;
    if (this.writeError) throw this.writeError;
  }
  private async finishCall(id: string, patch: Parameters<AiStore['finishCall']>[1]) {
    try {
      await this.store.finishCall(id, patch);
    } catch (error) {
      // Retain the public response that could not be saved, without claiming MySQL success.
      await mkdir(this.diagnosticsDirectory, { recursive: true, mode: 0o700 })
        .then(() =>
          writeFile(
            path.join(this.diagnosticsDirectory, `${id}.response.json`),
            JSON.stringify({ runId: this.runId, callId: id, patch }),
            { mode: 0o600 },
          ),
        )
        .catch(() => undefined);
      throw error;
    }
  }
  async call<T>(
    kind: AiCall['kind'],
    input: unknown,
    operation: () => Promise<T>,
    metadata: CallMetadata,
    secrets: string[],
  ): Promise<T> {
    await this.flush();
    this.signal.throwIfAborted();
    const started = Date.now();
    const call: AiCall = {
      id: randomUUID(),
      runId: this.runId,
      parentCallId: context.getStore()?.parentCallId ?? null,
      kind,
      name: metadata.name ?? kind,
      provider: metadata.provider ?? null,
      model: metadata.model ?? null,
      protocol: metadata.protocol ?? null,
      status: 'running',
      input: redactAiData(input, secrets),
      output: null,
      usage: null,
      error: null,
      durationMs: null,
      createdAt: new Date(started).toISOString(),
      finishedAt: null,
    };
    await this.store.startCall(call);
    let output: T;
    try {
      output = await context.run({ recorder: this, parentCallId: call.id }, operation);
    } catch (error) {
      await this.finishCall(call.id, {
        status: this.signal.aborted ? 'cancelled' : 'failed',
        output: null,
        usage: null,
        error: String(redactAiData(publicError(error), secrets)),
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
    const usage = output && typeof output === 'object' && 'usage' in output ? output.usage : null;
    const returnedError =
      kind === 'tool' &&
      output &&
      typeof output === 'object' &&
      'error' in output &&
      typeof output.error === 'string'
        ? output.error
        : null;
    await this.finishCall(call.id, {
      status: returnedError ? 'failed' : 'completed',
      output: redactAiData(output, secrets),
      usage: redactAiData(usage, secrets),
      error: returnedError ? String(redactAiData(returnedError, secrets)) : null,
      durationMs: Date.now() - started,
      finishedAt: new Date().toISOString(),
    });
    if (output && typeof output === 'object') responseCalls.set(output, call.id);
    return output;
  }
}
export function traceAiCall<T>(
  kind: AiCall['kind'],
  input: unknown,
  operation: () => Promise<T>,
  metadata: CallMetadata = {},
  secrets: string[] = [],
): Promise<T> {
  const recorder = currentAiRecorder();
  return recorder ? recorder.call(kind, input, operation, metadata, secrets) : operation();
}
