// The Codex model picker (DESIGN §6). `codex debug models` prints the CLI's model catalog as JSON, refreshed from the
// account's catalog (codex-cli 0.154: under a second); `codex debug models --bundled` prints the catalog shipped with
// the binary, offline. Neither runs a model. The catalog's visible models ('list'), in its priority order, become the
// model options, each with the reasoning efforts it supports (passed as -c model_reasoning_effort="<level>").
//
// The catalog is cached per CLI (path + version) for CODEX_CATALOG_TTL_MS; after that the old one is served while a
// refresh runs in the background, so /api/health waits for the CLI at most once per CLI. A live read that fails or
// takes too long falls back to --bundled; a CLI without `debug models` (older than the catalog) or a catalog that
// cannot be read leaves only the config default (no effort choice).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EFFORT_ID_RE, MODEL_ID_RE } from '../../shared/types.ts';
import type { EffortOption, ModelOption } from '../../shared/types.ts';
import { trackChild } from '../children.ts';
import { childEnv } from './proc.ts';
import { smsg } from '../i18n.ts';
import { effortOption } from './types.ts';

/** How long a read catalog is used before it is refreshed (in the background). */
export const CODEX_CATALOG_TTL_MS = 30 * 60_000;
/** Timeouts of `codex debug models` (it may wait for the network) and of the offline `--bundled` fallback. */
export const CODEX_CATALOG_TIMEOUT_MS = 4_000;
export const CODEX_BUNDLED_CATALOG_TIMEOUT_MS = 3_000;

/** Effort levels in this order (weakest first); levels the app does not know follow in catalog order. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MAX_DESCRIPTION_CHARS = 200;

export interface CodexCatalogModel {
  slug: string;
  displayName: string;
  description: string;
  /** visibility 'list': shown in Codex's own model picker. */
  visible: boolean;
  /** Lower first (missing = last). */
  priority: number;
  /** Supported reasoning efforts in catalog order, with Codex's description of each. */
  efforts: Array<{ id: string; description: string }>;
}

/** The models of `codex debug models` output (malformed entries skipped); null when it is not a catalog. */
export function parseCodexCatalog(text: string): CodexCatalogModel[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const models = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const out: CodexCatalogModel[] = [];
  for (const raw of models) {
    const m = asRecord(raw);
    // A slug the server would refuse as a model name could not be chosen anyway.
    if (typeof m.slug !== 'string' || !MODEL_ID_RE.test(m.slug)) continue;
    const efforts: CodexCatalogModel['efforts'] = [];
    for (const level of Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []) {
      const l = asRecord(level);
      if (typeof l.effort !== 'string' || !EFFORT_ID_RE.test(l.effort) || efforts.some((e) => e.id === l.effort)) continue;
      efforts.push({ id: l.effort, description: text200(l.description) });
    }
    out.push({
      slug: m.slug,
      displayName: text200(m.display_name) || m.slug,
      description: text200(m.description),
      visible: m.visibility === undefined || m.visibility === 'list',
      priority: typeof m.priority === 'number' && Number.isFinite(m.priority) ? m.priority : Number.POSITIVE_INFINITY,
      efforts,
    });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text200(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;
}

/**
 * The model options and effort levels of the Codex provider: the config default first ('' — its efforts are those of
 * the model config.toml names, or the ones every listed model supports), then the visible models by priority. The
 * effort levels are those of all these models, weakest first. `catalog` null (unknown) = the default only, no efforts.
 */
export function codexModelChoices(
  catalog: CodexCatalogModel[] | null,
  configModel: string | null,
): { models: ModelOption[]; efforts: EffortOption[] } {
  const listed = (catalog ?? []).filter((m) => m.visible).sort((a, b) => a.priority - b.priority);
  const configured = configModel ? catalog?.find((m) => m.slug === configModel) : undefined;
  // The default-model option (in the current language), with the model of config.toml in parentheses when known.
  const m = smsg().chat.providers;
  const fallback: ModelOption = {
    id: '',
    label: configModel ? m.codexDefaultModelOf(configured?.displayName ?? configModel) : m.codexDefaultModel,
  };
  if (configured || listed.length > 0) {
    fallback.efforts = configured
      ? configured.efforts.map((e) => e.id)
      : listed[0].efforts.map((e) => e.id).filter((id) => listed.every((m) => m.efforts.some((e) => e.id === id)));
  }
  const models = [
    fallback,
    ...listed.map((m) => {
      const option: ModelOption = { id: m.slug, label: m.displayName, efforts: m.efforts.map((e) => e.id) };
      if (m.description) option.description = m.description;
      return option;
    }),
  ];

  const descriptions = new Map<string, string>();
  for (const m of configured ? [configured, ...listed] : listed) {
    for (const e of m.efforts) if (!descriptions.has(e.id) || !descriptions.get(e.id)) descriptions.set(e.id, e.description);
  }
  const rank = (id: string) => {
    const i = EFFORT_ORDER.indexOf(id);
    return i < 0 ? EFFORT_ORDER.length : i;
  };
  const ids = [...descriptions.keys()].sort((a, b) => rank(a) - rank(b)); // stable: unknown levels keep catalog order
  return { models, efforts: ids.map((id) => effortOption(id, descriptions.get(id))) };
}

/**
 * The model config.toml sets in its root table (`model = "…"`); null when there is none, or when a `profile` is
 * selected there (the profile may set another model).
 */
export function codexConfigModel(configToml: string): string | null {
  let model: string | null = null;
  for (const raw of configToml.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) break; // the root table ends at the first table header
    if (/^profile\s*=/.test(line)) return null;
    const m = /^model\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) model = (m[1] ?? m[2]).trim() || null;
  }
  return model;
}

/** Codex's home directory: $CODEX_HOME, default ~/.codex (the CLI children inherit the same environment). */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** $CODEX_HOME/config.toml (default ~/.codex/config.toml); '' when it cannot be read. */
export async function readCodexConfig(): Promise<string> {
  try {
    return await readFile(path.join(codexHome(), 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

/** Runs `codex debug models [--bundled]`; the parsed catalog, or null (not supported, failed, timed out, not JSON). */
function runDebugModels(bin: string, bundled: boolean, timeoutMs: number): Promise<CodexCatalogModel[] | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        bin,
        ['debug', 'models', ...(bundled ? ['--bundled'] : [])],
        // The catalog carries each model's instructions: ~0.5 MB for codex-cli 0.154.
        { timeout: timeoutMs, env: childEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : parseCodexCatalog(String(stdout))),
      );
      child.stdin?.end();
      trackChild(child);
    } catch {
      resolve(null);
    }
  });
}

export interface CodexCatalogTimeouts {
  liveMs?: number;
  bundledMs?: number;
}

/** Reads the catalog: live, else the bundled one, else null. Never throws. */
export async function loadCodexCatalog(bin: string, timeouts: CodexCatalogTimeouts = {}): Promise<CodexCatalogModel[] | null> {
  return (
    (await runDebugModels(bin, false, timeouts.liveMs ?? CODEX_CATALOG_TIMEOUT_MS)) ??
    (await runDebugModels(bin, true, timeouts.bundledMs ?? CODEX_BUNDLED_CATALOG_TIMEOUT_MS))
  );
}

interface CatalogCache {
  /** CLI path + version. */
  key: string;
  bin: string;
  /** When `models` was read (0 = never). */
  at: number;
  models: CodexCatalogModel[] | null;
  loading: Promise<CodexCatalogModel[] | null> | null;
}

let cache: CatalogCache | null = null;

/** Forget the cached catalog (tests). */
export function clearCodexCatalogCache(): void {
  cache = null;
}

/**
 * The catalog of the CLI at `bin` (`version` = its --version line): cached, see the top of the file. Only the first
 * call for a CLI waits for it; later ones get the cached catalog at once (a stale one while it is re-read).
 */
export function codexCatalog(bin: string, version: string | undefined): Promise<CodexCatalogModel[] | null> {
  const key = `${bin}\n${version ?? ''}`;
  if (cache?.key !== key) cache = { key, bin, at: 0, models: null, loading: null };
  const entry = cache;
  if (entry.at === 0) return entry.loading ?? reload(entry);
  if (Date.now() - entry.at >= CODEX_CATALOG_TTL_MS && !entry.loading) void reload(entry);
  return Promise.resolve(entry.models);
}

function reload(entry: CatalogCache): Promise<CodexCatalogModel[] | null> {
  entry.loading = loadCodexCatalog(entry.bin)
    .then((models) => {
      // A failed re-read keeps the catalog read before.
      if (models || entry.at === 0) entry.models = models;
      entry.at = Date.now();
      return entry.models;
    })
    .finally(() => {
      entry.loading = null;
    });
  return entry.loading;
}
