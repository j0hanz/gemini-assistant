# Packaging And Discoverability Design

Date: 2026-04-15
Status: Draft for review
Scope: MCP client onboarding, discovery, and workflow packaging for `gemini-assistant`

## Summary

This design improves first-run discoverability for MCP client users without expanding the core Gemini capability set. The server already exposes a broad tool surface, but it is still hard for a new client user to understand what the server is best at, which workflow to try first, and how sessions and caches should be used.

The release adds:

- Browseable discovery resources for tools and workflows
- A guided onboarding prompt for first-run use
- Thin workflow prompts that package existing tools into clearer entry points
- A read-only session transcript resource for visibility into multi-turn chat
- README and npm metadata updates after the MCP experience is coherent

The release does not add new core analysis tools, remote GitHub integrations, persistent storage, or transport redesign.

## Problem

The current server is capability-rich but product-light.

- The public story in `README.md` is mostly a feature list rather than a workflow guide.
- MCP clients can discover registered tools and prompts, but the server does not expose a clear "start here" path.
- Sessions are resumable but not inspectable beyond ID and last-access metadata.
- Prompts and tools are unevenly packaged. Some useful prompt shapes exist, but the product surface still expects users to infer workflows from raw capabilities.

This creates friction for the exact journey we want to optimize first:

> "I just installed this server, show me what it can do."

## Goals

- Make the server self-explaining inside MCP clients
- Provide one opinionated first-run path through the server
- Package a few common workflows without changing the core tool layer
- Make multi-turn sessions inspectable enough to build trust
- Align README and package metadata with the MCP user experience

## Non-Goals

- Adding new core Gemini tools or new model behaviors
- Adding remote PR review or external service integrations
- Persisting sessions or transcripts beyond the current in-memory lifecycle
- Redesigning the transport layer
- Refactoring unrelated existing tool internals

## User Journey

Primary journey:

1. A user installs the server in an MCP client.
2. The user browses a discovery resource and immediately sees what the server is for.
3. The user follows an opinionated `getting-started` path.
4. The user tries one or two workflows with existing tools.
5. If the user starts a multi-turn chat, the session is inspectable through a transcript resource.
6. The README reinforces the same workflow model the MCP client already exposes.

## Proposed MCP Surface

### `tools://list`

Add a new read-only resource that returns a stable JSON catalog of the server's tools, prompts, and resources.

Each entry should include:

- `name`
- `kind` (`tool`, `prompt`, or `resource`)
- `title`
- `bestFor`
- `whenToUse`
- `inputs`
- `returns`
- `related`

This resource is a discovery index, not generated prose. It should be concise, stable, and easy for clients to render.

### `workflows://list`

Add a new read-only resource that exposes opinionated starter workflows.

Initial workflows:

- `getting-started`
- `project-memory`
- `deep-research`
- `diff-review`
- `analyze-file`

Each workflow should include:

- `name`
- `goal`
- `whenToUse`
- `steps`
- `recommendedTools`
- `recommendedPrompts`
- `relatedResources`

This resource should guide users toward sensible first actions rather than merely list possibilities.

### New prompts

Add the following prompts as thin wrappers around the existing tool set:

- `getting-started`
- `deep-research`
- `project-memory`
- `diff-review`

Prompt design rules:

- Each prompt should be instructional, not magical
- Each prompt should explain what the user should try and what result shape to expect
- Prompts should not duplicate implementation logic from tools
- Prompts should reference the recommended tools, resources, and expected workflow sequence

### `sessions://{sessionId}/transcript`

Add a new read-only resource that exposes a lightweight transcript for a single active session.

Transcript entries should include:

- `role`
- `text`
- `timestamp`
- optional `taskId`

This is intentionally in-memory and ephemeral. It exists to provide visibility into active sessions, not long-term history or export.

## Internal Design

### Catalog metadata layer

Add a small metadata module that acts as the single source of truth for the packaging layer.

It should define:

- discovery entries for tools
- discovery entries for prompts
- discovery entries for resources
- workflow definitions

This metadata layer should drive:

- `tools://list`
- `workflows://list`
- prompt references and "related" links
- README copy and package vocabulary where practical

The purpose is to avoid scattering product-facing descriptions across registration sites, tests, and docs.

### Session transcript storage

The current session layer stores the Gemini `Chat` object and access metadata, but not a replayable transcript. To support `sessions://{sessionId}/transcript`, extend session state with a lightweight transcript collection.

Transcript capture should happen at the `ask` boundary:

- When a user message is accepted for a session, append a user entry
- When the final assistant text is produced, append an assistant entry
- Transcript state should live and die with the session

This keeps transcript handling independent from Gemini SDK internals and avoids introducing persistence concerns in this release.

## Behavioral Requirements

### Discovery resources

- `tools://list` should remain concise and deterministic
- `workflows://list` should be opinionated and put `getting-started` first
- Both resources should return JSON shaped for browsing, not essay-style text

### Workflow prompts

- `getting-started` should present the recommended first-run path
- `deep-research` should package the existing research capability with clearer expectations around structure and sources
- `project-memory` should explain when to use caches versus sessions
- `diff-review` should cover change-review workflows without expanding into remote integrations

### Transcript resource

- `sessions://{sessionId}/transcript` is read-only
- Missing sessions should return a normal JSON payload with an `error` field
- Transcript data should disappear when the session expires or is evicted

## Error Handling

- Missing transcript resource target:
  Return `{ "error": "Session not found" }` in the JSON resource payload.
- Broken catalog references:
  Catch them in tests rather than relying on runtime fallbacks.
- Prompt or workflow drift:
  Fail with consistency tests if discovery metadata references removed or renamed items.

## Testing

Add tests for:

- `tools://list` resource contents and shape
- `workflows://list` resource contents and ordering
- `sessions://{sessionId}/transcript` happy path and missing-session behavior
- catalog consistency between metadata and actual registered items
- prompt validation and message-building for:
  - `getting-started`
  - `deep-research`
  - `project-memory`
  - `diff-review`
- transcript lifecycle:
  - transcript creation on first `ask`
  - transcript append on later turns
  - transcript removal on expiry or eviction

The initiative should not widen transport scope unless one of the new resources reveals an existing issue.

## Documentation And Packaging

Update `README.md` after the MCP surface is implemented.

The README should be reframed around workflows:

- Start here
- Common jobs
- When to use sessions versus caches
- How to inspect discovery resources

Update package metadata only after the workflow vocabulary is stable. At minimum, review:

- `repository`
- `keywords`
- `license`
- `files`
- `exports`

Add a minimal environment example and a concise MCP client setup snippet to the README.

## Delivery Order

1. Add the catalog metadata layer
2. Add `tools://list` and `workflows://list`
3. Add the new prompts
4. Add transcript capture and `sessions://{sessionId}/transcript`
5. Update README and package metadata
6. Add consistency and lifecycle tests

## Success Criteria

- A first-time MCP user can understand what to try first without reading source files
- The server exposes a clear onboarding path through `getting-started`
- Sessions are inspectable enough to make multi-turn chat behavior trustworthy
- The README and package metadata describe the same workflows the MCP surface exposes
- Tests fail when discovery metadata drifts from real registrations

## Risks And Controls

### Risk: metadata drift

If the discovery catalog becomes detached from real registrations, the packaging layer will rot quickly.

Control:
Add explicit consistency tests that validate every referenced tool, prompt, and resource.

### Risk: scope drift into new feature work

The packaging initiative can easily turn into a broader product overhaul.

Control:
Keep the release limited to discovery, onboarding, transcript visibility, and docs/package polish.

### Risk: transcript implementation overreaches

If transcript handling becomes tightly coupled to SDK internals, it will be fragile.

Control:
Capture transcript entries only at the tool boundary using lightweight text records.

## Open Decisions Resolved In This Design

- Target audience for first pass: MCP client users
- Preferred onboarding shape: both browseable discovery resources and a guided quickstart path
- First journey to optimize: "I just installed this server, show me what it can do."
- Recommended approach: guided onboarding layer with a small amount of deeper packaging polish
