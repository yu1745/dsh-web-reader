import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { settings } from './state.js';

const endpoint = 'https://api.typesafe.ai/v1/systemone';

async function apiKey(ctx: any) {
  const configured = await ctx.credentials.resolve(credentialRef('TYPESAFE_API_KEY'));
  if (configured?.value) return configured.value;
  const record = await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'typesafe'));
  if (record?.kind === 'api-key' && record.key) return record.key;
  return process.env.TYPESAFE_API_KEY;
}

export async function classifyJev(model: { id: string }, request: any, options: {
  apiKey?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}) {
  if (!options.apiKey) throw new Error('TypeSafe API key is unavailable');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    'Content-Type': 'application/json',
  };
  const payload: Record<string, unknown> = {
    model: model.id,
    state: request.state,
    questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]: [string, any]) => {
      if (question.type !== 'bool') throw new Error(`Unsupported Jev question: ${id}`);
      return [id, { ...question, type: 'noul' }];
    })),
  };
  if (request.images?.length) {
    const assets = Object.fromEntries(request.images.map((image: any, index: number) => {
      if (!['image/png', 'image/jpeg'].includes(image.mimeType)) throw new Error('Jev accepts PNG and JPEG images');
      return [`<image-${index + 1}>`, { type: 'image', format: image.mimeType.slice(6), data_base64: image.data }];
    }));
    headers['TypeSafe-Danger-Zone-Images'] = 'true';
    payload.assets = assets;
    payload.state = [...Object.keys(assets), request.state];
  }
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: 'POST', headers, body: JSON.stringify(payload), signal: options.signal,
  });
  if (!response.ok) throw new Error(`TypeSafe System One returned HTTP ${response.status}`);
  const body = await response.json();
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  const input = count(body.usage?.input_tokens);
  const output = count(body.usage?.output_tokens);
  const usage = body.usage?.input_tokens !== undefined || body.usage?.output_tokens !== undefined
    ? { input, output, totalTokens: input + output, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    : undefined;
  const answers = Object.fromEntries(Object.keys(request.questions).map(id => {
    const answer = body.answers?.[id];
    return [id, answer?.type === 'noul' ? { type: 'bool', probability: answer.noul } : undefined];
  }));
  return { answers, usage, stopReason: 'stop' as const };
}

export function createClassifierRegistry(ctx: any, config: any = {}) {
  const legacy = settings().classifier;
  const model = { id: config.model || (legacy?.provider === 'typesafe' ? legacy.model : undefined) || 'jev-latest' };
  return {
    findOfType: (type: string, provider: string) => type === 'classifier' && provider === 'typesafe' ? model : undefined,
    async classify(selected: typeof model, request: any, options: { signal?: AbortSignal }) {
      const result = await classifyJev(selected, request, { ...options, apiKey: await apiKey(ctx) });
      if (result.usage) ctx.emit('yu-extensions/tool-usage', {
        sessionId: config.sessionId, provider: 'typesafe', model: selected.id, usage: result.usage,
      });
      return result;
    },
  };
}
