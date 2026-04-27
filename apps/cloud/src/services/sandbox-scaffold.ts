export const SANDBOX_SCAFFOLD_ROOT_DIRECTORY = "/workspace";

const memoryMd = "";

const systemMd = `# System

## Startup

1. Read \`/workspace/MEMORY.md\` before doing task-specific work.
2. Treat memory as durable context shared across sessions.
3. Keep \`MEMORY.md\` short and stable. Use it as a thin index.

## Memory

Use \`/workspace/MEMORY.md\` for:
- reusable workflows
- environment-specific gotchas
- naming conventions
- tool usage patterns that are likely to help again

Keep \`MEMORY.md\` a thin index. It should point to files with knowledge, not contain every detail itself.

## Updating Memory

Update \`/workspace/MEMORY.md\` when you learn something durable that should help future sessions. You should create a new markdown file or folder in \`/workspace\` for that topic, then add an entry in \`/workspace/MEMORY.md\` with:
- the file path
- a short description of what it contains
- a short note about when to read it

Inside of the folder you can include markdown, or reusable typescript code in .ts files. 

Inside

Prefer concise notes over long writeups.
Overwrite or clean up stale guidance instead of appending duplicates.
`;

export const sandboxScaffoldFiles = [
  { content: memoryMd, path: "MEMORY.md" },
  { content: systemMd, path: "SYSTEM.md" },
]
  .sort((a, b) => a.path.localeCompare(b.path));
