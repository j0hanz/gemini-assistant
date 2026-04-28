---
goal: Extend readme-wizard's scan_project.sh with function-organized structure, 5 new language stacks, runtime version / test framework / deploy target detection, and update SKILL.md to consume the new fields.
version: 1
date_created: 2026-04-28
status: Planned
plan_type: feature
component: readme-wizard
execution: subagent-driven
---

# Implementation Plan: readme-wizard Enhancements

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Rewrite `scan_project.sh` from flat sequential code into named functions, add PHP/Ruby/.NET/Elixir/Swift language stacks, and detect runtime version, test framework, and deploy target — then surface all new fields in `SKILL.md`.

**Architecture:** All changes are confined to two files in the skill directory (`scripts/scan_project.sh` and `SKILL.md`). The script grows from one flat block into named functions (`detect_project_identity`, `detect_license`, `detect_git_remote`, `detect_language_stack`, `detect_runtime_version`, `detect_test_framework`, `detect_deploy_target`, `detect_ci`, `detect_directory_structure`, `output_json`) plus the existing `collect_social_links` and `json_escape`. Each task adds or modifies one function and its output_json field in isolation. `SKILL.md` is updated last to consume all new fields.

**Tech Stack:** Bash 4+, Python 3 (for JSON verification), Git Bash / WSL on Windows.

---

## 1. Goal

Refactor `scan_project.sh` into a function-organized structure and extend it with three new detection capabilities (runtime version, test framework, deploy target) and five new language stacks (PHP/Composer, Ruby/Bundler, .NET, Elixir/Mix, Swift/SPM). Update `SKILL.md` Steps 1, 3, 4, and 6 to surface the new data in generated READMEs. Completion is observable by running the script against fixture directories and confirming new JSON fields appear with correct values.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                                                 |
| :---------------------------------------: | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `scan_project.sh` outputs valid JSON after every task.                                                                                                                                    |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Existing fields (`project_name`, `description`, `license`, `owner`, `repo`, `package_manager`, `ci`, `social_links`, `directory_structure`) are present and unchanged after the refactor. |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Three new JSON fields are present after all detection tasks: `framework`, `runtime_version`, `test_framework`, `deploy_target`.                                                           |
| [`REQ-004`](#2-requirements--constraints) | Requirement | `SKILL.md` Steps 1, 3, 4, 6 reference all four new fields.                                                                                                                                |
| [`CON-001`](#2-requirements--constraints) | Constraint  | No external dependencies introduced — bash builtins, `grep`, `sed`, `find`, `curl` only.                                                                                                  |
| [`CON-002`](#2-requirements--constraints) | Constraint  | `set -euo pipefail` remains at the top of the script.                                                                                                                                     |
| [`CON-003`](#2-requirements--constraints) | Constraint  | The skill directory may not be a git repo. Run `git -C "$SKILL_DIR" rev-parse --git-dir 2>/dev/null` to check. If no git repo, skip commit steps and just save the file.                  |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | All detections use "first match wins" ordering — more specific checks before less specific.                                                                                               |

## 3. Current Context

### File structure

| File                                               | Status | Responsibility                                                        |
| :------------------------------------------------- | :----- | :-------------------------------------------------------------------- |
| [scripts/scan_project.sh](scripts/scan_project.sh) | Modify | Scan a project directory and emit JSON metadata for README generation |
| [SKILL.md](SKILL.md)                               | Modify | 7-step README generation workflow referencing the scan fields         |

> **Note:** Both files live in the skill directory at `C:/Users/PC/.claude/skills/readme-wizard/`. Set `SKILL_DIR=C:/Users/PC/.claude/skills/readme-wizard` before running any commands in this plan. All `bash scripts/scan_project.sh` commands are run from `$SKILL_DIR`.

### Existing commands

```bash
# Verify JSON output from the script
bash scripts/scan_project.sh /path/to/project | python3 -m json.tool

# Validate a specific field
bash scripts/scan_project.sh /path/to/project | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['package_manager'])"
```

### Current behavior

`scan_project.sh` is ~270 lines of flat sequential code. It detects: project identity, license, git remote, package manager (Node/Python/Rust/Go/Java/Deno), CI provider, social links, and directory structure. It emits JSON with 9 top-level fields. It does not detect runtime version, test framework, deploy target, or the PHP/Ruby/.NET/Elixir/Swift language families.

## 4. Implementation Phases

### PHASE-001: Refactor into function structure

**Goal:** Rewrite `scan_project.sh` as named functions with identical behavior — same JSON output, zero new fields.

|                               Task                                | Action                            | Depends on | Files                                              | Validate                                                          |
| :---------------------------------------------------------------: | :-------------------------------- | :--------: | :------------------------------------------------- | :---------------------------------------------------------------- |
| [`TASK-001`](#task-001-rewrite-scan_projectsh-as-named-functions) | Rewrite script as named functions |    none    | [scripts/scan_project.sh](scripts/scan_project.sh) | `bash scripts/scan_project.sh $SKILL_DIR \| python3 -m json.tool` |

#### TASK-001: Rewrite scan_project.sh as named functions

| Field      | Value                                                                                                                                                                                      |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                       |
| Files      | Modify: [scripts/scan_project.sh](scripts/scan_project.sh)                                                                                                                                 |
| Symbols    | `json_escape`, `collect_social_links`, `detect_project_identity`, `detect_license`, `detect_git_remote`, `detect_language_stack`, `detect_ci`, `detect_directory_structure`, `output_json` |
| Outcome    | Script runs against any project directory and produces valid JSON identical in structure to today's output. TDD skipped: pure structural refactor with no test suite.                      |

- [ ] **Step 1: Apply change — replace the entire contents of `scripts/scan_project.sh`**

```bash
#!/usr/bin/env bash
# scan_project.sh — Scan a project directory and output JSON metadata for README generation.
# Usage: bash scan_project.sh /path/to/project

set -euo pipefail

PROJECT_DIR="${1:-.}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "Error: '$PROJECT_DIR' is not a directory" >&2
  exit 1
fi

cd "$PROJECT_DIR"

# ---------- global variables ----------

PROJECT_NAME=""
DESCRIPTION=""
LICENSE=""
OWNER=""
REPO=""
PACKAGE_MANAGER=""
CI_PROVIDER=""
CI_WORKFLOWS="[]"
DIR_STRUCTURE=""

# ---------- helpers ----------

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# ---------- detection functions ----------

detect_project_identity() {
  if [[ -f package.json ]]; then
    PROJECT_NAME=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | sed 's/"name"[[:space:]]*:[[:space:]]*"//;s/"$//')
    DESCRIPTION=$(grep -o '"description"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | sed 's/"description"[[:space:]]*:[[:space:]]*"//;s/"$//')
  elif [[ -f Cargo.toml ]]; then
    PROJECT_NAME=$(grep -m1 '^name' Cargo.toml | sed 's/name[[:space:]]*=[[:space:]]*"//;s/"$//')
    DESCRIPTION=$(grep -m1 '^description' Cargo.toml | sed 's/description[[:space:]]*=[[:space:]]*"//;s/"$//')
  elif [[ -f pyproject.toml ]]; then
    PROJECT_NAME=$(grep -m1 '^name' pyproject.toml | sed 's/name[[:space:]]*=[[:space:]]*"//;s/"$//')
    DESCRIPTION=$(grep -m1 '^description' pyproject.toml | sed 's/description[[:space:]]*=[[:space:]]*"//;s/"$//')
  elif [[ -f go.mod ]]; then
    MODULE_PATH=$(grep -m1 '^module' go.mod | sed 's/module[[:space:]]*//; s|//.*$||; s/^[[:space:]]*//; s/[[:space:]]*$//')
    CLEANED_MODULE_PATH=$(printf '%s' "$MODULE_PATH" | sed -E 's@/v[0-9]+$@@')
    PROJECT_NAME=$(basename "$CLEANED_MODULE_PATH")
  fi
  if [[ -z "$PROJECT_NAME" ]]; then
    PROJECT_NAME=$(basename "$PWD")
  fi
}

detect_license() {
  for f in LICENSE LICENSE.md LICENSE.txt; do
    if [[ -f "$f" ]]; then
      LICENSE_CONTENT=$(head -5 "$f")
      if echo "$LICENSE_CONTENT" | grep -qi "MIT"; then LICENSE="MIT"
      elif echo "$LICENSE_CONTENT" | grep -qi "Apache"; then LICENSE="Apache-2.0"
      elif echo "$LICENSE_CONTENT" | grep -qi "GPL"; then LICENSE="GPL"
      elif echo "$LICENSE_CONTENT" | grep -qi "BSD"; then LICENSE="BSD"
      elif echo "$LICENSE_CONTENT" | grep -qi "ISC"; then LICENSE="ISC"
      else LICENSE="Found ($f)"
      fi
      break
    fi
  done
}

detect_git_remote() {
  if [[ -d .git ]] || git rev-parse --git-dir &>/dev/null; then
    REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
    if [[ -n "$REMOTE_URL" ]]; then
      if [[ "$REMOTE_URL" == git@* ]]; then
        OWNER_REPO=$(echo "$REMOTE_URL" | sed 's/.*://;s/\.git$//')
      elif [[ "$REMOTE_URL" == https://* ]] || [[ "$REMOTE_URL" == http://* ]]; then
        OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|https?://[^/]+/||;s/\.git$//')
      else
        OWNER_REPO=""
      fi
      if [[ -n "$OWNER_REPO" ]]; then
        OWNER=$(echo "$OWNER_REPO" | cut -d'/' -f1)
        REPO=$(echo "$OWNER_REPO" | cut -d'/' -f2)
      fi
    fi
  fi
}

detect_language_stack() {
  if [[ -f pnpm-lock.yaml ]]; then PACKAGE_MANAGER="pnpm"
  elif [[ -f yarn.lock ]]; then PACKAGE_MANAGER="yarn"
  elif [[ -f package-lock.json ]]; then PACKAGE_MANAGER="npm"
  elif [[ -f bun.lockb ]] || [[ -f bun.lock ]]; then PACKAGE_MANAGER="bun"
  elif [[ -f Cargo.lock ]]; then PACKAGE_MANAGER="cargo"
  elif [[ -f Pipfile.lock ]]; then PACKAGE_MANAGER="pipenv"
  elif [[ -f poetry.lock ]]; then PACKAGE_MANAGER="poetry"
  elif [[ -f requirements.txt ]]; then PACKAGE_MANAGER="pip"
  elif [[ -f go.sum ]]; then PACKAGE_MANAGER="go"
  elif [[ -f go.mod ]]; then PACKAGE_MANAGER="go"
  elif [[ -f build.gradle ]] || [[ -f build.gradle.kts ]]; then PACKAGE_MANAGER="gradle"
  elif [[ -f deno.json ]] || [[ -f deno.jsonc ]]; then PACKAGE_MANAGER="deno"
  fi
}

detect_ci() {
  if [[ -d .github/workflows ]]; then
    CI_PROVIDER="github-actions"
    WORKFLOWS=$(find .github/workflows -name '*.yml' -o -name '*.yaml' 2>/dev/null | sort)
    CI_WORKFLOWS="["
    FIRST=true
    for wf in $WORKFLOWS; do
      if [[ "$FIRST" == true ]]; then FIRST=false; else CI_WORKFLOWS+=","; fi
      CI_WORKFLOWS+="\"$(json_escape "$(basename "$wf")")\""
    done
    CI_WORKFLOWS+="]"
  elif [[ -f .circleci/config.yml ]]; then CI_PROVIDER="circleci"
  elif [[ -f .travis.yml ]]; then CI_PROVIDER="travis"
  elif [[ -f .gitlab-ci.yml ]]; then CI_PROVIDER="gitlab"
  elif [[ -f Jenkinsfile ]]; then CI_PROVIDER="jenkins"
  fi
}

collect_social_links() {
  local YOUTUBE="" DISCORD="" TWITTER="" LINKEDIN="" BLUESKY="" TWITCH=""
  local SEARCH_FILES=""
  for f in README.md README.rst README readme.md package.json; do
    [[ -f "$f" ]] && SEARCH_FILES+=" $f"
  done
  if [[ -n "$SEARCH_FILES" ]]; then
    YOUTUBE=$(grep -ohiE 'https?://(www\.)?youtube\.com/(@[a-zA-Z0-9_-]+|c/[a-zA-Z0-9_-]+|channel/[a-zA-Z0-9_-]+)' $SEARCH_FILES 2>/dev/null | head -1 || echo "")
    DISCORD=$(grep -ohiE 'https?://(www\.)?discord\.(gg|com/invite)/[a-zA-Z0-9_-]+' $SEARCH_FILES 2>/dev/null | head -1 || echo "")
    TWITTER=$(grep -ohiE 'https?://(www\.)?(twitter\.com|x\.com)/[a-zA-Z0-9_]+' $SEARCH_FILES 2>/dev/null | head -1 || echo "")
    LINKEDIN=$(grep -ohiE 'https?://(www\.)?linkedin\.com/(in|company)/[a-zA-Z0-9_-]+' $SEARCH_FILES 2>/dev/null | head -1 || echo "")
    BLUESKY=$(grep -ohiE 'https?://bsky\.app/profile/[a-zA-Z0-9._-]+' $SEARCH_FILES 2>/dev/null | head -1 || echo "")
    TWITCH=$(grep -ohiE 'https?://(www\.)?twitch\.tv/[a-zA-Z0-9_]+' $SEARCH_FILES 2>/dev/null | head -1 || echo "")
  fi
  if [[ -n "$OWNER" && -n "$REPO" ]]; then
    HOMEPAGE=$(curl -sf --max-time 10 "https://api.github.com/repos/$OWNER/$REPO" 2>/dev/null | grep -o '"homepage"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/"homepage"[[:space:]]*:[[:space:]]*"//;s/"$//' || echo "")
    if [[ -n "$HOMEPAGE" && "$HOMEPAGE" != "null" ]]; then
      HOMEPAGE_CONTENT=$(curl -sf -L --max-time 10 "$HOMEPAGE" 2>/dev/null || echo "")
      if [[ -n "$HOMEPAGE_CONTENT" ]]; then
        [[ -z "$YOUTUBE" ]] && YOUTUBE=$(echo "$HOMEPAGE_CONTENT" | grep -ohiE 'https?://(www\.)?youtube\.com/(@[a-zA-Z0-9_-]+|c/[a-zA-Z0-9_-]+|channel/[a-zA-Z0-9_-]+)' | head -1 || echo "")
        [[ -z "$DISCORD" ]] && DISCORD=$(echo "$HOMEPAGE_CONTENT" | grep -ohiE 'https?://(www\.)?discord\.(gg|com/invite)/[a-zA-Z0-9_-]+' | head -1 || echo "")
        [[ -z "$TWITTER" ]] && TWITTER=$(echo "$HOMEPAGE_CONTENT" | grep -ohiE 'https?://(www\.)?(twitter\.com|x\.com)/[a-zA-Z0-9_]+' | head -1 || echo "")
        [[ -z "$LINKEDIN" ]] && LINKEDIN=$(echo "$HOMEPAGE_CONTENT" | grep -ohiE 'https?://(www\.)?linkedin\.com/(in|company)/[a-zA-Z0-9_-]+' | head -1 || echo "")
        [[ -z "$BLUESKY" ]] && BLUESKY=$(echo "$HOMEPAGE_CONTENT" | grep -ohiE 'https?://bsky\.app/profile/[a-zA-Z0-9._-]+' | head -1 || echo "")
        [[ -z "$TWITCH" ]] && TWITCH=$(echo "$HOMEPAGE_CONTENT" | grep -ohiE 'https?://(www\.)?twitch\.tv/[a-zA-Z0-9_]+' | head -1 || echo "")
      fi
    fi
  fi
  local SOCIAL="{" HAS_ANY=false
  for pair in "youtube:$YOUTUBE" "discord:$DISCORD" "twitter:$TWITTER" "linkedin:$LINKEDIN" "bluesky:$BLUESKY" "twitch:$TWITCH"; do
    local key="${pair%%:*}" val="${pair#*:}"
    if [[ -n "$val" ]]; then
      [[ "$HAS_ANY" == true ]] && SOCIAL+=","
      SOCIAL+="\"$key\":\"$(json_escape "$val")\""
      HAS_ANY=true
    fi
  done
  SOCIAL+="}"
  echo "$SOCIAL"
}

detect_directory_structure() {
  DIR_STRUCTURE=$(while IFS= read -r path; do
    rel_path="${path#./}"
    if [[ -z "$rel_path" || "$rel_path" == "." ]]; then continue; fi
    if [[ -d "$path" ]]; then printf '0\t%s/\n' "$rel_path"
    else printf '1\t%s\n' "$rel_path"
    fi
  done < <(find . -maxdepth 2 \
    -not -path '*/\.*' \
    -not -path './node_modules/*' \
    -not -path './dist/*' \
    -not -path './build/*' \
    -not -path './.next/*' \
    -not -path './target/*' \
    -not -path './__pycache__/*' \
    -not -path './venv/*' \
    -not -path './.venv/*' \
    -not -name '*.pyc') \
    | LC_ALL=C sort -t $'\t' -k1,1 -k2,2 \
    | cut -f2 \
    | head -50 \
    || echo "")
}

output_json() {
  cat <<EOF
{
  "project_name": "$(json_escape "$PROJECT_NAME")",
  "description": "$(json_escape "$DESCRIPTION")",
  "license": "$(json_escape "$LICENSE")",
  "owner": "$(json_escape "$OWNER")",
  "repo": "$(json_escape "$REPO")",
  "package_manager": "$(json_escape "$PACKAGE_MANAGER")",
  "ci": {
    "provider": "$(json_escape "$CI_PROVIDER")",
    "workflows": $CI_WORKFLOWS
  },
  "social_links": $SOCIAL_LINKS,
  "directory_structure": "$(json_escape "$DIR_STRUCTURE")"
}
EOF
}

# ---------- main ----------

detect_project_identity
detect_license
detect_git_remote
detect_language_stack
detect_ci
SOCIAL_LINKS=$(collect_social_links)
detect_directory_structure
output_json
```

- [ ] **Step 2: Verify JSON is valid and contains all original fields**

```bash
cd "$SKILL_DIR"
bash scripts/scan_project.sh "$SKILL_DIR" | python3 -c "
import sys, json
d = json.load(sys.stdin)
required = ['project_name','description','license','owner','repo','package_manager','ci','social_links','directory_structure']
missing = [k for k in required if k not in d]
assert not missing, f'Missing fields: {missing}'
print('PASS — all original fields present')
"
```

Expected: `PASS — all original fields present`

- [ ] **Step 3: Commit**

```bash
cd "$SKILL_DIR"
git add scripts/scan_project.sh
git commit -m "refactor: extract scan_project.sh into named functions"
```

---

### PHASE-002: Extend language stack detection

**Goal:** `detect_language_stack()` recognises PHP/Composer, Ruby/Bundler, .NET, Elixir/Mix, Swift/SPM, sets `PACKAGE_MANAGER` and `FRAMEWORK`, and `output_json` emits a `framework` field.

|                                     Task                                     | Action                           |                            Depends on                             | Files                                              | Validate                           |
| :--------------------------------------------------------------------------: | :------------------------------- | :---------------------------------------------------------------: | :------------------------------------------------- | :--------------------------------- |
| [`TASK-002`](#task-002-add-phprubynetelixi-swift-stacks-and-framework-field) | Add new stacks + framework field | [`TASK-001`](#task-001-rewrite-scan_projectsh-as-named-functions) | [scripts/scan_project.sh](scripts/scan_project.sh) | fixture dirs + `python3 -c` assert |

#### TASK-002: Add PHP/Ruby/.NET/Elixir/Swift stacks and framework field

| Field      | Value                                                                                                                                                                                                        |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-rewrite-scan_projectsh-as-named-functions)                                                                                                                                            |
| Files      | Modify: [scripts/scan_project.sh](scripts/scan_project.sh)                                                                                                                                                   |
| Symbols    | `detect_language_stack`, `detect_project_identity`, `output_json`                                                                                                                                            |
| Outcome    | Script detects composer/bundler/dotnet/mix/spm and Laravel/Rails/Phoenix/ASP.NET frameworks. JSON includes `framework` field. TDD skipped: bash script with no test suite; verified via fixture directories. |

- [ ] **Step 1: Apply change — add global variable, extend three functions**

**1a. Add `FRAMEWORK=""` to the global variables block** (after `PACKAGE_MANAGER=""`):

```bash
PACKAGE_MANAGER=""
FRAMEWORK=""
```

**1b. Replace the entire `detect_language_stack()` function** with this version that adds new stacks and framework detection:

```bash
detect_language_stack() {
  if [[ -f pnpm-lock.yaml ]]; then PACKAGE_MANAGER="pnpm"
  elif [[ -f yarn.lock ]]; then PACKAGE_MANAGER="yarn"
  elif [[ -f package-lock.json ]]; then PACKAGE_MANAGER="npm"
  elif [[ -f bun.lockb ]] || [[ -f bun.lock ]]; then PACKAGE_MANAGER="bun"
  elif [[ -f Cargo.lock ]]; then PACKAGE_MANAGER="cargo"
  elif [[ -f Pipfile.lock ]]; then PACKAGE_MANAGER="pipenv"
  elif [[ -f poetry.lock ]]; then PACKAGE_MANAGER="poetry"
  elif [[ -f requirements.txt ]]; then PACKAGE_MANAGER="pip"
  elif [[ -f go.sum ]]; then PACKAGE_MANAGER="go"
  elif [[ -f go.mod ]]; then PACKAGE_MANAGER="go"
  elif [[ -f build.gradle ]] || [[ -f build.gradle.kts ]]; then PACKAGE_MANAGER="gradle"
  elif [[ -f deno.json ]] || [[ -f deno.jsonc ]]; then PACKAGE_MANAGER="deno"
  elif [[ -f composer.json ]]; then PACKAGE_MANAGER="composer"
  elif [[ -f Gemfile ]]; then PACKAGE_MANAGER="bundler"
  elif ls ./*.sln 2>/dev/null | head -1 | grep -q '.' || ls ./*.csproj 2>/dev/null | head -1 | grep -q '.'; then PACKAGE_MANAGER="dotnet"
  elif [[ -f mix.exs ]]; then PACKAGE_MANAGER="mix"
  elif [[ -f Package.swift ]]; then PACKAGE_MANAGER="spm"
  fi

  case "$PACKAGE_MANAGER" in
    composer)
      if [[ -f artisan ]]; then FRAMEWORK="laravel"
      elif [[ -f symfony.lock ]]; then FRAMEWORK="symfony"
      fi ;;
    bundler)
      if [[ -f config/routes.rb ]]; then FRAMEWORK="rails"
      elif grep -q "require 'sinatra'" Gemfile 2>/dev/null || grep -q 'require "sinatra"' Gemfile 2>/dev/null; then FRAMEWORK="sinatra"
      fi ;;
    dotnet)
      if ls ./*.csproj 2>/dev/null | xargs grep -ql "Microsoft.AspNetCore" 2>/dev/null; then FRAMEWORK="aspnet"; fi ;;
    mix)
      if grep -q ":phoenix" mix.exs 2>/dev/null; then FRAMEWORK="phoenix"; fi ;;
  esac
}
```

**1c. Extend `detect_project_identity()`** — add identity detection for the new stacks. Insert these `elif` branches immediately before the `fi` that closes the main `if/elif` block (the `fi` that precedes the `if [[ -z "$PROJECT_NAME" ]]` fallback):

```bash
  elif [[ -f composer.json ]]; then
    PROJECT_NAME=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' composer.json | head -1 | sed 's/"name"[[:space:]]*:[[:space:]]*"//;s/"$//;s|.*/||')
    DESCRIPTION=$(grep -o '"description"[[:space:]]*:[[:space:]]*"[^"]*"' composer.json | head -1 | sed 's/"description"[[:space:]]*:[[:space:]]*"//;s/"$//')
  elif [[ -f mix.exs ]]; then
    PROJECT_NAME=$(grep -m1 'app:' mix.exs | sed 's/.*app:[[:space:]]*//' | tr -d ',:[:space:]')
  elif [[ -f Package.swift ]]; then
    PROJECT_NAME=$(grep -m1 'name:' Package.swift | sed 's/.*name:[[:space:]]*"//;s/".*//')
```

**1d. Add `framework` to `output_json()`** — insert after the `"package_manager"` line:

```bash
  "package_manager": "$(json_escape "$PACKAGE_MANAGER")",
  "framework": "$(json_escape "$FRAMEWORK")",
```

- [ ] **Step 2: Verify with fixture directories**

```bash
cd "$SKILL_DIR"

# Laravel fixture
mkdir -p /tmp/test-laravel
echo '{"name":"acme/app","description":"A Laravel app","require":{"php":">=8.2","laravel/framework":"^11.0"}}' > /tmp/test-laravel/composer.json
touch /tmp/test-laravel/artisan
bash scripts/scan_project.sh /tmp/test-laravel | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['package_manager']=='composer', d['package_manager']
assert d['framework']=='laravel', d['framework']
print('PASS — Laravel detected')
"

# Rails fixture
mkdir -p /tmp/test-rails/config
echo "source 'https://rubygems.org'" > /tmp/test-rails/Gemfile
touch /tmp/test-rails/config/routes.rb
bash scripts/scan_project.sh /tmp/test-rails | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['package_manager']=='bundler', d['package_manager']
assert d['framework']=='rails', d['framework']
print('PASS — Rails detected')
"

# Elixir/Phoenix fixture
mkdir -p /tmp/test-phoenix
printf 'defmodule MyApp.MixProject do\n  def project do\n    [app: :my_app]\n  end\n  defp deps do\n    [{:phoenix, "~> 1.7"}]\n  end\nend' > /tmp/test-phoenix/mix.exs
bash scripts/scan_project.sh /tmp/test-phoenix | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['package_manager']=='mix', d['package_manager']
assert d['framework']=='phoenix', d['framework']
print('PASS — Phoenix detected')
"

# Swift/SPM fixture
mkdir -p /tmp/test-swift
printf '// swift-tools-version:5.10\nimport PackageDescription\nlet package = Package(name: \"MyLib\")' > /tmp/test-swift/Package.swift
bash scripts/scan_project.sh /tmp/test-swift | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['package_manager']=='spm', d['package_manager']
assert 'framework' in d
print('PASS — Swift/SPM detected')
"

# Cleanup
rm -rf /tmp/test-laravel /tmp/test-rails /tmp/test-phoenix /tmp/test-swift
```

Expected: four `PASS` lines.

- [ ] **Step 3: Commit**

```bash
cd "$SKILL_DIR"
git add scripts/scan_project.sh
git commit -m "feat: add PHP/Ruby/.NET/Elixir/Swift stacks and framework detection"
```

---

### PHASE-003: Add new detection functions

**Goal:** Three new functions — `detect_runtime_version`, `detect_test_framework`, `detect_deploy_target` — are added to the script, called from main, and their output appears in the JSON.

|                        Task                        | Action                       |                                  Depends on                                  | Files                                              | Validate                        |
| :------------------------------------------------: | :--------------------------- | :--------------------------------------------------------------------------: | :------------------------------------------------- | :------------------------------ |
| [`TASK-003`](#task-003-add-detect_runtime_version) | Add `detect_runtime_version` | [`TASK-002`](#task-002-add-phprubynetelixi-swift-stacks-and-framework-field) | [scripts/scan_project.sh](scripts/scan_project.sh) | Node fixture + gemini-assistant |
| [`TASK-004`](#task-004-add-detect_test_framework)  | Add `detect_test_framework`  |              [`TASK-003`](#task-003-add-detect_runtime_version)              | [scripts/scan_project.sh](scripts/scan_project.sh) | Node + Ruby fixtures            |
|  [`TASK-005`](#task-005-add-detect_deploy_target)  | Add `detect_deploy_target`   |              [`TASK-004`](#task-004-add-detect_test_framework)               | [scripts/scan_project.sh](scripts/scan_project.sh) | Docker + Vercel fixtures        |

#### TASK-003: Add detect_runtime_version

| Field      | Value                                                                                                                                                            |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-add-phprubynetelixi-swift-stacks-and-framework-field)                                                                                     |
| Files      | Modify: [scripts/scan_project.sh](scripts/scan_project.sh)                                                                                                       |
| Symbols    | `detect_runtime_version`, `output_json`                                                                                                                          |
| Outcome    | `runtime_version` field present in JSON; correct value read from pin files for Node, Python, Ruby, PHP, .NET, Elixir, Swift, Go, Rust. TDD skipped: bash script. |

- [ ] **Step 1: Apply change — add global variable + new function + wire into main**

**1a. Add `RUNTIME_VERSION=""` to global variables block** (after `FRAMEWORK=""`):

```bash
FRAMEWORK=""
RUNTIME_VERSION=""
```

**1b. Add `detect_runtime_version()` function** after `detect_language_stack()`:

```bash
detect_runtime_version() {
  case "$PACKAGE_MANAGER" in
    npm|pnpm|yarn|bun)
      if [[ -f .nvmrc ]]; then
        RUNTIME_VERSION=$(cat .nvmrc | tr -d '[:space:]')
      elif [[ -f .node-version ]]; then
        RUNTIME_VERSION=$(cat .node-version | tr -d '[:space:]')
      elif [[ -f package.json ]]; then
        RUNTIME_VERSION=$(grep -o '"node"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | sed 's/"node"[[:space:]]*:[[:space:]]*"//;s/"$//' || echo "")
      fi
      ;;
    pip|pipenv|poetry)
      if [[ -f .python-version ]]; then
        RUNTIME_VERSION=$(cat .python-version | tr -d '[:space:]')
      elif [[ -f pyproject.toml ]]; then
        RUNTIME_VERSION=$(grep -m1 'python_requires' pyproject.toml | sed 's/python_requires[[:space:]]*=[[:space:]]*"//;s/".*//' | tr -d '[:space:]' || echo "")
      elif [[ -f setup.cfg ]]; then
        RUNTIME_VERSION=$(grep -m1 'python_requires' setup.cfg | sed 's/python_requires[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]' || echo "")
      fi
      ;;
    bundler)
      if [[ -f .ruby-version ]]; then
        RUNTIME_VERSION=$(cat .ruby-version | tr -d '[:space:]')
      elif [[ -f Gemfile ]]; then
        RUNTIME_VERSION=$(grep -m1 '^ruby ' Gemfile | sed "s/ruby[[:space:]]*//" | tr -d "'\"\`" | tr -d '[:space:]' || echo "")
      fi
      ;;
    composer)
      RUNTIME_VERSION=$(grep -o '"php"[[:space:]]*:[[:space:]]*"[^"]*"' composer.json 2>/dev/null | head -1 | sed 's/"php"[[:space:]]*:[[:space:]]*"//;s/"$//' || echo "")
      ;;
    dotnet)
      local csproj
      csproj=$(ls ./*.csproj 2>/dev/null | head -1 || echo "")
      if [[ -n "$csproj" ]]; then
        RUNTIME_VERSION=$(grep -m1 '<TargetFramework>' "$csproj" | sed 's/.*<TargetFramework>//;s/<\/TargetFramework>.*//' | tr -d '[:space:]' || echo "")
      fi
      ;;
    mix)
      if [[ -f .tool-versions ]]; then
        RUNTIME_VERSION=$(grep '^elixir' .tool-versions | sed 's/elixir[[:space:]]*//' | tr -d '[:space:]' || echo "")
      elif [[ -f mix.exs ]]; then
        RUNTIME_VERSION=$(grep -m1 'elixir:' mix.exs | sed 's/.*elixir:[[:space:]]*//' | tr -d '"[:space:],' | sed 's/^/>= /' || echo "")
      fi
      ;;
    spm)
      RUNTIME_VERSION=$(grep -m1 'swift-tools-version:' Package.swift | sed 's|.*swift-tools-version:||' | tr -d '[:space:]' || echo "")
      ;;
    go)
      RUNTIME_VERSION=$(grep -m1 '^go ' go.mod | sed 's/go[[:space:]]*//' | tr -d '[:space:]' || echo "")
      ;;
    cargo)
      if [[ -f rust-toolchain.toml ]]; then
        RUNTIME_VERSION=$(grep -m1 'channel' rust-toolchain.toml | sed 's/channel[[:space:]]*=[[:space:]]*"//;s/".*//' | tr -d '[:space:]' || echo "")
      elif [[ -f Cargo.toml ]]; then
        RUNTIME_VERSION=$(grep -m1 'rust-version' Cargo.toml | sed 's/rust-version[[:space:]]*=[[:space:]]*"//;s/".*//' | tr -d '[:space:]' || echo "")
      fi
      ;;
  esac
}
```

**1c. Add `runtime_version` to `output_json()`** after the `framework` line:

```bash
  "framework": "$(json_escape "$FRAMEWORK")",
  "runtime_version": "$(json_escape "$RUNTIME_VERSION")",
```

**1d. Add `detect_runtime_version` to the main call sequence** after `detect_language_stack`:

```bash
detect_language_stack
detect_runtime_version
```

- [ ] **Step 2: Verify**

```bash
cd "$SKILL_DIR"

# Node fixture with .nvmrc
mkdir -p /tmp/test-node
echo '{"name":"myapp","dependencies":{}}' > /tmp/test-node/package.json
touch /tmp/test-node/package-lock.json
echo "20.11.0" > /tmp/test-node/.nvmrc
bash scripts/scan_project.sh /tmp/test-node | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['runtime_version']=='20.11.0', d.get('runtime_version')
print('PASS — Node .nvmrc detected')
"

# PHP fixture with composer.json php requirement
mkdir -p /tmp/test-php
echo '{"name":"acme/app","require":{"php":">=8.2"}}' > /tmp/test-php/composer.json
bash scripts/scan_project.sh /tmp/test-php | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['runtime_version']=='>=8.2', d.get('runtime_version')
print('PASS — PHP runtime version detected')
"

# gemini-assistant (real Node project — engines.node or no version pin)
bash scripts/scan_project.sh c:/gemini-assistant | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert 'runtime_version' in d
print('PASS — runtime_version field present on real project, value:', d['runtime_version'])
"

rm -rf /tmp/test-node /tmp/test-php
```

Expected: three `PASS` lines.

- [ ] **Step 3: Commit**

```bash
cd "$SKILL_DIR"
git add scripts/scan_project.sh
git commit -m "feat: add detect_runtime_version to scan_project.sh"
```

---

#### TASK-004: Add detect_test_framework

| Field      | Value                                                                                                                                                                                                                                             |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | [`TASK-003`](#task-003-add-detect_runtime_version)                                                                                                                                                                                                |
| Files      | Modify: [scripts/scan_project.sh](scripts/scan_project.sh)                                                                                                                                                                                        |
| Symbols    | `detect_test_framework`, `output_json`                                                                                                                                                                                                            |
| Outcome    | `test_framework` field present in JSON with correct value for Node (jest/vitest/mocha/ava/jasmine), Python (pytest), Ruby (rspec/minitest), PHP (phpunit), .NET (xunit/nunit/mstest), Go/Rust/Elixir/Swift (`builtin`). TDD skipped: bash script. |

- [ ] **Step 1: Apply change — add global variable + new function + wire into main**

**1a. Add `TEST_FRAMEWORK=""` to global variables block** (after `RUNTIME_VERSION=""`):

```bash
RUNTIME_VERSION=""
TEST_FRAMEWORK=""
```

**1b. Add `detect_test_framework()` function** after `detect_runtime_version()`:

```bash
detect_test_framework() {
  case "$PACKAGE_MANAGER" in
    npm|pnpm|yarn|bun)
      local dev_deps
      dev_deps=$(grep -o '"devDependencies"[[:space:]]*:[[:space:]]*{[^}]*}' package.json 2>/dev/null || echo "")
      for fw in jest vitest mocha ava jasmine; do
        if echo "$dev_deps" | grep -q "\"$fw\""; then
          TEST_FRAMEWORK="$fw"
          break
        fi
      done
      ;;
    pip|pipenv|poetry)
      if [[ -f pytest.ini ]] || [[ -f conftest.py ]]; then
        TEST_FRAMEWORK="pytest"
      elif [[ -f pyproject.toml ]] && grep -q '\[tool\.pytest' pyproject.toml 2>/dev/null; then
        TEST_FRAMEWORK="pytest"
      fi
      ;;
    bundler)
      if [[ -d spec ]]; then TEST_FRAMEWORK="rspec"
      elif [[ -d test ]]; then TEST_FRAMEWORK="minitest"
      fi
      ;;
    composer)
      if [[ -f phpunit.xml ]] || [[ -f phpunit.xml.dist ]]; then
        TEST_FRAMEWORK="phpunit"
      elif grep -q '"phpunit/phpunit"' composer.json 2>/dev/null; then
        TEST_FRAMEWORK="phpunit"
      fi
      ;;
    dotnet)
      local csproj
      csproj=$(ls ./*.csproj 2>/dev/null | head -1 || echo "")
      if [[ -n "$csproj" ]]; then
        if grep -qi "xunit" "$csproj" 2>/dev/null; then TEST_FRAMEWORK="xunit"
        elif grep -qi "nunit" "$csproj" 2>/dev/null; then TEST_FRAMEWORK="nunit"
        elif grep -qi "mstest" "$csproj" 2>/dev/null; then TEST_FRAMEWORK="mstest"
        fi
      fi
      ;;
    go|cargo|mix|spm)
      TEST_FRAMEWORK="builtin"
      ;;
  esac
}
```

**1c. Add `test_framework` to `output_json()`** after `runtime_version`:

```bash
  "runtime_version": "$(json_escape "$RUNTIME_VERSION")",
  "test_framework": "$(json_escape "$TEST_FRAMEWORK")",
```

**1d. Add `detect_test_framework` to the main call sequence** after `detect_runtime_version`:

```bash
detect_runtime_version
detect_test_framework
```

- [ ] **Step 2: Verify**

```bash
cd "$SKILL_DIR"

# Node/vitest fixture
mkdir -p /tmp/test-vitest
echo '{"name":"myapp","devDependencies":{"vitest":"^1.0.0","typescript":"^5.0.0"}}' > /tmp/test-vitest/package.json
touch /tmp/test-vitest/package-lock.json
bash scripts/scan_project.sh /tmp/test-vitest | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['test_framework']=='vitest', d.get('test_framework')
print('PASS — vitest detected')
"

# Ruby/RSpec fixture
mkdir -p /tmp/test-rspec/spec
echo "source 'https://rubygems.org'" > /tmp/test-rspec/Gemfile
bash scripts/scan_project.sh /tmp/test-rspec | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['test_framework']=='rspec', d.get('test_framework')
print('PASS — rspec detected')
"

# Go fixture (builtin)
mkdir -p /tmp/test-go
printf 'module github.com/acme/myapp\n\ngo 1.22\n' > /tmp/test-go/go.mod
touch /tmp/test-go/go.sum
bash scripts/scan_project.sh /tmp/test-go | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['test_framework']=='builtin', d.get('test_framework')
print('PASS — Go builtin detected')
"

rm -rf /tmp/test-vitest /tmp/test-rspec /tmp/test-go
```

Expected: three `PASS` lines.

- [ ] **Step 3: Commit**

```bash
cd "$SKILL_DIR"
git add scripts/scan_project.sh
git commit -m "feat: add detect_test_framework to scan_project.sh"
```

---

#### TASK-005: Add detect_deploy_target

| Field      | Value                                                                                                                                                           |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-004`](#task-004-add-detect_test_framework)                                                                                                               |
| Files      | Modify: [scripts/scan_project.sh](scripts/scan_project.sh)                                                                                                      |
| Symbols    | `detect_deploy_target`, `output_json`                                                                                                                           |
| Outcome    | `deploy_target` field present in JSON; first-match detection covers vercel/fly/railway/render/netlify/heroku/docker/aws/github-pages. TDD skipped: bash script. |

- [ ] **Step 1: Apply change — add global variable + new function + wire into main**

**1a. Add `DEPLOY_TARGET=""` to global variables block** (after `TEST_FRAMEWORK=""`):

```bash
TEST_FRAMEWORK=""
DEPLOY_TARGET=""
```

**1b. Add `detect_deploy_target()` function** after `detect_test_framework()`:

```bash
detect_deploy_target() {
  if [[ -f vercel.json ]] || [[ -d .vercel ]]; then DEPLOY_TARGET="vercel"
  elif [[ -f fly.toml ]]; then DEPLOY_TARGET="fly"
  elif [[ -f railway.toml ]] || [[ -f railway.json ]]; then DEPLOY_TARGET="railway"
  elif [[ -f render.yaml ]]; then DEPLOY_TARGET="render"
  elif [[ -f netlify.toml ]]; then DEPLOY_TARGET="netlify"
  elif [[ -f Procfile ]]; then DEPLOY_TARGET="heroku"
  elif [[ -f Dockerfile ]] || [[ -f docker-compose.yml ]] || [[ -f docker-compose.yaml ]]; then DEPLOY_TARGET="docker"
  elif [[ -f serverless.yml ]] || [[ -f cdk.json ]]; then DEPLOY_TARGET="aws"
  elif [[ -d .github/workflows ]] && grep -rl "pages" .github/workflows/ &>/dev/null; then DEPLOY_TARGET="github-pages"
  fi
}
```

**1c. Add `deploy_target` to `output_json()`** after `test_framework`:

```bash
  "test_framework": "$(json_escape "$TEST_FRAMEWORK")",
  "deploy_target": "$(json_escape "$DEPLOY_TARGET")",
```

**1d. Add `detect_deploy_target` to the main call sequence** after `detect_test_framework`:

```bash
detect_test_framework
detect_deploy_target
```

- [ ] **Step 2: Verify**

```bash
cd "$SKILL_DIR"

# Docker fixture
mkdir -p /tmp/test-docker
touch /tmp/test-docker/Dockerfile
echo '{"name":"myapp"}' > /tmp/test-docker/package.json
touch /tmp/test-docker/package-lock.json
bash scripts/scan_project.sh /tmp/test-docker | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['deploy_target']=='docker', d.get('deploy_target')
print('PASS — docker detected')
"

# Vercel wins over Docker (priority check)
mkdir -p /tmp/test-vercel
touch /tmp/test-vercel/vercel.json /tmp/test-vercel/Dockerfile
echo '{"name":"myapp"}' > /tmp/test-vercel/package.json
touch /tmp/test-vercel/package-lock.json
bash scripts/scan_project.sh /tmp/test-vercel | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['deploy_target']=='vercel', d.get('deploy_target')
print('PASS — vercel wins priority over docker')
"

# No deploy files — field is empty string
mkdir -p /tmp/test-nodeploy
echo '{"name":"myapp"}' > /tmp/test-nodeploy/package.json
touch /tmp/test-nodeploy/package-lock.json
bash scripts/scan_project.sh /tmp/test-nodeploy | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['deploy_target']=='', d.get('deploy_target')
print('PASS — empty string when no deploy target found')
"

rm -rf /tmp/test-docker /tmp/test-vercel /tmp/test-nodeploy
```

Expected: three `PASS` lines.

- [ ] **Step 3: Commit**

```bash
cd "$SKILL_DIR"
git add scripts/scan_project.sh
git commit -m "feat: add detect_deploy_target to scan_project.sh"
```

---

### PHASE-004: Update SKILL.md

**Goal:** Steps 1, 3, 4, and 6 of the workflow reference `framework`, `runtime_version`, `test_framework`, and `deploy_target`.

|                         Task                         | Action                     |                    Depends on                    | Files                | Validate      |
| :--------------------------------------------------: | :------------------------- | :----------------------------------------------: | :------------------- | :------------ |
| [`TASK-006`](#task-006-update-skillmd-steps-1-3-4-6) | Update four workflow steps | [`TASK-005`](#task-005-add-detect_deploy_target) | [SKILL.md](SKILL.md) | `grep` checks |

#### TASK-006: Update SKILL.md Steps 1, 3, 4, 6

| Field      | Value                                                                                           |
| :--------- | :---------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-005`](#task-005-add-detect_deploy_target)                                                |
| Files      | Modify: [SKILL.md](SKILL.md)                                                                    |
| Symbols    | Step 1 scan table, Step 3 optional sections table, Step 4 badge table, Step 6 validation table  |
| Outcome    | All four new JSON fields are referenced in the SKILL.md workflow. TDD skipped: doc-only change. |

- [ ] **Step 1: Apply change — four targeted edits to `SKILL.md`**

**Edit 1 — Step 1 scan table:** Find the line `| Social links | Connect section badges |` and insert three rows after it:

```markdown
| Runtime version | Prerequisites section + runtime version badge |
| Test framework | Quick Start test command row |
| Deploy target | Deploy badge in hero; Deploy section when non-Docker |
```

**Edit 2 — Step 3 optional sections table:** Find the line `| Acknowledgments  | There are inspirations, libraries, mentors, or sponsors worth crediting       |` and insert one row after it:

```markdown
| Deploy | `deploy_target` is set and is not `"docker"` (Docker gets a badge only) |
```

**Edit 3 — Step 3 Quick Start guidance:** Find the line starting `**Adapt — do not copy blindly.**` and insert this block before it:

```markdown
> When `test_framework` is set, always include a test command row in the Quick Start table. For `"builtin"` values (Go, Rust, Elixir, Swift), use the canonical command: `go test ./...`, `cargo test`, `mix test`, `swift test`.
```

**Edit 4 — Step 4 badge table:** Find the line `|`quality`| codecov, codeql, prettier            |` and insert two rows after it:

```markdown
| `runtime` | node version, python version, go version, rust version |
| `deploy` | vercel, fly, railway, render, netlify, heroku, docker |
```

**Edit 5 — Step 6 validation table:** Find the line `| Tone                    | Concise, direct, no marketing fluff                |` and insert two rows after it:

```markdown
| Runtime version | Prerequisites section present when `runtime_version` is non-empty |
| Test command | Quick Start includes test row when `test_framework` is non-empty |
```

- [ ] **Step 2: Verify all new content is present**

```bash
cd "$SKILL_DIR"
python3 -c "
content = open('SKILL.md').read()
checks = [
  ('Runtime version row in Step 1', 'Runtime version'),
  ('Test framework row in Step 1', 'Test framework'),
  ('Deploy target row in Step 1', 'Deploy target'),
  ('Deploy optional section', 'deploy_target'),
  ('Quick Start test guidance', 'test_framework'),
  ('Runtime badge category', '| \`runtime\`'),
  ('Deploy badge category', '| \`deploy\`'),
  ('Runtime validation check', 'runtime_version'),
  ('Test command validation check', 'test_framework'),
]
for label, needle in checks:
  assert needle in content, f'MISSING: {label} ({needle!r})'
  print(f'PASS — {label}')
"
```

Expected: nine `PASS` lines.

- [ ] **Step 3: Commit**

```bash
cd "$SKILL_DIR"
git add SKILL.md
git commit -m "docs: update SKILL.md Steps 1/3/4/6 for new scan fields"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Full JSON output is valid and contains all fields

```bash
cd "$SKILL_DIR"
bash scripts/scan_project.sh c:/gemini-assistant | python3 -c "
import sys,json
d = json.load(sys.stdin)
required = [
  'project_name','description','license','owner','repo',
  'package_manager','framework','runtime_version','test_framework',
  'deploy_target','ci','social_links','directory_structure'
]
missing = [k for k in required if k not in d]
assert not missing, f'Missing: {missing}'
print('PASS — all 13 fields present')
for k in required:
  print(f'  {k}: {repr(d[k])!s:.60}')
"
```

### [`VAL-002`](#5-testing--validation) — Multi-stack fixture sweep

```bash
cd "$SKILL_DIR"

declare -A FIXTURES=(
  [npm]='{"name":"n","devDependencies":{"jest":"1"}}'
  [composer]='{"name":"a/b","require":{"php":">=8.1"}}'
)

# npm+jest
mkdir -p /tmp/val-npm && echo "${FIXTURES[npm]}" > /tmp/val-npm/package.json && touch /tmp/val-npm/package-lock.json
bash scripts/scan_project.sh /tmp/val-npm | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['test_framework']=='jest'; print('PASS npm+jest')"

# composer
mkdir -p /tmp/val-php && echo "${FIXTURES[composer]}" > /tmp/val-php/composer.json
bash scripts/scan_project.sh /tmp/val-php | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['package_manager']=='composer'; assert d['runtime_version']=='>=8.1'; print('PASS php+runtime')"

rm -rf /tmp/val-npm /tmp/val-php
```

### [`VAL-003`](#5-testing--validation) — SKILL.md contains all required new content

```bash
cd "$SKILL_DIR"
grep -c "runtime_version\|test_framework\|deploy_target" SKILL.md
```

Expected: at least `5` (each field appears multiple times).

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                            |
| :--------------------------------: | :------------------------------------------------------------------------------------------------------------ |
| [`AC-001`](#6-acceptance-criteria) | `bash scripts/scan_project.sh c:/gemini-assistant` exits 0 and outputs valid JSON with 13 top-level keys.     |
| [`AC-002`](#6-acceptance-criteria) | Running against a Laravel project returns `package_manager=composer`, `framework=laravel`.                    |
| [`AC-003`](#6-acceptance-criteria) | Running against a Node project with `.nvmrc` returns the version string in `runtime_version`.                 |
| [`AC-004`](#6-acceptance-criteria) | Running against a project with `vitest` in `devDependencies` returns `test_framework=vitest`.                 |
| [`AC-005`](#6-acceptance-criteria) | Running against a project with `Dockerfile` returns `deploy_target=docker`.                                   |
| [`AC-006`](#6-acceptance-criteria) | Running against a project with both `vercel.json` and `Dockerfile` returns `deploy_target=vercel` (priority). |
| [`AC-007`](#6-acceptance-criteria) | `SKILL.md` Step 6 validation table contains rows for `runtime_version` and `test_framework`.                  |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                     |
| :---------------------------: | :--: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------- |
| [`NOTE-001`](#7-risks--notes) | Note | Set `SKILL_DIR=C:/Users/PC/.claude/skills/readme-wizard` before running any plan commands. All `bash scripts/scan_project.sh` calls must be run from `$SKILL_DIR`.                                                                                                         |
| [`NOTE-002`](#7-risks--notes) | Note | The skill directory may not be a git repo. Run `git -C "$SKILL_DIR" rev-parse --git-dir 2>/dev/null && echo yes                                                                                                                                                            |     | echo no`to check. If the result is`no`, skip all`git add`/`git commit` steps. |
| [`NOTE-003`](#7-risks--notes) | Note | `detect_test_framework` for npm/pnpm/yarn/bun uses `grep` to extract the `devDependencies` block and scans for framework names inside it. This relies on `devDependencies` fitting on a single `{...}` block — true for well-formed package.json but not for multi-line formatted files. If a project's package.json has `devDependencies` spanning multiple lines, the grep regex will miss it; in that case the field will be empty string (safe no-op). |
| [`RISK-001`](#7-risks--notes) | Risk | `.csproj` glob (`ls ./*.csproj`) will fail silently on `set -e` if no `.csproj` exists. Both `detect_runtime_version` and `detect_language_stack` guard this with `ls ... 2>/dev/null \| head -1 \| grep -q '.'` — do not remove the `2>/dev/null`.                        |
| [`RISK-002`](#7-risks--notes) | Risk | `TASK-006` Edit 3 inserts a blank-line-terminated block before `**Adapt — do not copy blindly.**`. If that exact string is not in SKILL.md, the edit will fail to find the insertion point. Verify with `grep -n "Adapt" SKILL.md` before editing.                         |
