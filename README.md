# Zero-Mem for Kilo Code CLI

Deterministic raw-session recall plugin for Kilo Code CLI, inspired by the Zero-Mem research.

## Install

Online install from Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/main/install-online.ps1 | iex
```

Local command install from a cloned/downloaded repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer verifies Kilo, downloads/copies the plugin into Kilo's global config directory, and registers it through Kilo's native global plugin command. It does not patch or rebuild the installed Kilo CLI.

## Uninstall

Online uninstall:

```powershell
irm https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/main/uninstall-online.ps1 | iex
```

Local uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Uninstall removes only the Zero-Mem plugin registration and installed Zero-Mem directory. Before changing a Kilo config file it writes a `.zero-mem-uninstall.bak` backup.

## Repository layout

- `main`: Zero-Mem plugin source, installers, tests, and documentation.
- `kilo-base`: preserved Kilo source baseline used for compatibility and integration-contract testing.

## Zero-generative Project Memory

Zero-Mem retrieves raw historical session evidence. It does not automatically change Project Memory settings.

For a setup without automatic generative Project Memory capture, run inside Kilo:

```text
/memory auto off
```

Explicit `/memory remember`, `/memory correct`, and `/memory forget` remain available.

## Retrieval

Per relevant user turn, the plugin:

- reads prior sessions through the public Kilo SDK;
- caches unchanged raw sessions;
- extracts engineering entities deterministically;
- ranks raw trace parts;
- follows at most one bounded relational bridge using at most two novel entities;
- expands immediate temporal neighbors;
- injects at most 10 provenance-bearing raw evidence parts within a 6000-character budget;
- marks recalled history as untrusted context, never instructions.

No embedding model, vector database, extra memory LLM call, daemon, scheduler, or Kilo source patch is required.

## Research attribution

This plugin is inspired by **Zero-Mem: A Token-Efficient Memory Architecture for LLM Agents**. Credit for the underlying research ideas belongs to the paper's authors:

- Paper: https://arxiv.org/abs/2607.29377
- PDF: https://arxiv.org/pdf/2607.29377

This repository is an independent Kilo Code CLI integration and is not presented as the authors' reference implementation.
