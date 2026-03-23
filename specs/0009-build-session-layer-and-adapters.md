# Spec 0009: Build Session Layer And Adapters

## Status

Pending.

## Goal

Port the session abstraction and backend adapters so the TS implementation can actually drive supported coding backends with parity-appropriate lifecycle behavior.

## Required Work

- Port the session protocol and lifecycle behavior from the Python codebase.
- Define a transport boundary and implement ACP-first adapters for the supported backends.
- Normalize subprocess startup, stdout/stderr draining, JSON framing, session IDs, timeouts, and surfaced errors.
- Preserve resume/accounting/log-visible behavior expected by the CLI.
- Match the audited backend environment and credential rules:
  - CLI backends come from commands on `PATH`
  - API orchestrators use provider env vars such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, and `XAI_API_KEY`
  - `.env` loading and env propagation must be explicit in TS
- Preserve the Python-visible session lifecycle details:
  - resume session/chat IDs for Claude, Cursor, and Codex
  - `session_query_start`, `session_query_end`, `session_reset`, `session_timeout`, and cleanup-warning event shapes
  - Anthropic API key stripping/restoration rules for worker subprocesses
- Carry forward backend preflight classification, including warning-only auth/quota/billing failures where Python does not hard-abort the run.

## Acceptance Criteria

- At least one full backend path works end-to-end from the TS runtime.
- Session tests cover startup, message exchange, timeout handling, resume behavior, and cleanup.
- Adapter differences are hidden from normal CLI usage except where diagnostics intentionally expose them.
