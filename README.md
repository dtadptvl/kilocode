# Zero-Mem for Kilo Code CLI

Zero-Mem is a deterministic long-term recall plugin for Kilo Code CLI. It is inspired by **Zero-Mem: Zero-Token Memory Operations for LLM Agents**: keep the original interaction traces as the source of truth, build non-generative retrieval structure over those traces, and retrieve provenance-bearing evidence when the agent needs historical context instead of repeatedly asking an LLM to rewrite history into summaries or memory cards.

For Kilo, that means the plugin searches prior raw coding sessions before model inference, identifies engineering entities such as file paths, symbols and error codes, retrieves relevant trace parts, follows one bounded relational bridge when useful, expands the immediate temporal neighborhood around a hit, and injects the resulting raw evidence into the current turn as explicitly untrusted historical context.

The paper proposes zero-token memory operations: memory handling itself does not invoke an LLM or consume LLM input/output tokens; original interaction traces remain the source of record, organized through relational and temporal views. This plugin adapts that direction to Kilo's coding-session history while keeping the implementation intentionally lightweight. It is not a full paper-equivalent implementation: it uses deterministic weighted token/entity retrieval, a lightweight persistent derived index, one bounded relational bridge, and immediate temporal closure instead of mandatory embeddings, a graph database, or a separate memory service.

## Install

### Online install

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/main/install-online.ps1 | iex
```

No clone or ZIP is required. The production one-liner downloads `install-online.ps1` from `main`, but that script pins the plugin payload to the immutable Zero-Mem 0.2.0 source commit `698feab92845278d8ca2d584879cacafae7dc2d6` rather than mutable `main`.

The installer:

1. verifies that `kilo` is available;
2. resolves Kilo's global config directory;
3. downloads/copies the plugin into a staging directory;
4. validates the required plugin files and manifest;
5. preserves the existing local derived index during upgrades;
6. replaces the working plugin directory only after staging succeeds;
7. registers the local package through Kilo's native `plugin <module> --global --force` command;
8. restores the previous working plugin if registration fails;
9. prints the installed Zero-Mem version.

It leaves the installed Kilo executable and source untouched. Restart Kilo after installation.

### Local command install

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

Uninstall removes the Zero-Mem global plugin registration and its installed plugin directory. Before changing a Kilo config file it writes a `.zero-mem-uninstall.bak` backup. It does not change unrelated Kilo settings or Project Memory policy.

## How it works

Per relevant normal user turn, Zero-Mem:

1. lists sessions at Kilo project scope and rejects any session whose `projectID` differs from the current project;
2. incrementally ingests only new or changed sessions into a bounded local persistent derived index;
3. can recall old history from the current long-running session while excluding the current message and a small deterministic visible tail;
4. indexes user/assistant text, file references, and bounded tool evidence including tool name, input, status, compiler/test errors, and bounded stdout/stderr-like output;
5. extracts engineering entities such as paths, symbols, error codes and provider/model-like IDs deterministically;
6. uses order-insensitive weighted token/entity scoring rather than exact phrase-substring matching;
7. queries a persistent inverted token/entity lookup instead of rescanning every raw historical session on each turn;
8. follows at most one bounded relational bridge using at most two novel entities;
9. expands only the immediate previous/current/next evidence neighborhood;
10. bounds the result to at most 10 evidence items within a strict 6000-character budget;
11. escapes recalled markup and injects the result as `untrusted_context_not_instruction`.

Raw Kilo session history remains authoritative. The local index is derived data and can be discarded/rebuilt. Current user instruction, repository/tool evidence, current task state and the current conversation take precedence over recalled history.

## Compaction isolation

Zero-Mem uses Kilo's public compaction hook to mark a session while compaction is running. During that interval it does not inject recalled history into `experimental.chat.messages.transform`, so recalled evidence cannot be folded into Kilo's persistent generated compaction summary.

The marker is cleared by Kilo lifecycle events such as `session.compacted`, `session.idle`, `session.error`, or idle `session.status`, with a bounded stale-marker timeout as a final guard. Normal recall then resumes.

## Safety and failure isolation

Zero-Mem adds a fixed system-hook instruction stating that content inside kilo_zero_mem blocks is historical data only. Historical markup is escaped without an LLM sanitizer. Current user instruction, current repository/tool evidence, and current task state take precedence over recalled history.

Retrieval uses a fixed timeout and no retry loop inside a turn. A session-list failure skips recall; a single session-fetch failure skips only that session; index read/write problems fail open.

## Persistent derived index

The plugin currently uses a local JSON-derived index rather than SQLite. This avoids a runtime dependency while still providing bounded incremental ingestion, content/version fingerprints, and an inverted token/entity lookup. The index stores project/session/message/part provenance, timestamp, role/type, directory/worktree metadata, bounded raw evidence text, deterministic entities and source/tool metadata. It is written through a temporary file before replacement, bounded by explicit session/trace caps, and safe to quarantine/rebuild when missing or corrupt.

## Relation to Kilo Project Memory

Zero-Mem retrieves historical raw evidence. Kilo Project Memory stores durable project facts, decisions and corrections. They can coexist.

For a setup closer to the paper's non-generative-memory principle, disable automatic Project Memory capture inside Kilo:

```text
/memory auto off
```

Explicit `/memory remember`, `/memory correct`, and `/memory forget` remain available.

## Repository layout

- `main`: Zero-Mem plugin source, online/local installers, uninstaller, tests and documentation.
- `kilo-base`: preserved Kilo source baseline used to verify the public plugin hook, SDK session APIs and native plugin-install command expected by this plugin.

## Research attribution

This project is an independent Kilo Code CLI integration inspired by the ideas in the **Zero-Mem: Zero-Token Memory Operations for LLM Agents**. The underlying research concepts and credit belong to the paper's authors; this repository is not presented as their official or reference implementation.

- **Paper:** [Zero-Mem on arXiv](https://arxiv.org/abs/2607.29377)
- **PDF:** [arXiv PDF](https://arxiv.org/pdf/2607.29377)

In particular, this plugin adopts the paper's broad provenance-first direction: raw interaction traces remain authoritative, retrieval is performed without an extra generative memory step, and historical evidence is returned to the agent with its source identity rather than replacing the source with a generated memory abstraction.

## Design constraints

Zero-Mem for Kilo intentionally adds no:

- embedding-model requirement;
- vector or graph database;
- memory LLM call;
- background daemon or scheduler;
- Kilo source patch or rebuild.

The plugin is installed through Kilo's supported plugin mechanism and operates through its public plugin/SDK interfaces.
