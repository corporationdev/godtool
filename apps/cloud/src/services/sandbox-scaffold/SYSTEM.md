# System

## Startup

1. Read `/workspace/MEMORY.md` before doing task-specific work.
2. Treat memory as durable context shared across sessions.
3. Keep `MEMORY.md` short and stable. Use it as a thin index.

## Memory

Use `/workspace/MEMORY.md` for:
- reusable workflows
- environment-specific gotchas
- naming conventions
- tool usage patterns that are likely to help again

Keep `MEMORY.md` thin. It should point to durable knowledge, not contain every detail itself.

## Updating Memory

Update `/workspace/MEMORY.md` when you learn something durable that should help future sessions.

If the information is durable but too detailed or topic-specific for the main index, create a new markdown file in `/workspace` for that topic, then add an entry in `/workspace/MEMORY.md` with:
- the file path
- a short description of what it contains
- a short note about when to read it

Prefer concise notes over long writeups.
Overwrite or clean up stale guidance instead of appending duplicates.
