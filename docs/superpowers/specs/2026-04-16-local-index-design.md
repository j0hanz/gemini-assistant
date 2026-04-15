# Local Index Design

Date: 2026-04-16
Status: Draft for review
Scope: Persistent local-workspace indexing and retrieval for `gemini-assistant`

## Summary

This design adds a real local indexing layer to `gemini-assistant` for workspace files. It fills the current gap between one-off `analyze_file` uploads and heavyweight Gemini caches by giving the server a persistent, auto-updating retrieval surface for project documents and source files.

The release adds:

- A new `index` tool family with explicit lifecycle and query contracts
- Persistent on-disk indexes that survive server restarts
- Workspace-only indexing under the existing allowed-root security model
- Incremental `autoUpdate` behavior for indexed files
- Grouped-by-file retrieval results for evidence inspection
- A separate `query_index` tool for retrieve-then-synthesize workflows
- Read-only index resources for status and inspection

The release does not add:

- Gemini File Search store parity
- Arbitrary external URL or file ingestion
- Binary, image, audio, video, or PDF indexing in v1
- Silent web fallback inside local retrieval
- A hidden retrieval mode inside `ask`

## Problem

The current server has strong primitives, but they do not cover the most valuable middle-tier retrieval workflow.

- `analyze_file` is good for one file at a time.
- `create_cache` is useful for large repeated context, but it is coarse, token-thresholded, and not shaped for retrieval.
- `search` and `agentic_search` cover web-grounded research, not local corpus retrieval.
- `ask` supports sessions and tool orchestration, but it should not become an unbounded umbrella for every retrieval behavior.

This leaves a common user job underserved:

> "Search my workspace docs and code, show me the evidence, and answer from it."

The Google File Search docs in `.github/file-search.md` describe a product class the current server explicitly does not expose. The right response for this repo is not to bolt that full product on immediately, but to provide a workspace-native index layer that matches the current server boundaries and product style.

## Goals

- Add a clear, explicit local retrieval surface for workspace files
- Keep the public API short, verb-first, and aligned with existing tool naming
- Preserve the current allowed-root security boundary for all indexed content
- Persist index state on disk so it remains useful across server restarts
- Support incremental `autoUpdate` rather than forcing full rebuilds
- Make retrieval output inspectable and citation-friendly
- Keep synthesis separate from raw retrieval through a dedicated `query_index` tool
- Leave room for future multi-tool orchestration without bloating `ask`

## Non-Goals

- Exposing Gemini File Search stores or document APIs in v1
- Importing external URLs, remote documents, or arbitrary non-workspace paths
- Indexing PDFs or binary formats in v1
- Replacing Gemini caches
- Replacing `analyze_file` for one-file tasks
- Automatically invoking Google Search when local retrieval is weak
- Building a general-purpose search product beyond the workspace use case

## User Journeys

Primary journeys:

1. A user creates an index over one or more workspace folders.
2. The index builds and persists to disk.
3. The user runs `search_index` to inspect matching evidence grouped by file.
4. The user runs `query_index` to get a grounded answer synthesized from retrieved local evidence.
5. Indexed files change on disk, and the index updates incrementally when `autoUpdate` is enabled.
6. The user restarts the server and the index remains available.

Secondary journeys:

1. A user inspects index metadata through a resource before querying it.
2. A user updates include/exclude patterns or roots and refreshes the index.
3. A user deletes an index that is stale or no longer needed.

## Proposed MCP Surface

### Tools

Add the following tools:

- `create_index`
- `update_index`
- `search_index`
- `query_index`
- `delete_index`
- `list_indexes`

This keeps lifecycle operations explicit and reserves `query_index` for retrieve-then-synthesize behavior rather than overloading `ask`.

### Resources

Add the following read-only resources:

- `indexes://list`
- `indexes://{indexName}`

These resources mirror the current `sessions://...` and `caches://...` model by making the new capability inspectable without requiring a tool call.

## Tool Contracts

### `create_index`

Purpose:
Create a new persistent workspace index and run the initial build.

Required inputs:

- `name`
- `roots`

Optional inputs:

- `include`
- `exclude`
- `autoUpdate`

Contract notes:

- `roots` must resolve inside the same allowed-root model already enforced for file tools.
- `roots` should accept workspace-relative or absolute paths.
- `include` and `exclude` are glob patterns evaluated relative to the configured roots.
- `autoUpdate` defaults to `true`.
- The tool should fail fast if the filtered file set is empty.

Returns:

- index metadata
- build status
- counts for indexed files and chunks
- persistent detail resource link

### `update_index`

Purpose:
Refresh index configuration and/or rebuild changed content.

Inputs:

- `indexName`
- optional updated `roots`
- optional updated `include`
- optional updated `exclude`
- optional `autoUpdate`
- optional `rebuild`

Contract notes:

- Without config changes, `update_index` should refresh the index against current file state.
- With config changes, it should reconcile added and removed files.
- `rebuild=true` forces a full rebuild and clears prior chunk state for that index.

Returns:

- updated metadata
- refresh outcome
- changed file counts

### `search_index`

Purpose:
Search indexed workspace content and return inspectable evidence.

Inputs:

- `indexName`
- `query`
- optional `topK`
- optional path filters

Returns:

- grouped results by file
- file-level hit count
- excerpted matching chunks per file
- ranking metadata suitable for inspection, not just opaque IDs

Behavior:

- Results should be grouped by file, not returned as a flat chunk dump.
- Each file result should include short excerpts and chunk-level metadata.
- The output should favor readability and downstream use by `query_index`.

### `query_index`

Purpose:
Retrieve from the index and synthesize an answer from retrieved evidence.

Inputs:

- `indexName`
- `query`
- optional `topK`
- optional path filters
- optional `responseSchema`
- optional `thinkingLevel`

Returns:

- answer text
- grouped citations by file
- excerpts used for grounding
- structured output when `responseSchema` is provided

Behavior:

- `query_index` is local-only in v1.
- It must answer from retrieved index evidence only.
- If retrieval is weak, the tool should say so explicitly rather than silently broadening to web search.
- `responseSchema` support is appropriate here because `query_index` is a single-turn, bounded synthesis tool.

### `list_indexes`

Purpose:
List all persisted indexes and their current status.

Returns:

- name
- roots
- auto-update state
- file count
- chunk count
- last build/update timestamps
- status summary

### `delete_index`

Purpose:
Delete a persisted index and its associated on-disk data.

Inputs:

- `indexName`
- optional `confirm`

Behavior:

- Follow the same explicit confirmation model used by `delete_cache`.

## Internal Design

### Index Definition

Each index should have a persisted manifest that captures:

- `name`
- `roots`
- `include`
- `exclude`
- `autoUpdate`
- file inventory metadata
- chunk inventory metadata
- build timestamps
- health/status fields

This manifest is the contract boundary between lifecycle tools, retrieval tools, and resources.

### Storage Model

Persist indexes on disk under a server-owned workspace-scoped directory rather than in transient memory.

The storage layout should separate:

- index manifest
- normalized file inventory
- chunk records
- searchable retrieval data
- watcher/update bookkeeping

The exact folder name can be chosen during implementation, but it should be clearly internal and stable.

Persistence requirements:

- Survive server restarts
- Be rebuildable from source files if storage becomes inconsistent
- Keep per-index data isolated
- Make deletion complete and deterministic

### File Selection

Index scope is defined by:

- `roots`
- `include`
- `exclude`

Selection rules:

- resolve all roots through the existing workspace path validation layer
- include only files under allowed roots
- ignore directories and symlink escapes
- ignore files that do not pass v1 text-only eligibility

The same path ambiguity and allowed-root rules already enforced for local file tools should apply here as well.

### File Eligibility

V1 is text-only.

Include:

- source code
- Markdown
- JSON
- YAML
- TOML
- plain text
- logs
- CSV
- similar UTF-8 text formats

Exclude:

- binaries
- images
- audio
- video
- archives
- PDFs
- office formats

Binary detection should be content-aware, not extension-only, so the index behaves safely and predictably.

### Chunking

Chunking should be deterministic and stable for a given file version.

Requirements:

- preserve file path and chunk order
- keep chunk sizes practical for retrieval and citation
- include light overlap to avoid boundary loss
- record chunk offsets or line spans where feasible

Chunk metadata should include:

- `filePath`
- chunk ordinal
- character or line-range boundaries
- file version fingerprint

### Retrieval Strategy

V1 should use a pragmatic hybrid local ranker:

1. Fast local prefilter based on file path terms and textual term match
2. Semantic ranking over stored chunk representations
3. File-level grouping and score aggregation

Why this approach:

- pure lexical search is not strong enough for natural-language project questions
- pure semantic search is harder to debug and weaker on exact symbol/path intent
- grouped-by-file output benefits from both chunk relevance and file-level aggregation

The implementation may use Gemini embeddings for semantic chunk representations as long as:

- the resulting behavior is persisted and repeatable
- failures degrade cleanly
- the contract does not expose backend-specific implementation details

If semantic ranking is temporarily unavailable, the system should degrade to lexical-only retrieval with a visible status note rather than fail opaquely.

### Auto-Update Model

`autoUpdate` should be incremental.

Behavior:

- watch configured roots for file creation, modification, rename, and deletion
- debounce bursts of changes
- queue dirty paths per index
- reprocess only affected files and chunks
- remove deleted files from the index

On startup:

- run a reconciliation scan before the watcher becomes authoritative
- detect drift from missed events during downtime

This avoids the cost and noise of full rebuilds while preserving correctness.

### Query Flow

### `search_index`

Flow:

1. validate index existence and readiness
2. run retrieval
3. group hits by file
4. return evidence-first results

This tool should behave like retrieval inspection, not answer generation.

### `query_index`

Flow:

1. validate index existence and readiness
2. retrieve top chunks
3. group and trim evidence to a bounded answer context
4. synthesize an answer from retrieved evidence only
5. return answer plus citations

This tool is the main orchestration surface for local retrieval. It should remain explicit so future combinations such as local retrieval plus web grounding can be added later without rewriting `ask`.

## Resources

### `indexes://list`

Return a concise JSON list of persisted indexes including:

- `name`
- `roots`
- `autoUpdate`
- `status`
- file count
- chunk count
- last update timestamp

### `indexes://{indexName}`

Return full detail for a single index including:

- config
- build status
- file/chunk counts
- recent update state
- warnings or degraded modes

This mirrors the current resource-driven discoverability style used for caches and sessions.

## Behavioral Requirements

### Lifecycle

- index creation should fail on duplicate names
- deletion should remove persistent storage completely
- updates should preserve stable index identity
- startup should load persisted indexes without forcing immediate rebuilds unless reconciliation detects drift

### Retrieval

- `search_index` must return grouped-by-file results
- excerpts should be short enough to inspect but rich enough to understand why the file matched
- results should be deterministic for the same query and index state, subject to semantic ranking ties

### Grounding

- `query_index` must not answer from outside the retrieved evidence set
- citations should reference file paths and excerpts, not only opaque internal chunk IDs
- weak retrieval should be surfaced explicitly

### Safety

- all indexed paths remain bounded by allowed roots
- v1 should never reach outside the workspace model for indexing
- index resources expose metadata, not raw file dumps

## Error Handling

- Missing index:
  return a normal tool/resource error that the named index was not found.
- Empty index selection:
  fail `create_index` or `update_index` if filters resolve to no eligible files.
- File access drift:
  mark the affected file as skipped and expose warnings in index status.
- Corrupt index storage:
  return a repairable error with a clear suggestion to rebuild.
- Retrieval degradation:
  if semantic ranking is unavailable, continue with lexical retrieval and expose the degraded mode.
- Auto-update backlog:
  show status as updating or degraded rather than pretending the index is fully current.

## Testing

Add tests for:

- input schema validation for all new tools
- allowed-root enforcement for index roots
- include/exclude matching behavior
- text-only file eligibility rules
- create/list/detail/delete lifecycle
- persistence across a simulated restart
- incremental update on file create, modify, rename, and delete
- grouped-by-file `search_index` result shape
- `query_index` grounding and citation output
- degraded-mode behavior when semantic ranking is unavailable
- resource consistency between registrations, catalog entries, and README documentation

## Documentation

Update the public documentation after implementation to explain:

- when to use `analyze_file` versus `search_index` versus `query_index`
- how indexes differ from caches
- that v1 is workspace-only and text-only
- that local retrieval is explicit and does not silently fall back to web grounding

The discovery catalog should also describe the new tool family in the same concise contract-oriented style already used for caches, sessions, and research tools.

## Delivery Order

1. Add index schemas and tool registration stubs
2. Add persisted index manifest and storage model
3. Implement file discovery, eligibility, and chunking
4. Implement initial build and persistence
5. Implement `search_index`
6. Implement `query_index`
7. Implement incremental `autoUpdate`
8. Add resources and discoverability metadata
9. Add documentation and consistency tests

## Success Criteria

- A user can build a persistent index over workspace folders without leaving the current security model
- `search_index` provides useful grouped evidence instead of raw chunk noise
- `query_index` answers grounded local questions from indexed project content
- indexes remain available across restarts
- `autoUpdate` keeps an index current without full rebuilds on ordinary edits
- the tool family remains explicit, compact, and easy to reason about

## Risks And Controls

### Risk: scope inflation into a full document platform

If the feature expands into arbitrary ingestion, broad file-type handling, and external store lifecycle, it will stop fitting the current repo.

Control:
Keep v1 workspace-only, text-only, and explicit about its boundaries.

### Risk: retrieval quality is too weak with naive ranking

If search behaves like a brittle grep wrapper, the feature will not justify its complexity.

Control:
Use a hybrid local ranker and make grouped evidence inspection first-class.

### Risk: auto-update becomes noisy or expensive

If every change triggers large rebuilds, the feature will feel unstable.

Control:
Use debounced dirty-path queues and incremental reconciliation.

### Risk: `ask` becomes an implicit second query surface

If local retrieval is hidden inside `ask`, users lose predictability.

Control:
Keep retrieval and retrieval-plus-synthesis in `search_index` and `query_index`.

### Risk: persistence becomes fragile

If on-disk state corrupts easily, users will not trust the feature.

Control:
Keep manifests explicit, detect corruption, and make rebuild recovery straightforward.

## Open Decisions Resolved In This Design

- Naming family: `index`
- Scope: local workspace files only
- Updates: incremental `autoUpdate`
- Selection model: folder roots plus include/exclude globs
- Retrieval presentation: grouped by file
- Persistence: yes, on disk
- Content scope: text-only in v1
- Synthesis surface: separate `query_index`, not hidden inside `ask`
