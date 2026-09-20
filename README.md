# Zero-Mem for Kilo Code CLI

Deterministic raw-session recall plugin for Kilo Code CLI, inspired by Zero-Mem.

The repository has two roles:

- `main`: plugin-only source and installer.
- `kilo-base`: Kilo source baseline preserved for compatibility/integration testing.

Zero-Mem uses Kilo's public plugin hook and SDK session API. It does not patch or rebuild the installed Kilo CLI.

## Install

### Online one-command install

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/dtadptvl/kilocode/main/install-online.ps1 | iex
```

This downloads the current Zero-Mem plugin from `main`, installs it into Kilo's global config directory, and registers it with Kilo's native global plugin command. No clone or ZIP is required.

### Double-click

On Windows, download/extract the repository and double-click:

```text
setup.cmd
```

### Command

From the extracted directory:

```cmd
setup.cmd
```

or:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

1. verifies `kilo` is in PATH;
2. resolves Kilo's global config directory;
3. copies Zero-Mem into that config directory;
4. runs Kilo's native `plugin <module> --global --force` command to register the local plugin;
5. leaves the Kilo executable/source untouched.

Restart Kilo after installation.

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
- marks all recalled history as untrusted context, never instructions.

No embedding model, vector database, extra memory LLM call, daemon, scheduler, or Kilo source patch is required.
