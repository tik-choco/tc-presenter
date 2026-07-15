// Deck-generation checkpoints: crash/cancel-safe intermediate progress for
// lib/generateJobs.ts, committed one atomic unit at a time so an interrupted
// generation can resume instead of restarting from zero.
//
// Commit protocol (the "partial atomicity" design): each unit of progress —
// the narration script, one segment's finished slide, one refine iteration's
// deck snapshot — is written to its OWN key first, and only then is the
// small manifest record updated to reference it. A single storage write is
// atomic, so the manifest write IS the commit point: progress a crash
// interrupts mid-unit simply isn't referenced by the manifest and gets
// regenerated on resume — a half-written state is never observable. This is
// deliberately the same shape as sharedBus's "body goes to the CID store,
// localStorage holds only the pointer" rule (tc-docs/data-structures.md).
//
// Storage backend: mistlib's OPFS-backed KV (storage_kv_set/get/delete) when
// the shared MistNode initializes, because the origin-wide ~5MB localStorage
// quota is shared by every tc-* app (tc-docs' 2026-07-13 storage audit) and
// checkpoint units are written far more often than finished decks. Falls
// back per-operation to quota-safe localStorage writes (lib/safeStorage.ts)
// when mistlib is unavailable, with dual-read so either backend's data is
// found on resume. Only the tiny jobKey registry lives unconditionally in
// localStorage — mistlib's KV has no enumeration API, so discovery of
// resumable checkpoints needs a listable index somewhere.
//
// Never throws (matching kv.ts / safeStorage.ts): checkpointing is a
// best-effort layer under an already-degradation-tolerant pipeline — a
// failed checkpoint write must never break the generation it's protecting.

import { getNode } from './mistNode'
import { storage_kv_delete, storage_kv_get, storage_kv_set } from '../vendor/mistlib/wrappers/web/index.js'
import { safeSetItem } from './safeStorage'
import {
  MAX_SCRIPT_SEGMENTS,
  type Deck,
  type DeckTheme,
  type GenerateOptions,
  type GenerateResumeState,
  type Script,
  type Slide,
  type SourceMaterial,
} from '../types'

const REGISTRY_KEY = 'tc-presenter:gen-index'
const KEY_PREFIX = 'tc-presenter:gen:'
/** Checkpoints older than this are swept on startup — long enough to survive
 * a weekend away, short enough that abandoned runs don't accumulate. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** GenerateOptions as persisted in a manifest: runtime-only fields stripped. */
export type StoredGenerateOptions = Omit<GenerateOptions, 'signal' | 'resume'>

export interface GenerateCheckpointManifest {
  jobKey: string
  label: string
  createdAt: string
  updatedAt: string
  opts: StoredGenerateOptions
  theme?: DeckTheme
  /** True once the script unit is committed; segmentCount is 0 until then. */
  scriptDone: boolean
  segmentCount: number
  /** 0-based segment indexes whose slide unit is committed (real slides
   * only — fallback placeholders are never committed, so a resume retries
   * them). Order is commit order, not segment order. */
  doneSegments: number[]
  /** Last committed refine iteration (its deck snapshot lives in the
   * `:refined` unit); 0 = refine never checkpointed. */
  refinedIteration: number
}

export interface LoadedCheckpoint {
  manifest: GenerateCheckpointManifest
  sources: SourceMaterial[]
  /** Undefined when the run died before the script committed — the caller
   * should restart generation from scratch (under the same jobKey). */
  resume?: GenerateResumeState
}

function manifestKey(jobKey: string): string {
  return `${KEY_PREFIX}${jobKey}`
}
function sourcesKey(jobKey: string): string {
  return `${KEY_PREFIX}${jobKey}:sources`
}
function scriptKey(jobKey: string): string {
  return `${KEY_PREFIX}${jobKey}:script`
}
function slideKey(jobKey: string, segmentIndex: number): string {
  return `${KEY_PREFIX}${jobKey}:slide:${segmentIndex}`
}
function refinedKey(jobKey: string): string {
  return `${KEY_PREFIX}${jobKey}:refined`
}

export function newJobKey(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

// ---------------------------------------------------------------------------
// Backend: OPFS KV preferred, localStorage fallback, dual-read.

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

let mistReady: Promise<boolean> | null = null
/** Whether the OPFS KV is usable — resolved once per session. getNode()
 * initializes the wasm module the storage_kv_* free functions depend on (it
 * joins no P2P room by itself, so this is a local-only init). */
function ensureMist(): Promise<boolean> {
  if (!mistReady) {
    mistReady = getNode()
      .then(() => true)
      .catch(() => false)
  }
  return mistReady
}

async function backendSet(key: string, value: string): Promise<void> {
  if (await ensureMist()) {
    try {
      await storage_kv_set(key, textEncoder.encode(value))
      // Drop any stale fallback copy so dual-read can't resurrect it later.
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore — localStorage may be unavailable entirely
      }
      return
    } catch {
      // fall through to localStorage
    }
  }
  safeSetItem(key, value)
}

async function backendGet(key: string): Promise<string | null> {
  if (await ensureMist()) {
    try {
      const bytes = await storage_kv_get(key)
      if (bytes !== undefined) return textDecoder.decode(bytes)
    } catch {
      // fall through to localStorage
    }
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

async function backendDelete(key: string): Promise<void> {
  if (await ensureMist()) {
    try {
      await storage_kv_delete(key)
    } catch {
      // best-effort
    }
  }
  try {
    localStorage.removeItem(key)
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// jobKey registry (localStorage, tiny): the discoverable list of checkpoints.

function loadRegistry(): string[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

function saveRegistry(jobKeys: string[]): void {
  safeSetItem(REGISTRY_KEY, JSON.stringify(jobKeys))
}

function registryAdd(jobKey: string): void {
  const keys = loadRegistry()
  if (!keys.includes(jobKey)) saveRegistry([...keys, jobKey])
}

function registryRemove(jobKey: string): void {
  saveRegistry(loadRegistry().filter((k) => k !== jobKey))
}

// ---------------------------------------------------------------------------
// Serialized commits + manifest cache. Parallel segment workers can finish
// simultaneously; funneling every mutation for a jobKey through one promise
// chain keeps the manifest's read-modify-write races-free without locks, and
// the in-memory cache avoids an async manifest read per commit.

const commitChains = new Map<string, Promise<void>>()
const manifestCache = new Map<string, GenerateCheckpointManifest>()

function enqueueCommit(jobKey: string, work: () => Promise<void>): void {
  const prev = commitChains.get(jobKey) ?? Promise.resolve()
  const next = prev.then(work).catch(() => {
    // Never throws — see module header. A failed commit just means this unit
    // isn't resumable; the generation itself is unaffected.
  })
  commitChains.set(jobKey, next)
}

function isManifest(value: unknown): value is GenerateCheckpointManifest {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r.jobKey === 'string' &&
    typeof r.label === 'string' &&
    typeof r.updatedAt === 'string' &&
    typeof r.scriptDone === 'boolean' &&
    typeof r.segmentCount === 'number' &&
    Array.isArray(r.doneSegments) &&
    typeof r.refinedIteration === 'number' &&
    r.opts !== null &&
    typeof r.opts === 'object'
  )
}

async function readManifest(jobKey: string): Promise<GenerateCheckpointManifest | null> {
  const raw = await backendGet(manifestKey(jobKey))
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isManifest(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeManifest(manifest: GenerateCheckpointManifest): Promise<void> {
  manifestCache.set(manifest.jobKey, manifest)
  await backendSet(manifestKey(manifest.jobKey), JSON.stringify(manifest))
}

/** Patches the cached manifest and writes it — the commit point. Must only
 * run inside the jobKey's commit chain. */
async function commitManifestPatch(
  jobKey: string,
  patch: (current: GenerateCheckpointManifest) => GenerateCheckpointManifest,
): Promise<void> {
  const current = manifestCache.get(jobKey) ?? (await readManifest(jobKey))
  if (!current) return // checkpoint was deleted (or never created) — drop the commit
  await writeManifest({ ...patch(current), updatedAt: new Date().toISOString() })
}

// ---------------------------------------------------------------------------
// Public API. All commit functions are fire-and-forget (void): callers are
// the generation hot path and must not block or fail on checkpointing.

export function createCheckpoint(input: {
  jobKey: string
  label: string
  opts: GenerateOptions
  theme?: DeckTheme
  sources: SourceMaterial[]
}): void {
  const { signal: _signal, resume: _resume, ...storedOpts } = input.opts
  const now = new Date().toISOString()
  const manifest: GenerateCheckpointManifest = {
    jobKey: input.jobKey,
    label: input.label,
    createdAt: now,
    updatedAt: now,
    opts: storedOpts,
    ...(input.theme ? { theme: input.theme } : {}),
    scriptDone: false,
    segmentCount: 0,
    doneSegments: [],
    refinedIteration: 0,
  }
  enqueueCommit(input.jobKey, async () => {
    // Registry first so even a checkpoint that dies before its manifest
    // lands is discoverable (and thus sweepable) — a registry entry with no
    // manifest is treated as garbage by sweepCheckpoints, never as data.
    registryAdd(input.jobKey)
    await backendSet(sourcesKey(input.jobKey), JSON.stringify(input.sources))
    await writeManifest(manifest)
  })
}

export function commitScript(jobKey: string, script: Script): void {
  enqueueCommit(jobKey, async () => {
    await backendSet(scriptKey(jobKey), JSON.stringify(script))
    await commitManifestPatch(jobKey, (m) => ({ ...m, scriptDone: true, segmentCount: script.segments.length }))
  })
}

export function commitSlide(jobKey: string, segmentIndex: number, slide: Slide): void {
  enqueueCommit(jobKey, async () => {
    await backendSet(slideKey(jobKey, segmentIndex), JSON.stringify(slide))
    await commitManifestPatch(jobKey, (m) => ({
      ...m,
      doneSegments: m.doneSegments.includes(segmentIndex) ? m.doneSegments : [...m.doneSegments, segmentIndex],
    }))
  })
}

export function commitRefined(jobKey: string, deck: Deck, iteration: number): void {
  enqueueCommit(jobKey, async () => {
    await backendSet(refinedKey(jobKey), JSON.stringify(deck))
    await commitManifestPatch(jobKey, (m) => ({ ...m, refinedIteration: iteration }))
  })
}

/** Removes a checkpoint entirely (registry entry, manifest, every unit).
 * Called when its generation completes (the deck got promoted to kv.ts's
 * saveDeck — the checkpoint is now redundant) or the user discards it. */
export function deleteCheckpoint(jobKey: string): void {
  enqueueCommit(jobKey, async () => {
    const manifest = manifestCache.get(jobKey) ?? (await readManifest(jobKey))
    manifestCache.delete(jobKey)
    registryRemove(jobKey)
    // Units first, manifest last — mirrors the commit protocol in reverse so
    // an interrupted delete leaves a still-discoverable (re-deletable)
    // checkpoint rather than invisible orphan units. With no readable
    // manifest, sweep the whole possible slide range.
    const segmentCount = manifest?.segmentCount || MAX_SCRIPT_SEGMENTS
    for (let i = 0; i < segmentCount; i += 1) await backendDelete(slideKey(jobKey, i))
    await backendDelete(refinedKey(jobKey))
    await backendDelete(scriptKey(jobKey))
    await backendDelete(sourcesKey(jobKey))
    await backendDelete(manifestKey(jobKey))
  })
}

/** Every checkpoint currently on disk, newest-updated first. Registry
 * entries whose manifest is missing/corrupt are skipped (sweepCheckpoints
 * cleans them up). */
export async function listCheckpoints(): Promise<GenerateCheckpointManifest[]> {
  const manifests: GenerateCheckpointManifest[] = []
  for (const jobKey of loadRegistry()) {
    const manifest = await readManifest(jobKey)
    if (manifest) manifests.push(manifest)
  }
  return manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Loads everything a resume needs. Returns null when the checkpoint is
 * missing or unusable (no manifest / no sources). Seeds the manifest cache
 * so subsequent commits under this jobKey patch the right record. */
export async function loadCheckpoint(jobKey: string): Promise<LoadedCheckpoint | null> {
  const manifest = await readManifest(jobKey)
  if (!manifest) return null

  const sourcesRaw = await backendGet(sourcesKey(jobKey))
  if (!sourcesRaw) return null
  let sources: SourceMaterial[]
  try {
    const parsed: unknown = JSON.parse(sourcesRaw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    sources = parsed as SourceMaterial[]
  } catch {
    return null
  }

  manifestCache.set(jobKey, manifest)

  if (!manifest.scriptDone) return { manifest, sources }

  const scriptRaw = await backendGet(scriptKey(jobKey))
  let script: Script | null = null
  try {
    script = scriptRaw ? (JSON.parse(scriptRaw) as Script) : null
  } catch {
    script = null
  }
  // Manifest says the script committed but its unit is gone/corrupt —
  // treat as pre-script (restart from scratch under the same jobKey).
  if (!script || !Array.isArray(script.segments) || script.segments.length === 0) return { manifest, sources }

  const slides: Record<number, Slide> = {}
  for (const segmentIndex of manifest.doneSegments) {
    const raw = await backendGet(slideKey(jobKey, segmentIndex))
    if (!raw) continue // uncommitted/lost unit — resume just regenerates it
    try {
      slides[segmentIndex] = JSON.parse(raw) as Slide
    } catch {
      // corrupt unit — regenerate on resume
    }
  }

  const resume: GenerateResumeState = { script, slides }

  if (manifest.refinedIteration > 0) {
    const refinedRaw = await backendGet(refinedKey(jobKey))
    try {
      const deck = refinedRaw ? (JSON.parse(refinedRaw) as Deck) : null
      if (deck && Array.isArray(deck.slides) && deck.slides.length > 0) {
        resume.refined = { deck, iteration: manifest.refinedIteration }
      }
    } catch {
      // corrupt refined snapshot — resume from assembled slides instead
    }
  }

  return { manifest, sources, resume }
}

/** Startup GC: drops registry entries with no readable manifest (interrupted
 * creates, interrupted deletes) and expires checkpoints untouched for
 * RETENTION_MS. `keepJobKeys` protects checkpoints owned by live jobs. */
export function sweepCheckpoints(keepJobKeys: ReadonlySet<string> = new Set()): void {
  void (async () => {
    for (const jobKey of loadRegistry()) {
      if (keepJobKeys.has(jobKey)) continue
      const manifest = await readManifest(jobKey)
      if (!manifest) {
        deleteCheckpoint(jobKey)
        continue
      }
      const updatedAt = Date.parse(manifest.updatedAt)
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt > RETENTION_MS) deleteCheckpoint(jobKey)
    }
  })().catch(() => {
    // best-effort — see module header
  })
}
