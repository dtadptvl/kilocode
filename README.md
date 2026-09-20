# Zero-Mem for Kilo Code CLI

Zero-Mem is a deterministic long-term recall plugin for Kilo Code CLI. It is inspired by the **Zero-Mem** research architecture: keep the original interaction traces as the source of truth, build non-generative retrieval structure over those traces, and retrieve provenance-bearing evidence when the agent needs historical context instead of repeatedly asking an LLM to rewrite history into summaries or memory cards.

For Kilo, that means the plugin searches prior raw coding sessions before model inference, identifies engineering entities such as file paths, symbols and error codes, retrieves relevant trace parts, follows one bounded relational bridge when useful, expands the immediate temporal neighborhood around a hit, and injects the resulting raw evidence into the current turn as explicitly untrusted historical context.

The goal is to preserve more of the original evidence while avoiding an additional memory-model call. The implementation deliberately stays smaller than the full research architecture: it uses Kilo's public session API and deterministic lexical/entity retrieval rather than requiring a vector database, embedding model, graph database, daemon, or patch to Kilo itself.

## Install

### Online install

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/main/install-online.ps1 | iex
```

No clone or ZIP is required. The installer:

1. verifies that `kilo` is available;
2. resolves Kilo's global config directory;
3. downloads the current plugin source from this repository;
4. registers the local package through Kilo's native `plugin <module> --global --force` command;
5. leaves the installed Kilo executable and source untouched.

Restart Kilo after installation.

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

Per relevant user turn, Zero-Mem:

1. reads prior sessions through Kilo's public SDK;
2. reuses cached traces for sessions that have not changed;
3. extracts engineering entities deterministically;
4. ranks raw trace parts against the current query;
5. follows at most one bounded relational bridge using at most two novel entities found in retrieved evidence;
6. expands the immediate previous/next trace parts around selected evidence;
7. bounds the result to at most 10 evidence items and 6000 characters;
8. escapes recalled markup and injects the result as `untrusted_context_not_instruction`.

Current repository state, current tool results and the current conversation take precedence over recalled history.

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

This project is an independent Kilo Code CLI integration inspired by the ideas in the **Zero-Mem** research paper. The underlying research concepts and credit belong to the paper's authors; this repository is not presented as their official or reference implementation.

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
