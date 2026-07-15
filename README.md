# TC Presenter

TC Presenter generates and auto-narrates slide decks from your own source material, using a local or remote LLM plus text-to-speech. It's part of the `tik-choco` family of apps (`tc-news`, `tc-chat`, `tc-storage`, ...) and shares configuration and cross-app messaging with them over the same browser origin.

Four tabs:

- **Sources** — collect the material a deck will be generated from: paste text/Markdown/URL+body manually, or receive articles shared from `tc-news`.
- **Editor** — generate a new deck from selected sources (outline → slides → evaluate → refine loop), then hand-edit slides, bullets, speaker notes, and layout.
- **Present** — auto-play the deck: TTS reads each slide's speaker notes and auto-advances, with a manual fallback (estimated reading time) when no TTS provider is configured.
- **Settings** — manage LLM/TTS provider connections, presets, the AI Network room, theme, and UI language.

## Setup

```bash
npm install
npm run dev      # starts Vite on http://localhost:5173 (or next free port)
npm run build    # tsc -b && vite build
npm run typecheck # tsc -b --noEmit only
```

`predev`/`prebuild` run `scripts/fetch-mistlib.mjs` automatically, which refreshes the vendored `src/vendor/mistlib` build if `MISTLIB_REPO`/`MISTLIB_REF` are set in your environment (see `.env.example`). If unset, the committed vendored build is used as-is — no network access required to run the app.

The app works with no LLM configured: Sources/Editor/Present all render, and deck generation simply reports a "no provider configured" error until you add one in Settings.

## Local LLM (Ollama / LM Studio)

Settings → LLM connections → Add provider. Two one-click presets fill in the OpenAI-compatible base URL for you:

| Preset | Base URL |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |

API key is optional for local servers. After adding a provider, add a **preset** (provider + model id, e.g. `llama3.1` or whatever you've pulled/loaded) and mark it default — that's what Editor's "Generate" and Present's TTS resolve against.

Small local models (~7B) tend to lose track of long system prompts and truncate big JSON responses. Two Editor "Advanced" options target that: **"Compact prompts"** (`promptProfile: 'compact'`) trims the generation prompt to the 6 most common block kinds instead of the full 12-block style guide, and the refine loop now defaults to **per-slide refine** (`refineStrategy: 'per_slide'`), regenerating only the low-scoring slides with small bounded calls instead of re-emitting the whole deck in one JSON blob — "batch refine" (the old whole-deck single-call behavior) is still available as an opt-in for large hosted models. Generation parsing also has stronger JSON repair for the truncated/malformed output these smaller models are prone to.

Provider/preset entries are stored in a single shared `localStorage` record (`tc-shared-llm-config-v1`) used by every `tc-*` app on the device. Writes are additive-only (no edit/delete from this UI) so configuring a provider here never clobbers another app's settings.

## tc-news integration (shared bus)

TC Presenter subscribes to the `note-article` topic on the family's shared same-origin bus (`src/lib/sharedBus.ts`, contract v1). When `tc-news` shares an article to that channel, it's converted into a `SourceMaterial` (`src/features/sources/newsArticleAdapter.ts`) and appears in the Sources tab automatically — no manual copy/paste needed. This only works when both apps run on the same origin (e.g. both under `https://tik-choco.github.io/...` or both on the same local dev host).

An experimental, currently-inert opt-in also exists for subscribing to `tc-news`'s global P2P article feed over mistlib once that wire lands in this app (`src/features/sources/globalArticlesOptIn.ts`) — enabling it today just persists the preference.

## AI Network

Instead of calling an LLM/TTS provider directly, generation and speech can be routed over `@tik-choco/mistai`'s peer-to-peer "AI Network" (Settings → AI Network → enable + set a room id). When enabled, other peers in the same room can serve chat/TTS/STT requests for you (and, via `useNetworkProvider`, this app can also advertise its own configured provider to the room). Editor's "Advanced" section has a checkbox to route a specific generation through the network instead of a direct API call.

## Evaluation: 19 metrics + refine loop

Every generated deck is scored by `src/lib/evaluator` against 19 weighted metrics (weights sum to 100), split into three classes:

- **Rule-based** (`rules.ts`, deterministic, always run): character-count overflow, empty/untitled slides, visual ratio, color-palette consistency, contrast/legibility, page-number continuity, structure coverage, title uniqueness, layout variety.
- **LLM-only** (`llmJudge.ts`, one batched call, opt-out via "Use LLM judge"): single-message-per-slide, narrative flow, title specificity, jargon annotation, speaker-notes quality, visual/text redundancy.
- **Hybrid** (rule + LLM both contribute): bullet parallelism, quantitative-data quality, citation presence, takeaway presence.

Four of these (`structure_coverage`, `title_uniqueness`, `takeaway_presence`, `layout_variety`) were added from analyzing a real sample deck (`2025-12-23-三層構造.pdf`) and target the weaknesses it exposed:

- **structure_coverage** — the sample had zero section dividers, no agenda, and no summary slide; this checks for at least one `section_break` per major topic shift plus an early agenda and a closing summary.
- **title_uniqueness** — the sample repeated the same slide title 3× unlabeled; this flags any two content slides sharing an identical title.
- **takeaway_presence** — the sample's diagram/data slides stated an explicit "so what" conclusion only ~30–35% of the time; this checks that ≥60% of them carry one.
- **layout_variety** — the sample ran 3+ consecutive slides with the same layout/block kind; this penalizes that monotony.

`DeckScore.total` is the weight-normalized average over whichever metrics actually ran, so a rule-only pass (LLM judge off or unavailable) still yields a meaningful 0–100 score instead of being capped low.

`generateDeck` (`src/features/generate/generateDeck.ts`) runs outline → slides → evaluate, and if the score is below `qualityThreshold` (default in `types.ts`'s `DEFAULT_QUALITY_THRESHOLD`) it regenerates with the low-scoring metrics' reasons + `METRIC_IMPROVEMENT_HINTS` fed back into the prompt, up to `maxRefineIterations` (default `DEFAULT_MAX_REFINE_ITERATIONS`) times, keeping the best-scoring attempt seen. Both knobs are adjustable in Editor's "Advanced" section per generation.

By default the refine pass only regenerates the worst-scoring slides one at a time (`refineStrategy: 'per_slide'`), which suits local LLMs better than one large whole-deck JSON call; the old whole-deck refine is still available as "batch refine" for large hosted models. See the Local LLM section below for this plus the compact prompt profile.

## Progressive generation, checkpoints, and resume

Generation streams its progress instead of appearing only at the end. As soon as the narration script is written, the Editor tab shows a live skeleton of the whole deck (cover, agenda, chapter dividers, one pending row per segment) that fills in slide by slide, and the queue toast shows a per-slide "3/12" counter.

Every unit of progress — the script, each segment's finished slide, each refine iteration's deck snapshot — is also **checkpointed atomically** (`src/lib/generateCheckpoint.ts`): the unit is written first and a small manifest record is updated second, so the manifest write is the commit point and a crash can never leave an observable half-state. If a generation is interrupted (tab closed, cancel, failure), the queue toast offers **Resume** the next time the app runs: the committed script and slides are reused verbatim and only the missing segments regenerate. Finished decks are promoted to the deck library in a single save, so the library never contains a half-generated deck; unresumed checkpoints expire after 7 days. Checkpoints live in mistlib's OPFS-backed KV when available (the origin-wide ~5MB `localStorage` quota is shared by every `tc-*` app) with a quota-safe `localStorage` fallback.

Editor's "Advanced" section also exposes an orchestrator/worker split: the main preset plans (script writing, evaluation, batch refine) while an optional cheaper **slide worker preset** mass-produces the per-segment slides, with a configurable number of **parallel slide workers** (default 1, i.e. sequential — local LLM servers usually process one request at a time anyway). When slides generate concurrently, layout variety is protected by a deterministic per-segment block-kind plan computed from the script instead of the sequential "don't repeat the previous slide" hint.

## Project layout

```
src/
  app.tsx                 tab shell + top-level sources/deck state
  features/sources/       source collection (manual + tc-news bus)
  features/generate/      generateDeck pipeline (pure service)
  features/editor/        deck/slide editor, wraps generate + evaluator
  features/present/       auto-narrated slide player
  features/settings/      LLM/TTS/network/theme/locale settings
  lib/                    evaluator, llm/tts clients, shared-bus/llm-config
                           (vendored, shared across tik-choco apps), kv storage
  components/slides/      slide renderer used by both editor preview and present
  i18n/                   en (default/fallback) + ja catalogs
```
