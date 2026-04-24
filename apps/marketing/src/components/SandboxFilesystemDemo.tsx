import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";

type FileNode = {
  id: string;
  name: string;
  type: "file";
  content: string;
};

type FolderNode = {
  id: string;
  name: string;
  type: "folder";
  children: FsNode[];
};

type FsNode = FileNode | FolderNode;
type CreateKind = "file" | "folder";

const STORAGE_KEY = "godtool.landing.sandboxFilesystem.v1";
const DEFAULT_SELECTED = "/home/godtool/memory.md";

const initialFilesystem: FsNode[] = [
  {
    id: "home",
    name: "home",
    type: "folder",
    children: [
      {
        id: "godtool",
        name: "godtool",
        type: "folder",
        children: [
          {
            id: "memory",
            name: "memory.md",
            type: "file",
            content:
              "# Shared agent memory\n\n- Prefer Linear for roadmap work.\n- Reuse the existing GitHub source before adding another connector.\n- Keep generated plans in /home/godtool/plans so every agent can pick them back up.\n- Use the virtual desktop and binary tools instead of asking the user to switch apps.\n",
          },
          {
            id: "instructions",
            name: "instructions.md",
            type: "file",
            content:
              "# Persistent instructions\n\nEvery agent gets the same Linux filesystem, credentials, and tool catalog.\n\nWhen Cursor, Claude Code, OpenClaw, or a custom agent returns later, it can read the same files instead of reconstructing context from chat history.\n",
          },
          {
            id: "plans",
            name: "plans",
            type: "folder",
            children: [
              {
                id: "launch-plan",
                name: "launch-plan.md",
                type: "file",
                content:
                  "# Launch plan\n\n1. Save project memory on disk.\n2. Connect authenticated services once.\n3. Let the next agent continue from the same filesystem and typed tools.\n",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "usr",
    name: "usr",
    type: "folder",
    children: [
      {
        id: "bin",
        name: "bin",
        type: "folder",
        children: [
          {
            id: "python",
            name: "python",
            type: "file",
            content: "Python 3.12.4\n",
          },
          {
            id: "node",
            name: "node",
            type: "file",
            content: "Node.js 22.12.0\n",
          },
        ],
      },
    ],
  },
];

const defaultExpanded = new Set(["/", "/home", "/home/godtool", "/home/godtool/plans", "/usr", "/usr/bin"]);

function joinPath(parentPath: string, name: string) {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

function dirname(path: string) {
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function sanitizeName(name: string) {
  return name.trim().replaceAll("/", "-").replace(/\s+/g, "-").slice(0, 48);
}

function isFolder(node: FsNode | undefined): node is FolderNode {
  return node?.type === "folder";
}

function findNode(nodes: FsNode[], path: string, parentPath = "/"): FsNode | undefined {
  for (const node of nodes) {
    const nodePath = joinPath(parentPath, node.name);
    if (nodePath === path) return node;
    if (node.type === "folder") {
      const found = findNode(node.children, path, nodePath);
      if (found) return found;
    }
  }
  return undefined;
}

function findFirstFile(nodes: FsNode[], parentPath = "/"): string {
  for (const node of nodes) {
    const nodePath = joinPath(parentPath, node.name);
    if (node.type === "file") return nodePath;
    const childPath = findFirstFile(node.children, nodePath);
    if (childPath) return childPath;
  }
  return DEFAULT_SELECTED;
}

function updateFileContent(nodes: FsNode[], path: string, content: string, parentPath = "/"): FsNode[] {
  return nodes.map((node) => {
    const nodePath = joinPath(parentPath, node.name);
    if (nodePath === path && node.type === "file") {
      return { ...node, content };
    }
    if (node.type === "folder") {
      return { ...node, children: updateFileContent(node.children, path, content, nodePath) };
    }
    return node;
  });
}

function insertNode(nodes: FsNode[], parentPath: string, newNode: FsNode, currentPath = "/"): FsNode[] {
  if (parentPath === "/") {
    return sortNodes([...nodes, newNode]);
  }

  return nodes.map((node) => {
    const nodePath = joinPath(currentPath, node.name);
    if (node.type !== "folder") return node;
    if (nodePath === parentPath) {
      return { ...node, children: sortNodes([...node.children, newNode]) };
    }
    return { ...node, children: insertNode(node.children, parentPath, newNode, nodePath) };
  });
}

function removeNode(nodes: FsNode[], path: string, currentPath = "/"): FsNode[] {
  return nodes
    .filter((node) => joinPath(currentPath, node.name) !== path)
    .map((node) => {
      if (node.type === "file") return node;
      const nodePath = joinPath(currentPath, node.name);
      return { ...node, children: removeNode(node.children, path, nodePath) };
    });
}

function sortNodes(nodes: FsNode[]) {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function countNodes(nodes: FsNode[]): { files: number; folders: number } {
  return nodes.reduce(
    (total, node) => {
      if (node.type === "file") return { ...total, files: total.files + 1 };
      const childCounts = countNodes(node.children);
      return {
        files: total.files + childCounts.files,
        folders: total.folders + childCounts.folders + 1,
      };
    },
    { files: 0, folders: 0 },
  );
}

function Icon({ type }: { type: "folder" | "folder-open" | "file" | "plus" | "trash" | "disk" }) {
  const common = "h-4 w-4 shrink-0";
  if (type === "file") {
    return (
      <svg className={common} aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v5h5" />
      </svg>
    );
  }
  if (type === "plus") {
    return (
      <svg className={common} aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  if (type === "trash") {
    return (
      <svg className={common} aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" />
      </svg>
    );
  }
  if (type === "disk") {
    return (
      <svg className={common} aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3h12l2 2v16H5z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 3v6h8V3M8 21v-7h8v7" />
      </svg>
    );
  }
  return (
    <svg className={common} aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7">
      <path strokeLinecap="round" strokeLinejoin="round" d={type === "folder-open" ? "M3 7h7l2 2h9l-2 10H5z" : "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"} />
    </svg>
  );
}

function ToolbarButton({
  children,
  onClick,
  testId,
  variant = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  testId?: string;
  variant?: "default" | "danger";
}) {
  return (
    // oxlint-disable-next-line react/forbid-elements
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
        variant === "danger"
          ? "border-red-400/20 text-red-300 hover:border-red-400/35 hover:bg-red-400/10"
          : "border-rule bg-surface text-ink-muted hover:border-teal/25 hover:bg-teal/[0.06] hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export default function SandboxFilesystemDemo() {
  const [filesystem, setFilesystem] = useState<FsNode[]>(initialFilesystem);
  const [selectedPath, setSelectedPath] = useState(DEFAULT_SELECTED);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded));
  const [hydrated, setHydrated] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("Persistent sandbox disk ready.");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { filesystem?: FsNode[]; selectedPath?: string };
        if (Array.isArray(parsed.filesystem)) {
          setFilesystem(parsed.filesystem);
          if (parsed.selectedPath) setSelectedPath(parsed.selectedPath);
        }
      }
    } catch {
      setFilesystem(initialFilesystem);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ filesystem, selectedPath }));
  }, [filesystem, hydrated, selectedPath]);

  const selectedNode = useMemo(() => findNode(filesystem, selectedPath), [filesystem, selectedPath]);
  const selectedFolderPath = selectedPath === "/" ? "/home/godtool" : isFolder(selectedNode) ? selectedPath : dirname(selectedPath);
  const counts = useMemo(() => countNodes(filesystem), [filesystem]);

  function toggleFolder(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function startCreate(kind: CreateKind) {
    setCreateKind(kind);
    setNewName(kind === "file" ? "notes.md" : "context");
    setExpanded((current) => new Set([...current, selectedFolderPath]));
  }

  function createNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createKind) return;

    const safeName = sanitizeName(newName);
    if (!safeName) {
      setMessage("Give the new item a name first.");
      return;
    }

    const parent = selectedFolderPath === "/" ? undefined : findNode(filesystem, selectedFolderPath);
    const siblings = selectedFolderPath === "/" ? filesystem : isFolder(parent) ? parent.children : [];
    if (siblings.some((node) => node.name === safeName)) {
      setMessage(`${safeName} already exists in ${selectedFolderPath}.`);
      return;
    }

    const newNode: FsNode =
      createKind === "folder"
        ? { id: `${safeName}-${Date.now()}`, name: safeName, type: "folder", children: [] }
        : {
            id: `${safeName}-${Date.now()}`,
            name: safeName,
            type: "file",
            content: `# ${safeName}\n\nStore context here so the next agent does not start cold.\n`,
          };
    const newPath = joinPath(selectedFolderPath, safeName);

    setFilesystem((current) => insertNode(current, selectedFolderPath, newNode));
    setSelectedPath(newPath);
    setExpanded((current) => new Set([...current, selectedFolderPath]));
    setCreateKind(null);
    setNewName("");
    setMessage(`${createKind === "file" ? "File" : "Folder"} created at ${newPath}.`);
  }

  function deleteSelected() {
    if (selectedPath === "/" || !selectedNode) return;
    const nextFilesystem = removeNode(filesystem, selectedPath);
    setFilesystem(nextFilesystem);
    setSelectedPath(findFirstFile(nextFilesystem));
    setMessage(`${selectedPath} removed from the sandbox disk.`);
  }

  function updateContent(content: string) {
    setFilesystem((current) => updateFileContent(current, selectedPath, content));
    setMessage("Saved. Refresh and this file will still be here.");
  }

  function resetDemo() {
    setFilesystem(initialFilesystem);
    setSelectedPath(DEFAULT_SELECTED);
    setExpanded(new Set(defaultExpanded));
    setCreateKind(null);
    setMessage("Demo filesystem reset.");
    window.localStorage.removeItem(STORAGE_KEY);
  }

  function renderNode(node: FsNode, path: string, depth: number): ReactNode {
    const isSelected = selectedPath === path;
    const isOpen = expanded.has(path);
    return (
      <div key={path}>
        {/* oxlint-disable-next-line react/forbid-elements */}
        <button
          type="button"
          data-testid="sandbox-file-tree-item"
          data-path={path}
          onClick={() => {
            setSelectedPath(path);
            if (node.type === "folder") toggleFolder(path);
          }}
          className={`group flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-[12px] transition-colors ${
            isSelected ? "border border-teal/20 bg-teal/[0.08] text-ink" : "border border-transparent text-ink-muted hover:bg-surface-overlay hover:text-ink"
          }`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
        >
          <span className={`text-ink-faint transition-transform ${node.type === "folder" && isOpen ? "rotate-90" : ""}`}>
            {node.type === "folder" ? ">" : ""}
          </span>
          <span className={node.type === "folder" ? "text-teal/75" : "text-ink-faint"}>
            <Icon type={node.type === "folder" ? (isOpen ? "folder-open" : "folder") : "file"} />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
        </button>
        {node.type === "folder" && isOpen ? node.children.map((child) => renderNode(child, joinPath(path, child.name), depth + 1)) : null}
      </div>
    );
  }

  return (
    <section data-testid="sandbox-demo" className="rise-d4 mb-16">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <span className="mb-3 block font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">Shared context</span>
          <h2 className="font-display text-[clamp(1.8rem,3.8vw,3.2rem)] leading-[1.05] tracking-tight text-ink">
            Memory should live <span className="italic text-teal">outside the chat.</span>
          </h2>
          <p className="mt-4 text-[15px] leading-7 text-ink-muted">
            GOD TOOL gives every agent the same persistent Linux filesystem. Save instructions, reusable scripts, and memory in one place, and allow ALL of your agents to read it.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-rule bg-rule text-center">
          {["Cursor", "OpenClaw", "Claude Code"].map((agent) => (
            <div key={agent} className="bg-surface-raised px-4 py-3">
              <div className="font-mono text-[11px] text-ink">{agent}</div>
              <div className="mt-1 text-[10px] text-ink-faint">same disk</div>
            </div>
          ))}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-rule bg-surface-raised">
        <div className="absolute inset-x-0 top-0 h-px bg-teal/25" />
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-md border border-teal/25 bg-teal/[0.08] text-teal">
              <Icon type="disk" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-mono text-[12px] text-ink">/home/godtool</div>
              <div className="truncate text-[11px] text-ink-faint">shared memory, files, and workspace state</div>
            </div>
          </div>
          <div className="hidden items-center gap-3 font-mono text-[11px] text-ink-faint sm:flex">
            <span>{counts.folders} folders</span>
            <span>{counts.files} files</span>
          </div>
        </div>

        <div className="grid min-h-[420px] lg:grid-cols-[310px_1fr]">
          <div className="border-b border-rule bg-surface p-3 lg:border-b-0 lg:border-r">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ToolbarButton testId="new-file-button" onClick={() => startCreate("file")}>
                <Icon type="plus" />
                File
              </ToolbarButton>
              <ToolbarButton testId="new-folder-button" onClick={() => startCreate("folder")}>
                <Icon type="plus" />
                Folder
              </ToolbarButton>
              <ToolbarButton testId="delete-node-button" onClick={deleteSelected} variant="danger">
                <Icon type="trash" />
              </ToolbarButton>
            </div>

            {createKind ? (
              <form onSubmit={createNode} className="mb-3 rounded-lg border border-teal/20 bg-teal/[0.05] p-2">
                {/* oxlint-disable-next-line react/forbid-elements */}
                <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                  New {createKind} in {selectedFolderPath}
                </label>
                <div className="flex gap-2">
                  {/* oxlint-disable-next-line react/forbid-elements */}
                  <input
                    data-testid="new-node-name"
                    value={newName}
                    onChange={(event) => setNewName(event.currentTarget.value)}
                    className="h-8 min-w-0 flex-1 rounded-md border border-rule bg-surface px-2 font-mono text-[12px] text-ink outline-none focus:border-teal/35"
                  />
                  {/* oxlint-disable-next-line react/forbid-elements */}
                  <button
                    type="submit"
                    data-testid="create-node-button"
                    className="h-8 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Create
                  </button>
                </div>
              </form>
            ) : null}

            <div className="h-[310px] overflow-y-auto pr-1 scrollbar-thin" aria-label="Sandbox file tree">
              {/* oxlint-disable-next-line react/forbid-elements */}
              <button
                type="button"
                onClick={() => {
                  setSelectedPath("/");
                  toggleFolder("/");
                }}
                className={`mb-1 flex h-8 w-full items-center gap-2 rounded-md border px-2 text-left text-[12px] transition-colors ${
                  selectedPath === "/" ? "border-teal/20 bg-teal/[0.08] text-ink" : "border-transparent text-ink-muted hover:bg-surface-overlay hover:text-ink"
                }`}
              >
                <span className={`text-ink-faint ${expanded.has("/") ? "rotate-90" : ""}`}>{">"}</span>
                <span className="text-teal/75">
                  <Icon type={expanded.has("/") ? "folder-open" : "folder"} />
                </span>
                <span className="font-mono">sandbox</span>
              </button>
              {expanded.has("/") ? filesystem.map((node) => renderNode(node, joinPath("/", node.name), 1)) : null}
            </div>
          </div>

          <div className="flex min-w-0 flex-col">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-rule px-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-[12px] text-ink" data-testid="selected-path">
                  {selectedPath}
                </div>
                <div className="mt-1 text-[11px] text-ink-faint">{message}</div>
              </div>
              {/* oxlint-disable-next-line react/forbid-elements */}
              <button
                type="button"
                onClick={resetDemo}
                className="shrink-0 rounded-md border border-rule px-2.5 py-1.5 text-[11px] text-ink-faint transition-colors hover:border-ink-faint hover:text-ink"
              >
                Reset
              </button>
            </div>

            {selectedNode?.type === "file" ? (
              /* oxlint-disable-next-line react/forbid-elements */
              <textarea
                data-testid="file-editor"
                value={selectedNode.content}
                onChange={(event) => updateContent(event.currentTarget.value)}
                spellCheck={false}
                className="min-h-[360px] flex-1 resize-none bg-surface-raised p-4 font-mono text-[13px] leading-6 text-ink outline-none placeholder:text-ink-faint"
              />
            ) : (
              <div className="flex min-h-[360px] flex-1 flex-col justify-center p-8 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-teal/25 bg-teal/[0.08] text-teal">
                  <Icon type="folder-open" />
                </div>
                <div className="font-medium text-ink">Folder selected</div>
                <p className="mx-auto mt-2 max-w-sm text-[13px] leading-6 text-ink-muted">
                  Create a file or folder here. The sandbox keeps the same disk state when the agent comes back later.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
