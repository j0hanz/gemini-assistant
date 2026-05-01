# Resources

This document describes the MCP resources exposed by `gemini-assistant`.

## resources/list

Static resources available via the MCP server:

```json
[
  {
    "name": "assistant://discover/catalog",
    "title": "Discovery Catalog Resource",
    "uri": "assistant://discover/catalog",
    "description": "Browsing the full public surface from one shared metadata source. Use for a machine-readable list of public tools, prompts, and resources.",
    "mimeType": "application/json",
    "annotations": {
      "audience": "internal",
      "priority": "high"
    },
    "returns": "JSON and Markdown discovery catalog content."
  },
  {
    "name": "assistant://discover/context",
    "title": "Server Context Dashboard",
    "uri": "assistant://discover/context",
    "description": "Inspecting the server knowledge state: workspace files, sessions, and config. Use to understand available server context.",
    "mimeType": "application/json",
    "annotations": {
      "audience": "internal",
      "priority": "high"
    },
    "returns": "JSON snapshot of the server context state."
  },
  {
    "name": "assistant://discover/workflows",
    "title": "Workflow Catalog Resource",
    "uri": "assistant://discover/workflows",
    "description": "Browsing job-first starter workflows instead of a raw list of names. Use to find recommended entry points for common jobs.",
    "mimeType": "application/json",
    "annotations": {
      "audience": "internal",
      "priority": "high"
    },
    "returns": "JSON and Markdown workflow catalog content."
  },
  {
    "name": "gemini://profiles",
    "title": "Tool Profiles Resource",
    "uri": "gemini://profiles",
    "description": "Discovering available tool profiles, their built-in capabilities, and valid combinations. Use to understand which profile to pass in the tools.profile field for chat, research, analyze, or review.",
    "mimeType": "application/json",
    "annotations": {
      "audience": "external",
      "priority": "high"
    },
    "returns": "JSON catalog of all 11 tool profiles with builtIns, defaultThinkingLevel, notes, and a comboMatrix of valid capability combinations."
  },
  {
    "name": "gemini://sessions",
    "title": "Session List Resource",
    "uri": "gemini://sessions",
    "description": "Browsing active in-memory chat sessions. Use to inspect or resume a chat session.",
    "mimeType": "application/json",
    "annotations": {
      "audience": "external",
      "priority": "high"
    },
    "returns": "JSON list of active session summaries (id, lastAccess, and related metadata)."
  },
  {
    "name": "gemini://workspace/cache",
    "title": "Workspace Cache Resource",
    "uri": "gemini://workspace/cache",
    "description": "Inspecting automatic workspace cache state. Use to verify workspace caching status.",
    "mimeType": "application/json",
    "annotations": {
      "audience": "external",
      "priority": "medium"
    },
    "returns": "JSON workspace cache status."
  },
  {
    "name": "gemini://workspace/cache/contents",
    "title": "Workspace Context Resource",
    "uri": "gemini://workspace/cache/contents",
    "description": "Viewing the assembled workspace context used for Gemini calls. Use to inspect which local files are summarized for the model.",
    "mimeType": "application/json",
    "annotations": {
      "audience": "external",
      "priority": "medium"
    },
    "returns": "Markdown workspace context with sources and token estimate."
  }
]
```

## resources/templates/list

Template resources with parameter placeholders and concrete examples:

```json
[
  {
    "uri": "gemini://session/{sessionId}",
    "name": "session_detail",
    "title": "Session Detail Resource",
    "description": "Inspecting a single active session entry. Use to get details for one session.",
    "parameters": ["sessionId"],
    "mimeType": "application/json",
    "examples": [
      {
        "description": "Retrieve details for session with ID abc123xyz",
        "uri": "gemini://session/abc123xyz"
      }
    ],
    "returns": "JSON metadata for the selected session."
  },
  {
    "uri": "gemini://session/{sessionId}/transcript",
    "name": "session_transcript",
    "title": "Session Transcript Resource",
    "description": "Inspecting the text transcript for one active session. Use for read-only visibility into recent turns.",
    "parameters": ["sessionId"],
    "mimeType": "application/json",
    "limitations": ["Transcript access requires MCP_EXPOSE_SESSION_RESOURCES=true."],
    "examples": [
      {
        "description": "Retrieve transcript for session abc123xyz",
        "uri": "gemini://session/abc123xyz/transcript"
      }
    ],
    "returns": "JSON and Markdown transcript entries."
  },
  {
    "uri": "gemini://session/{sessionId}/events",
    "name": "session_events",
    "title": "Session Events Resource",
    "description": "Inspecting normalized Gemini tool and function activity for one active session. Use to get the server-managed inspection summary.",
    "parameters": ["sessionId"],
    "mimeType": "application/json",
    "limitations": ["Events access requires MCP_EXPOSE_SESSION_RESOURCES=true."],
    "examples": [
      {
        "description": "Retrieve events for session abc123xyz",
        "uri": "gemini://session/abc123xyz/events"
      }
    ],
    "returns": "JSON and Markdown event summaries."
  },
  {
    "uri": "gemini://session/{sessionId}/turn/{turnIndex}/parts",
    "name": "session_turn_parts",
    "title": "Session Turn Parts Resource",
    "description": "Retrieving SDK-faithful Gemini Part[] for one persisted model turn. Use for replay-safe multi-turn orchestration that needs SDK-faithful parts.",
    "parameters": ["sessionId", "turnIndex"],
    "mimeType": "application/json",
    "limitations": ["Raw turn-parts access requires MCP_EXPOSE_SESSION_RESOURCES=true."],
    "examples": [
      {
        "description": "Retrieve parts for turn 0 of session abc123xyz",
        "uri": "gemini://session/abc123xyz/turn/0/parts"
      },
      {
        "description": "Retrieve parts for turn 5 of session xyz789abc",
        "uri": "gemini://session/xyz789abc/turn/5/parts"
      }
    ],
    "returns": "JSON array of Gemini Part objects for the selected persisted turn. Oversized inlineData payloads are elided but all other parts — including thought and thoughtSignature — are served verbatim."
  }
]
```

## Resource URIs

All resource URIs follow the MCP URI scheme with two primary namespaces:

- **`assistant://`** - Server discovery and introspection resources
  - `assistant://discover/catalog` - Full discovery catalog
  - `assistant://discover/context` - Server context dashboard
  - `assistant://discover/workflows` - Workflow catalog

- **`gemini://`** - Gemini and workspace resources
  - Static resources: `gemini://profiles`, `gemini://sessions`, `gemini://workspace/cache`, `gemini://workspace/cache/contents`
  - Template resources: `gemini://session/{sessionId}`, `gemini://session/{sessionId}/transcript`, `gemini://session/{sessionId}/events`, `gemini://session/{sessionId}/turn/{turnIndex}/parts`

## Notes

- All static resources return JSON (application/json).
- Resources with `MCP_EXPOSE_SESSION_RESOURCES=true` requirement are session-specific resources.
- Template URIs accept path parameters in `{camelCase}` format.
- Session IDs are alphanumeric strings generated by the server.
- Turn indices are zero-based integers.
