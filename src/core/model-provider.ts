import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ override: true });

const OPENCODE_CONFIG_PATHS = [
  'C:/.opencode/opencode.json',
  path.join(process.env.USERPROFILE || 'C:', '.config', 'opencode', 'opencode.json')
];
let opencodeConfig: any = {};
for (const p of OPENCODE_CONFIG_PATHS) {
  if (fs.existsSync(p)) {
    try { opencodeConfig = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch (e) {}
  }
}

console.log(`[KEYS] OPENROUTER=${process.env.OPENROUTER_API_KEY ? 'set' : 'checking config...'}`);
console.log(`[KEYS] OPENCODE=${process.env.OPENCODE_API_KEY ? 'set' : 'checking config...'}`);
console.log(`[KEYS] DEEPSEEK=${process.env.DEEPSEEK_API_KEY ? 'set' : 'checking config...'}`);

const PROVIDERS = {
  OPENROUTER: 'https://openrouter.ai/api/v1',
  OPENCODE: 'https://opencode.ai/zen/v1',
  DEEPSEEK: 'https://api.deepseek.com/v1'
};

export const Models = {
  ARCHITECT_PRIMARY: { provider: 'OPENROUTER', name: 'deepseek/deepseek-chat:free' },
  ARCHITECT_FALLBACK: { provider: 'OPENCODE', name: 'deepseek-v4-flash-free' },
  BUILDER: { provider: 'OPENCODE', name: 'deepseek-v4-flash-free' },
  REVIEWER: { provider: 'OPENROUTER', name: 'meta-llama/llama-3.3-70b-instruct:free' },
  AUDITOR: { provider: 'OPENROUTER', name: 'meta-llama/llama-3.3-70b-instruct:free' },
};

export type ModelRole = keyof typeof Models;

export function validateApiKeys(): string[] {
  const missing: string[] = [];
  if (!process.env.OPENROUTER_API_KEY && !opencodeConfig.provider?.openrouter?.apiKey && !opencodeConfig.provider?.['openrouter-stealth']?.apiKey) missing.push('OPENROUTER');
  if (!process.env.OPENCODE_API_KEY && !opencodeConfig.provider?.opencode?.apiKey && !opencodeConfig.provider?.['zen-free']?.apiKey) missing.push('OPENCODE');
  if (!process.env.DEEPSEEK_API_KEY && !opencodeConfig.provider?.deepseek?.apiKey) missing.push('DEEPSEEK');
  return missing;
}

export async function checkModelHealth(provider: string, model: string): Promise<{ ok: boolean; latency: number; error?: string }> {
  const start = Date.now();
  try {
    const response = await callModel(provider as any, model, 'Reply with just: OK', 'Be concise.');
    return { ok: true, latency: Date.now() - start };
  } catch (e: any) {
    return { ok: false, latency: Date.now() - start, error: e.message || String(e) };
  }
}

export async function checkAllModels(): Promise<Record<string, { ok: boolean; latency: number; error?: string }>> {
  const results: Record<string, { ok: boolean; latency: number; error?: string }> = {};
  const entries = Object.entries(Models) as [string, { provider: string; name: string }][];
  for (const [role, cfg] of entries) {
    results[role] = await checkModelHealth(cfg.provider, cfg.name);
  }
  return results;
}

const KEY_FALLBACKS: Record<string, string[]> = {
  OPENROUTER: [
    process.env.OPENROUTER_API_KEY || '',
    opencodeConfig.provider?.openrouter?.apiKey || '',
    opencodeConfig.provider?.['openrouter-stealth']?.apiKey || ''
  ].filter(Boolean),
  OPENCODE: [
    process.env.OPENCODE_API_KEY || '',
    opencodeConfig.provider?.opencode?.apiKey || '',
    opencodeConfig.provider?.['zen-free']?.apiKey || ''
  ].filter(Boolean),
  DEEPSEEK: [
    process.env.DEEPSEEK_API_KEY || '',
    opencodeConfig.provider?.deepseek?.apiKey || ''
  ].filter(Boolean)
};

export async function callModel(
  provider: keyof typeof PROVIDERS,
  model: string,
  prompt: string,
  systemPrompt: string = "You are a helpful assistant.",
  base64Image?: string
) {
  const baseUrl = PROVIDERS[provider];
  const keyCandidates = KEY_FALLBACKS[provider] || [];

  if (keyCandidates.length === 0) throw new Error(`API Key for ${provider} missing.`);

  const messages: any[] = [{ role: 'system', content: systemPrompt }];
  if (base64Image) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  let lastError: any;
  for (const apiKey of keyCandidates) {
    try {
      const response = await axios.post(`${baseUrl}/chat/completions`, {
        model: model,
        messages: messages,
        stream: false
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      });
      return response.data.choices[0].message.content;
    } catch (error: any) {
      lastError = error;
      if (error.response?.status !== 401) throw error;
    }
  }
  throw lastError || new Error(`All API keys for ${provider} failed.`);
}
