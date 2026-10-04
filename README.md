# TC Presenter

TC Presenter generates and auto-narrates slide decks from your own source material, using a local or remote LLM plus text-to-speech. It's part of the `tik-choco` family of apps (`tc-news`, `tc-chat`, `tc-storage`, ...) and shares configuration and cross-app messaging with them over the same browser origin.

Four tabs:

- **Sources** — collect the material a deck will be generated from: paste text/Markdown/URL+body manually, or receive articles shared from `tc-news`.
- **Editor** — generate a new deck from selected sources (outline → slides → evaluate → refine loop), then hand-edit slides, bullets, speaker notes, and layout.
- **Present** — auto-play the deck: TTS reads each slide's speaker notes and auto-advances, with browser speech by default and an estimated-duration fallback when speech is unavailable.
- **Settings** — manage shared HTTP and room connections, task model references and reasoning effort, per-room sharing, TTS, and UI language.

## Setup

```bash
npm install
npm run dev      # starts Vite on http://localhost:5173 (or next free port)
npm run build    # tsc -b && vite build
npm run typecheck # tsc -b --noEmit only
```

`predev`/`prebuild` run `scripts/fetch-mistlib.mjs` automatically, which refreshes the vendored `src/vendor/mistlib` build if `MISTLIB_EXAMPLES_REPO`/`MISTLIB_EXAMPLES_REF` are set in your environment (see `.env.example`). If unset, the committed vendored build is used as-is — no network access required to run the app.

The app works with no LLM configured: Sources/Editor/Present all render, and deck generation simply reports a "no provider configured" error until you add one in Settings.

## AI settings

The mistai 0.9 settings panel has Connections, Tasks and Sharing tabs. Add an HTTP endpoint or a room under Connections, then select the shared default and this app's planning, slide generation, vision and default-task models under Tasks. Each task keeps its own reasoning effort; requests never send temperature. TTS may use a selected HTTP model, a room model, room auto, or browser speech.

Connections live in the shared `tc-shared-llm-config-v1` record. Legacy presets, defaultPresetId and network fields are preserved unchanged for other apps. On load, mistai imports the default model and legacy room; this app migrates its task and shared-preset IDs once into `tc-presenter:ai-settings-v2`. Disabling connections preserves refs and falls back only to a usable shared default.

Sharing runs independently in each enabled room, using only enabled HTTP models and raw model IDs. Consumers use one shared physical node and independent room sessions, including the OpenAI tunnel for vision and reasoning effort. The room chips control providing; there is no global network switch.

Editor keeps planning and slide-generation model overrides and parallel slide workers. Saved task defaults live in Settings. Layout variety stays deterministic when workers run concurrently.

## tc-news integration (shared bus)

TC Presenter subscribes to the `note-article` topic on the family's shared same-origin bus (`src/lib/sharedBus.ts`, contract v1). When `tc-news` shares an article to that channel, it's converted into a `SourceMaterial` (`src/features/sources/newsArticleAdapter.ts`) and appears in the Sources tab automatically — no manual copy/paste needed. This only works when both apps run on the same origin (e.g. both under `https://tik-choco.github.io/...` or both on the same local dev host).

An experimental, currently-inert opt-in also exists for subscribing to `tc-news`'s global P2P article feed over mistlib once that wire lands in this app (`src/features/sources/globalArticlesOptIn.ts`) — enabling it today just persists the preference.

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

The narration script itself is also checked before any slide generates from it (`src/features/generate/scriptCheck.ts`): a rule-based pass validates the script against `buildScriptMessages`' contract — exactly one intro/conclusion, narration written as spoken sentences (not an outline), heading/takeaway lengths, duplicate headings, chapter-grouping consistency — and if issues are found, one bounded LLM repair call rewrites the script, kept only when the re-check shows strictly fewer issues. This runs before the script's checkpoint commit, so a resumed run always resumes from the checked script. On by default; Editor's "Advanced" section has a toggle (`GenerateOptions.scriptCheck`).

Per-segment slide layouts are planned content-aware (`src/features/generate/layoutPlan.ts`): each body segment's heading/narration/takeaway is keyword-matched (Japanese + English) against the block-kind vocabulary (flow for procedures, comparison for trade-offs, boxGroup for structures, …) so the layout hint actually fits the content, with least-recently-used rotation as the no-signal fallback, a no-3-consecutive-repeats guard, and deliberate structure reuse for progressive-disclosure continuations. This replaces the earlier content-blind fixed rotation.

## Progressive generation, checkpoints, and resume

Generation streams its progress instead of appearing only at the end. As soon as the narration script is written, the Editor tab shows a live skeleton of the whole deck (cover, agenda, chapter dividers, one pending row per segment) that fills in slide by slide, and the queue toast shows a per-slide "3/12" counter.

Every unit of progress — the script, each segment's finished slide, each refine iteration's deck snapshot — is also **checkpointed atomically** (`src/lib/generateCheckpoint.ts`): the unit is written first and a small manifest record is updated second, so the manifest write is the commit point and a crash can never leave an observable half-state. If a generation is interrupted (tab closed, cancel, failure), the queue toast offers **Resume** the next time the app runs: the committed script and slides are reused verbatim and only the missing segments regenerate. Finished decks are promoted to the deck library in a single save, so the library never contains a half-generated deck; unresumed checkpoints expire after 7 days. Checkpoints live in mistlib's OPFS-backed KV when available (the origin-wide ~5MB `localStorage` quota is shared by every `tc-*` app) with a quota-safe `localStorage` fallback.

Editor exposes planning and slide-generation model overrides and parallel slide workers. Saved task defaults live in Settings. Layout variety stays deterministic when workers run concurrently.

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
