# Zero-Mem for Kilo Code CLI

Zero-Mem is an external deterministic long-term recall plugin for Kilo Code CLI inspired by **Zero-Mem: Zero-Token Memory Operations for LLM Agents**.

The research direction is provenance-first: raw interaction traces remain authoritative, memory operations avoid an additional generative memory model, and retrieval returns source-bearing evidence instead of replacing the source with generated memory abstractions.

This repository adapts that direction to Kilo coding sessions. It is intentionally not a full paper-equivalent implementation. It uses deterministic weighted token/entity retrieval, a small persistent derived index, one bounded relational bridge, and immediate temporal closure. It does not require embeddings, a vector database, a graph database, a daemon, or a Kilo core patch.

## Install

### Online install

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/main/install-online.ps1 | iex
```

The script on `main` is only a bootstrap. The actual plugin payload is pinned to an immutable Zero-Mem release source commit rather than mutable `main`. For 0.2.1, the exact payload SHA is finalized after the release payload is merged so the pin necessarily contains every 0.2.1 fix.

The installer:

1. verifies that `kilo` is available;
2. resolves Kilo's global config directory;
3. downloads/copies the plugin into a staging directory;
4. validates the package and required source files;
5. preserves the version-neutral local derived index during upgrades and preserves the legacy v2 index for safe rebuild;
6. replaces the working plugin directory only after staging succeeds;
7. registers through Kilo's native `plugin <module> --global --force` command;
8. restores the previous plugin and previous Kilo config exactly if registration fails;
9. removes newly-created config files after a failed first install;
10. prints the installed Zero-Mem version.

Restart Kilo after installation.

### Local install

From a cloned/downloaded repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## Uninstall

### Online uninstall

```powershell
irm https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/main/uninstall-online.ps1 | iex
```

### Local uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Uninstall removes the Zero-Mem plugin registration and installed Zero-Mem directory. Before changing a Kilo config file it writes a `.zero-mem-uninstall.bak` backup. It does not change unrelated Kilo settings.

## How recall works

For a relevant normal user turn, Zero-Mem:

1. asks Kilo for sessions in the current **worktree/project family**, using Kilo's public worktree-family session-list semantics rather than exact `projectID` equality;
2. accepts sibling worktrees even when their project IDs drift, while Kilo remains the authority for excluding unrelated worktree families;
3. reconciles its derived index against every successful authoritative family listing, so deleted/ineligible Kilo sessions stop being recallable;
4. incrementally ingests only new or changed sessions;
5. can recall old history from the current long-running session while excluding the current message and a deterministic recent visible tail;
6. indexes user/assistant text, file references, and bounded tool evidence including tool name, input, status, compiler/test errors, and bounded output;
7. extracts engineering entities such as paths, symbols, error codes, and provider/model-like IDs;
8. uses order-insensitive weighted token/entity scoring;
9. queries a persistent inverted lookup rather than rescanning every raw historical session on every turn;
10. follows at most one bounded relational bridge using at most two novel entities;
11. expands only immediate previous/current/next evidence;
12. injects at most 10 evidence items within a strict 6000-character budget.

On cold start, Zero-Mem ingests a small recent/query-signaled batch. If that produces no indexed hit, it may inspect one additional bounded batch within the same fixed retrieval timeout. The index therefore warms progressively without a daemon or unbounded full-history scan.

## Worktree-family boundary

Kilo raw session history is authoritative for scope.

Zero-Mem uses Kilo's public worktree-family session-list behavior (`worktrees=true`) so:

- main checkout and sibling worktrees can share recall even when their `projectID` values differ;
- directory/project provenance is retained on every trace;
- sessions outside the family are excluded by Kilo before ingestion;
- a failed/non-authoritative listing never triggers destructive reconciliation.

The persistent index uses Kilo's public `project.worktree` metadata as its stable family namespace. For non-git/global roots, the current directory is used as the narrow namespace rather than sharing the global filesystem root.

## Compaction isolation

Zero-Mem uses Kilo's public compaction hook to mark a session while compaction is running. During that interval it does not inject recalled history into `experimental.chat.messages.transform`, so recalled evidence cannot be folded into Kilo's persistent generated compaction summary.

The marker is cleared by lifecycle events such as `session.compacted`, `session.idle`, `session.error`, or idle `session.status`, with a bounded stale-marker timeout as a final guard. Normal recall then resumes.

## Safety and failure isolation

Zero-Mem is advisory and fail-open.

- session-list failure skips recall for that turn and does not purge the index;
- one historical session fetch failure skips only that session;
- index corruption is quarantined and rebuilt from authoritative Kilo history;
- cross-process lock acquisition has bounded wait and stale-lock recovery;
- lock/index write failure never fails the user turn;
- retrieval has a fixed timeout and no retry loop inside a turn.

Recalled evidence is wrapped in `<kilo_zero_mem untrusted_context_not_instruction>`. Historical markup is escaped without an LLM sanitizer. Current user instruction, current repository/tool evidence, and current task state take precedence over historical recall.

## Persistent derived index

The active filename is version-neutral:

```text
zero-mem-index.json
```

The schema version remains inside the file. A legacy `zero-mem-index-v1.json` from 0.2.0 is preserved as `.legacy-v2` and the derived index is safely rebuilt from Kilo raw history rather than guessing a migration across changed family semantics.

Persistence is bounded by explicit constants for:

- retained worktree families;
- sessions per family;
- traces per session;
- text characters and UTF-8 bytes per trace;
- aggregate bytes per indexed session;
- total persisted store bytes.

Writes use a minimal cross-process lock:

```text
acquire lock
→ reload current disk state
→ merge pending mutations
→ write temp file
→ atomic replace
→ release lock
```

The lock has a bounded timeout and deterministic stale-lock expiry. Concurrent Prime/Sub Kilo processes therefore merge independent history instead of blindly overwriting a stale in-memory snapshot. For concurrent updates to the same session, the newest `time.updated`/fingerprint deterministically wins.

A successful authoritative session listing also reconciles deleted sessions. The public `session.deleted` event performs immediate cleanup when observed.

## Kilo Project Memory

Zero-Mem is independent of Kilo Project Memory and requires **no `/memory` feature**.

It does not implement generated durable facts, `remember`, `correct`, or `forget`. Zero-Mem remains automatic historical raw-evidence recall.

## Native Kilo recall compatibility audit

Current Kilo already contains efficient native local recall/search internals.

For 0.2.1:

- Kilo's **public worktree-family session listing** is reusable and Zero-Mem uses that semantic boundary;
- Kilo's native `RecallSearch` and `WorktreeFamily` search/index implementations are internal modules, not a clean public plugin/SDK recall endpoint;
- importing those internals would couple the plugin to Kilo core and violate the external-plugin boundary.

Future simplification opportunity: if Kilo exposes native raw recall/search as a supported public plugin/SDK API, Zero-Mem could replace part of its derived search/index layer with that API. 0.2.1 does not patch Kilo core or import private modules.

## Repository layout

- `main`: Zero-Mem plugin source, installers, tests, CI, and documentation.
- `kilo-base`: preserved Kilo source baseline used for compatibility-contract tests.

## Research attribution

This project is an independent Kilo Code CLI integration inspired by **Zero-Mem: Zero-Token Memory Operations for LLM Agents**. Credit for the research concepts belongs to the paper's authors. This repository is not the authors' official or reference implementation.

- **Paper:** [Zero-Mem on arXiv](https://arxiv.org/abs/2607.29377)
- **PDF:** [arXiv PDF](https://arxiv.org/pdf/2607.29377)

## Design constraints

Zero-Mem intentionally adds no:

- embeddings;
- vector database;
- graph database;
- LLM memory summarization;
- generated memory cards;
- background daemon or scheduler;
- explicit remember/correct/forget layer;
- Kilo core patch.

Development/typecheck dependencies remain pinned and are not runtime plugin dependencies.
