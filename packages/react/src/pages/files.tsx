import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ClipboardCopyIcon,
  Code2Icon,
  ExternalLinkIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderPlusIcon,
  FolderIcon,
  FolderOpenIcon,
  RotateCwIcon,
  SearchIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type Ref,
} from "react";

import { Button } from "../components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Input } from "../components/input";
import { useIsDark } from "../hooks/use-is-dark";
import { cn } from "../lib/utils";

type WorkspaceFileNode = {
  readonly type: "file" | "directory";
  readonly name: string;
  readonly path: string;
  readonly children?: readonly WorkspaceFileNode[];
};

type WorkspaceOpenTarget =
  | "default"
  | "file-manager"
  | "cursor"
  | "zed"
  | "vscode"
  | "vscode-insiders"
  | "vscodium";

type WorkspaceOpenTargetOption = {
  readonly id: WorkspaceOpenTarget;
  readonly label: string;
};

type WorkspaceFilesApi = {
  readonly list: () => Promise<{
    readonly rootPath: string;
    readonly tree: readonly WorkspaceFileNode[];
    readonly openTargets: readonly WorkspaceOpenTargetOption[];
  }>;
  readonly read: (path: string) => Promise<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly write: (
    path: string,
    content: string,
  ) => Promise<{
    readonly path: string;
  }>;
  readonly createFile: (
    path: string,
    content?: string,
  ) => Promise<{
    readonly path: string;
  }>;
  readonly createDirectory: (path: string) => Promise<{
    readonly path: string;
  }>;
  readonly moveFile: (
    sourcePath: string,
    destinationDirectoryPath: string,
  ) => Promise<{
    readonly path: string;
  }>;
  readonly getDroppedFilePaths: (files: readonly File[]) => readonly string[];
  readonly importPaths: (
    sourcePaths: readonly string[],
    destinationDirectoryPath: string,
  ) => Promise<{
    readonly paths: readonly string[];
  }>;
  readonly open: (path: string, target: WorkspaceOpenTarget) => Promise<boolean>;
};

type WorkspaceFilesState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly rootPath: string;
      readonly tree: readonly WorkspaceFileNode[];
      readonly openTargets: readonly WorkspaceOpenTargetOption[];
    }
  | { readonly status: "unavailable" }
  | { readonly status: "error"; readonly message: string };

type EditorStatus = "idle" | "loading" | "ready" | "saving" | "saved" | "error";

type CreateDraft = {
  readonly kind: "file" | "directory";
  readonly parentPath: string;
};

type Row =
  | {
      readonly kind: "directory";
      readonly depth: number;
      readonly node: WorkspaceFileNode;
      readonly open: boolean;
    }
  | {
      readonly kind: "file";
      readonly depth: number;
      readonly node: WorkspaceFileNode;
    };

const EDITABLE_FILE_PATTERN = /\.(md|mdown|markdown|mdx|txt)$/i;
const SAVE_DEBOUNCE_MS = 700;
const WORKSPACE_FILE_DRAG_TYPE = "application/x-godtool-workspace-file";
const PREFERRED_OPEN_TARGET_KEY = "godtool:files:preferred-open-target";
const WORKSPACE_OPEN_TARGET_IDS = new Set<WorkspaceOpenTarget>([
  "default",
  "file-manager",
  "cursor",
  "zed",
  "vscode",
  "vscode-insiders",
  "vscodium",
]);

const getWorkspaceFilesApi = (): WorkspaceFilesApi | null => {
  const electronWindow = window as Window & {
    readonly electronAPI?: { readonly files?: WorkspaceFilesApi };
  };
  return electronWindow.electronAPI?.files ?? null;
};

const isEditableFile = (node: WorkspaceFileNode): boolean =>
  node.type === "file" && EDITABLE_FILE_PATTERN.test(node.name);

const collectDirectoryPaths = (nodes: readonly WorkspaceFileNode[], acc: Set<string>): void => {
  for (const node of nodes) {
    if (node.type !== "directory") continue;
    acc.add(node.path);
    collectDirectoryPaths(node.children ?? [], acc);
  }
};

const directoryContainsPath = (directory: WorkspaceFileNode, path: string): boolean =>
  (directory.children ?? []).some(
    (child) =>
      child.path === path || (child.type === "directory" && directoryContainsPath(child, path)),
  );

const filterTree = (
  nodes: readonly WorkspaceFileNode[],
  terms: readonly string[],
): readonly WorkspaceFileNode[] => {
  if (terms.length === 0) return nodes;

  const filtered: WorkspaceFileNode[] = [];
  for (const node of nodes) {
    const selfMatches = terms.every((term) => node.path.toLowerCase().includes(term));
    if (node.type === "directory") {
      const children = filterTree(node.children ?? [], terms);
      if (selfMatches || children.length > 0) {
        filtered.push({ ...node, children });
      }
    } else if (selfMatches) {
      filtered.push(node);
    }
  }
  return filtered;
};

const flattenTree = (
  nodes: readonly WorkspaceFileNode[],
  depth: number,
  openSet: ReadonlySet<string>,
  acc: Row[],
): void => {
  for (const node of nodes) {
    if (node.type === "directory") {
      const open = openSet.has(node.path);
      acc.push({ kind: "directory", depth, node, open });
      if (open) flattenTree(node.children ?? [], depth + 1, openSet, acc);
      continue;
    }
    acc.push({ kind: "file", depth, node });
  }
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

const readPreferredOpenTarget = (): WorkspaceOpenTarget | null => {
  try {
    const value = window.localStorage.getItem(PREFERRED_OPEN_TARGET_KEY);
    return value && WORKSPACE_OPEN_TARGET_IDS.has(value as WorkspaceOpenTarget)
      ? (value as WorkspaceOpenTarget)
      : null;
  } catch {
    return null;
  }
};

const writePreferredOpenTarget = (target: WorkspaceOpenTarget): void => {
  try {
    window.localStorage.setItem(PREFERRED_OPEN_TARGET_KEY, target);
  } catch {}
};

const dirnameFromPath = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};

const joinWorkspacePath = (parentPath: string, name: string): string => {
  const cleanName = name.replace(/^\/+|\/+$/g, "");
  return parentPath ? `${parentPath}/${cleanName}` : cleanName;
};

const isExternalFileDrop = (event: DragEvent<HTMLElement>): boolean =>
  Array.from(event.dataTransfer.types).includes("Files") &&
  !Array.from(event.dataTransfer.types).includes(WORKSPACE_FILE_DRAG_TYPE);

function OpenTargetIcon(props: { target: WorkspaceOpenTarget; className?: string }) {
  if (props.target === "default") {
    return <ExternalLinkIcon className={cn("size-3.5", props.className)} />;
  }
  if (props.target === "file-manager") {
    return <FolderIcon className={cn("size-3.5", props.className)} />;
  }
  if (props.target === "zed") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex size-3.5 items-center justify-center rounded-[3px] bg-foreground text-[8px] font-semibold text-background",
          props.className,
        )}
      >
        Z
      </span>
    );
  }
  if (props.target === "cursor") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex size-3.5 items-center justify-center rounded-[3px] border border-muted-foreground/70 text-[8px] font-semibold text-foreground",
          props.className,
        )}
      >
        C
      </span>
    );
  }
  return <Code2Icon className={cn("size-3.5", props.className)} />;
}

export function FilesPage() {
  const editor = useCreateBlockNote();
  const isDark = useIsDark();
  const filesApi = useMemo(() => getWorkspaceFilesApi(), []);
  const [filesState, setFilesState] = useState<WorkspaceFilesState>({ status: "loading" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<EditorStatus>("idle");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [preferredOpenTarget, setPreferredOpenTarget] = useState<WorkspaceOpenTarget | null>(() =>
    readPreferredOpenTarget(),
  );
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingPathRef = useRef<string | null>(null);
  const suppressChangeRef = useRef(false);

  const refreshTree = useCallback(async () => {
    if (!filesApi) {
      setFilesState({ status: "unavailable" });
      return;
    }

    try {
      const next = await filesApi.list();
      setFilesState({
        status: "ready",
        rootPath: next.rootPath,
        tree: next.tree,
        openTargets: next.openTargets,
      });
    } catch (error) {
      setFilesState({ status: "error", message: getErrorMessage(error) });
    }
  }, [filesApi]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    if (!filesApi || !selectedPath) {
      setEditorStatus("idle");
      setEditorError(null);
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const path = selectedPath;
    loadingPathRef.current = path;
    suppressChangeRef.current = true;
    setEditorStatus("loading");
    setEditorError(null);

    filesApi
      .read(path)
      .then(async (file) => {
        if (loadingPathRef.current !== path) return;
        const blocks = await editor.tryParseMarkdownToBlocks(file.content);
        if (loadingPathRef.current !== path) return;
        editor.replaceBlocks(editor.document, blocks);
        setEditorStatus("ready");
      })
      .catch((error) => {
        if (loadingPathRef.current !== path) return;
        setEditorStatus("error");
        setEditorError(getErrorMessage(error));
      })
      .finally(() => {
        if (loadingPathRef.current === path) {
          setTimeout(() => {
            suppressChangeRef.current = false;
          }, 0);
        }
      });
  }, [editor, filesApi, selectedPath]);

  const saveSelectedFile = useCallback(async () => {
    if (!filesApi || !selectedPath || suppressChangeRef.current) return;

    setEditorStatus("saving");
    setEditorError(null);
    try {
      const markdown = await editor.blocksToMarkdownLossy(editor.document);
      await filesApi.write(selectedPath, markdown);
      setEditorStatus("saved");
      void refreshTree();
    } catch (error) {
      setEditorStatus("error");
      setEditorError(getErrorMessage(error));
    }
  }, [editor, filesApi, refreshTree, selectedPath]);

  const handleEditorChange = useCallback(() => {
    if (!selectedPath || suppressChangeRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveSelectedFile();
    }, SAVE_DEBOUNCE_MS);
  }, [saveSelectedFile, selectedPath]);

  const handleSelectPath = useCallback(
    (path: string) => {
      if (path === selectedPath) return;
      setOpenError(null);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void saveSelectedFile();
      }
      setSelectedPath(path);
    },
    [saveSelectedFile, selectedPath],
  );

  const openTargets = filesState.status === "ready" ? filesState.openTargets : [];
  const effectiveOpenTarget = useMemo(() => {
    if (preferredOpenTarget && openTargets.some((target) => target.id === preferredOpenTarget)) {
      return preferredOpenTarget;
    }
    return openTargets[0]?.id ?? null;
  }, [openTargets, preferredOpenTarget]);
  const primaryOpenTarget =
    openTargets.find((target) => target.id === effectiveOpenTarget) ?? null;

  const openCurrentPath = useCallback(
    async (target: WorkspaceOpenTarget | null) => {
      if (!filesApi || !target) return;
      const path = selectedPath ?? "";
      setOpenError(null);
      try {
        await filesApi.open(path, target);
        setPreferredOpenTarget(target);
        writePreferredOpenTarget(target);
      } catch (error) {
        setOpenError(getErrorMessage(error));
      }
    },
    [filesApi, selectedPath],
  );

  const flushSelectedSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await saveSelectedFile();
  }, [saveSelectedFile]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 bg-background">
      <FilesSidebar
        filesApi={filesApi}
        state={filesState}
        selectedPath={selectedPath}
        onSelect={handleSelectPath}
        onRefresh={() => void refreshTree()}
        onBeforeMoveSelected={flushSelectedSave}
      />
      <section className="flex h-full min-w-0 flex-1 flex-col border-l border-sidebar-border">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-sidebar-border px-5">
          <div className="min-w-0">
            <h1 className="truncate font-mono text-sm font-medium">
              {selectedPath ?? "Files"}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <div className="flex overflow-hidden rounded-md border border-border bg-background">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!filesApi || !effectiveOpenTarget}
                  onClick={() => void openCurrentPath(effectiveOpenTarget)}
                  className="rounded-none border-r border-border px-2.5 text-muted-foreground hover:text-foreground"
                >
                  {primaryOpenTarget ? (
                    <OpenTargetIcon target={primaryOpenTarget.id} />
                  ) : (
                    <ExternalLinkIcon className="size-3.5" />
                  )}
                  <span className="hidden sm:inline">
                    {primaryOpenTarget ? `Open in ${primaryOpenTarget.label}` : "Open in"}
                  </span>
                </Button>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={!filesApi}
                    aria-label="Open in options"
                    className="rounded-none text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </div>
              <DropdownMenuContent align="end" className="w-52">
                {openTargets.length === 0 && (
                  <DropdownMenuItem disabled>No open targets found</DropdownMenuItem>
                )}
                {openTargets.map((target) => (
                  <DropdownMenuItem
                    key={target.id}
                    onSelect={() => void openCurrentPath(target.id)}
                    className="gap-2"
                  >
                    <OpenTargetIcon target={target.id} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">Open in {target.label}</span>
                    {target.id === effectiveOpenTarget && (
                      <CheckIcon className="ml-auto size-3.5 text-muted-foreground" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {openError && !selectedPath && (
          <div className="mx-5 mt-4 flex shrink-0 items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{openError}</span>
          </div>
        )}

        {selectedPath ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {(editorError || openError) && (
              <div className="mx-5 mt-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircleIcon className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{editorError ?? openError}</span>
              </div>
            )}
            <div className="mx-auto w-full max-w-4xl px-6 py-6">
              <BlockNoteView
                editor={editor}
                editable={editorStatus !== "loading"}
                onChange={handleEditorChange}
                theme={isDark ? "dark" : "light"}
                className="workspace-blocknote"
              />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <div className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <FileTextIcon className="size-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-medium text-foreground">Select a file</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Open a Markdown file from your workspace to view and edit it here.
                </p>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function FilesSidebar(props: {
  filesApi: WorkspaceFilesApi | null;
  state: WorkspaceFilesState;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onBeforeMoveSelected: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [manualOpen, setManualOpen] = useState<Set<string>>(() => new Set());
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [externalDropTargetPath, setExternalDropTargetPath] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const terms = useMemo(() => search.trim().toLowerCase().split(/\s+/).filter(Boolean), [search]);
  const createParentPath = props.selectedPath ? dirnameFromPath(props.selectedPath) : "";

  const visibleTree = useMemo(() => {
    if (props.state.status !== "ready") return [];
    return filterTree(props.state.tree, terms);
  }, [props.state, terms]);

  const openSet = useMemo(() => {
    const set = new Set(manualOpen);
    if (terms.length > 0) {
      collectDirectoryPaths(visibleTree, set);
      return set;
    }

    if (props.selectedPath) {
      for (const node of visibleTree) {
        if (node.type === "directory" && directoryContainsPath(node, props.selectedPath)) {
          set.add(node.path);
          collectSelectedAncestors(node, props.selectedPath, set);
        }
      }
    }
    return set;
  }, [manualOpen, props.selectedPath, terms.length, visibleTree]);

  const rows = useMemo(() => {
    const next: Row[] = [];
    flattenTree(visibleTree, 0, openSet, next);
    return next;
  }, [openSet, visibleTree]);

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [props.selectedPath, rows]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        searchRef.current?.blur();
        if (search.length > 0) setSearch("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [search]);

  const toggleDirectory = (path: string) => {
    setManualOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const startCreate = (kind: CreateDraft["kind"], parentPath = createParentPath) => {
    setSearch("");
    setCreateError(null);
    setActionError(null);
    setCreateName(kind === "file" ? "Untitled.md" : "New Folder");
    setCreateDraft({ kind, parentPath });
    if (parentPath) {
      setManualOpen((prev) => new Set(prev).add(parentPath));
    }
    requestAnimationFrame(() => {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    });
  };

  const cancelCreate = () => {
    setCreateDraft(null);
    setCreateName("");
    setCreateError(null);
  };

  const submitCreate = async () => {
    if (!props.filesApi || !createDraft) return;
    const trimmed = createName.trim();
    if (!trimmed) {
      cancelCreate();
      return;
    }
    if (trimmed.includes("\0")) {
      setCreateError("Invalid name");
      return;
    }

    try {
      const path = joinWorkspacePath(createDraft.parentPath, trimmed);
      const result =
        createDraft.kind === "file"
          ? await props.filesApi.createFile(path, "")
          : await props.filesApi.createDirectory(path);
      if (createDraft.parentPath) {
        setManualOpen((prev) => new Set(prev).add(createDraft.parentPath));
      }
      cancelCreate();
      props.onRefresh();
      if (createDraft.kind === "file") {
        props.onSelect(result.path);
      }
    } catch (error) {
      setCreateError(getErrorMessage(error));
    }
  };

  const fullWorkspacePath = (workspacePath: string): string => {
    if (props.state.status !== "ready") return workspacePath;
    return workspacePath ? `${props.state.rootPath}/${workspacePath}` : props.state.rootPath;
  };

  const runFileAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const revealPath = (path: string) =>
    runFileAction(async () => {
      if (!props.filesApi) return;
      await props.filesApi.open(path, "file-manager");
    });

  const openDefaultPath = (path: string) =>
    runFileAction(async () => {
      if (!props.filesApi) return;
      await props.filesApi.open(path, "default");
    });

  const copyPath = (path: string) =>
    runFileAction(async () => {
      await navigator.clipboard.writeText(fullWorkspacePath(path));
    });

  const copyRelativePath = (path: string) =>
    runFileAction(async () => {
      await navigator.clipboard.writeText(path);
    });

  const startFileDrag = (event: DragEvent<HTMLButtonElement>, path: string) => {
    setActionError(null);
    setDraggingPath(path);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, path);
    event.dataTransfer.setData("text/plain", path);
  };

  const clearFileDrag = () => {
    setDraggingPath(null);
    setDropTargetPath(null);
    setExternalDropTargetPath(null);
  };

  const importDroppedFiles = async (
    event: DragEvent<HTMLElement>,
    destinationDirectoryPath: string,
  ) => {
    if (!props.filesApi) return;
    setActionError(null);

    const files = Array.from(event.dataTransfer.files);
    const sourcePaths = props.filesApi.getDroppedFilePaths(files);
    if (sourcePaths.length === 0) {
      setActionError("Drop local files or folders from your computer");
      return;
    }

    try {
      const result = await props.filesApi.importPaths(sourcePaths, destinationDirectoryPath);
      setActionError(null);
      if (destinationDirectoryPath) {
        setManualOpen((prev) => new Set(prev).add(destinationDirectoryPath));
      }
      props.onRefresh();
      const firstEditablePath = result.paths.find((path) => EDITABLE_FILE_PATTERN.test(path));
      if (firstEditablePath) props.onSelect(firstEditablePath);
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const handleTreeDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (isExternalFileDrop(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (externalDropTargetPath === null) setExternalDropTargetPath("");
      return;
    }

    if (!draggingPath || dirnameFromPath(draggingPath) === "") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropTargetPath !== "") setDropTargetPath("");
  };

  const handleTreeDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setExternalDropTargetPath(null);
    if (dropTargetPath === "") setDropTargetPath(null);
  };

  const handleTreeDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!props.filesApi) return;

    if (isExternalFileDrop(event)) {
      const destinationDirectoryPath = externalDropTargetPath ?? "";
      setExternalDropTargetPath(null);
      await importDroppedFiles(event, destinationDirectoryPath);
      return;
    }

    const sourcePath = event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE) || draggingPath;
    clearFileDrag();
    if (!sourcePath || dirnameFromPath(sourcePath) === "") return;

    try {
      if (props.selectedPath === sourcePath) {
        await props.onBeforeMoveSelected();
      }
      const result = await props.filesApi.moveFile(sourcePath, "");
      props.onRefresh();
      if (props.selectedPath === sourcePath) {
        props.onSelect(result.path);
      }
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const handleDirectoryDragOver = (
    event: DragEvent<HTMLButtonElement>,
    destinationDirectoryPath: string,
  ) => {
    if (isExternalFileDrop(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (externalDropTargetPath !== destinationDirectoryPath) {
        setExternalDropTargetPath(destinationDirectoryPath);
      }
      return;
    }

    if (!draggingPath || dirnameFromPath(draggingPath) === destinationDirectoryPath) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropTargetPath !== destinationDirectoryPath) {
      setDropTargetPath(destinationDirectoryPath);
    }
  };

  const handleDirectoryDrop = async (
    event: DragEvent<HTMLButtonElement>,
    destinationDirectoryPath: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!props.filesApi) return;
    if (isExternalFileDrop(event)) {
      setExternalDropTargetPath(null);
      await importDroppedFiles(event, destinationDirectoryPath);
      return;
    }

    const sourcePath = event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE) || draggingPath;
    clearFileDrag();
    if (!sourcePath || dirnameFromPath(sourcePath) === destinationDirectoryPath) return;

    try {
      if (props.selectedPath === sourcePath) {
        await props.onBeforeMoveSelected();
      }
      const result = await props.filesApi.moveFile(sourcePath, destinationDirectoryPath);
      setManualOpen((prev) => new Set(prev).add(destinationDirectoryPath));
      props.onRefresh();
      if (props.selectedPath === sourcePath) {
        props.onSelect(result.path);
      }
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  return (
    <div className="flex h-full w-72 shrink-0 flex-col bg-sidebar lg:w-80">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-sidebar-border px-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">Files</h2>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="New file"
            onClick={() => startCreate("file")}
            className="text-muted-foreground hover:text-foreground"
          >
            <FilePlusIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="New folder"
            onClick={() => startCreate("directory")}
            className="text-muted-foreground hover:text-foreground"
          >
            <FolderPlusIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh files"
            onClick={props.onRefresh}
            className="text-muted-foreground hover:text-foreground"
          >
            <RotateCwIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <SearchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          aria-label="Search files"
          className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-xs shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0"
        />
        {search.length > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setSearch("")}
            aria-label="Clear search"
            className="size-4 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3" />
          </Button>
        )}
      </div>
      <div className="border-t border-sidebar-border/70" />
      {actionError && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{actionError}</span>
        </div>
      )}

      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-y-auto py-1",
          externalDropTargetPath === "" && "bg-primary/5 ring-1 ring-inset ring-primary/35",
          dropTargetPath === "" && "bg-primary/5 ring-1 ring-inset ring-primary/35",
        )}
        onDragOver={handleTreeDragOver}
        onDragLeave={handleTreeDragLeave}
        onDrop={(event) => void handleTreeDrop(event)}
      >
        {externalDropTargetPath === "" && (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-center gap-2 rounded-md border border-primary/35 bg-background/95 px-3 py-2 text-xs text-foreground shadow-sm">
            <UploadIcon className="size-3.5 text-primary" />
            <span>Drop to add files</span>
          </div>
        )}
        {props.state.status === "loading" && (
          <div className="p-4 text-xs text-muted-foreground">Loading workspace files...</div>
        )}
        {props.state.status === "unavailable" && (
          <div className="p-4 text-xs text-muted-foreground">
            Files are available in the desktop app.
          </div>
        )}
        {props.state.status === "error" && (
          <div className="p-4 text-xs text-destructive">{props.state.message}</div>
        )}
        {props.state.status === "ready" &&
          (rows.length === 0 && !createDraft ? (
            <div className="p-4 text-xs text-muted-foreground">
              {terms.length > 0 ? "No files match your filter" : "No workspace files yet"}
            </div>
          ) : (
            <>
              {createDraft && (
                <CreateRow
                  inputRef={createInputRef}
                  kind={createDraft.kind}
                  name={createName}
                  error={createError}
                  depth={createDraft.parentPath ? createDraft.parentPath.split("/").length : 0}
                  onNameChange={setCreateName}
                  onCancel={cancelCreate}
                  onSubmit={() => void submitCreate()}
                />
              )}
              {rows.map((row) =>
                row.kind === "directory" ? (
                  <DirectoryRow
                    key={row.node.path}
                    node={row.node}
                    depth={row.depth}
                    open={row.open}
                    onToggle={() => toggleDirectory(row.node.path)}
                    dropActive={
                      dropTargetPath === row.node.path || externalDropTargetPath === row.node.path
                    }
                    onDragEnter={() => {
                      if (!draggingPath) return;
                      setDropTargetPath(row.node.path);
                      setManualOpen((prev) => new Set(prev).add(row.node.path));
                    }}
                    onExternalDragEnter={() => {
                      setExternalDropTargetPath(row.node.path);
                      setManualOpen((prev) => new Set(prev).add(row.node.path));
                    }}
                    onDragOver={(event) => handleDirectoryDragOver(event, row.node.path)}
                    onDragLeave={() => {
                      if (dropTargetPath === row.node.path) setDropTargetPath(null);
                      if (externalDropTargetPath === row.node.path) setExternalDropTargetPath(null);
                    }}
                    onDrop={(event) => void handleDirectoryDrop(event, row.node.path)}
                    onCreateFile={() => startCreate("file", row.node.path)}
                    onCreateDirectory={() => startCreate("directory", row.node.path)}
                    onReveal={() => void revealPath(row.node.path)}
                    onOpenDefault={() => void openDefaultPath(row.node.path)}
                    onCopyPath={() => void copyPath(row.node.path)}
                    onCopyRelativePath={() => void copyRelativePath(row.node.path)}
                    onCollapse={() => {
                      setManualOpen((prev) => {
                        const next = new Set(prev);
                        next.delete(row.node.path);
                        return next;
                      });
                    }}
                    onCollapseAll={() => setManualOpen(new Set())}
                  />
                ) : (
                  <FileRow
                    key={row.node.path}
                    buttonRef={row.node.path === props.selectedPath ? selectedRowRef : undefined}
                    node={row.node}
                    depth={row.depth}
                    active={row.node.path === props.selectedPath}
                    disabled={!isEditableFile(row.node)}
                    onSelect={() => props.onSelect(row.node.path)}
                    onDragStart={(event) => startFileDrag(event, row.node.path)}
                    onDragEnd={clearFileDrag}
                    onCreateFile={() => startCreate("file", dirnameFromPath(row.node.path))}
                    onCreateDirectory={() =>
                      startCreate("directory", dirnameFromPath(row.node.path))
                    }
                    onReveal={() => void revealPath(row.node.path)}
                    onOpenDefault={() => void openDefaultPath(row.node.path)}
                    onCopyPath={() => void copyPath(row.node.path)}
                    onCopyRelativePath={() => void copyRelativePath(row.node.path)}
                  />
                ),
              )}
            </>
          ))}
      </div>
    </div>
  );
}

const collectSelectedAncestors = (
  directory: WorkspaceFileNode,
  selectedPath: string,
  acc: Set<string>,
): boolean => {
  for (const child of directory.children ?? []) {
    if (child.path === selectedPath) return true;
    if (child.type === "directory" && collectSelectedAncestors(child, selectedPath, acc)) {
      acc.add(child.path);
      return true;
    }
  }
  return false;
};

const rowIndent = (depth: number) => 12 + depth * 16;

const rowBaseClasses =
  "relative flex h-auto w-full items-center justify-start gap-2 rounded-none py-2 text-xs font-normal transition-[background-color] duration-150";

function CreateRow(props: {
  inputRef: Ref<HTMLInputElement>;
  kind: CreateDraft["kind"];
  name: string;
  error: string | null;
  depth: number;
  onNameChange: (name: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const Icon = props.kind === "file" ? FileTextIcon : FolderIcon;
  return (
    <div
      className="px-2 py-1"
      style={{ paddingLeft: rowIndent(props.depth) + 20, paddingRight: 8 }}
    >
      <div className="flex h-7 items-center gap-2 rounded-md bg-sidebar-active/70 px-2 ring-1 ring-primary/40">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={props.inputRef}
          value={props.name}
          onChange={(event) => props.onNameChange(event.target.value)}
          onBlur={props.onCancel}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onSubmit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
          aria-label={props.kind === "file" ? "New file name" : "New folder name"}
        />
        <button
          type="button"
          aria-label="Cancel"
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onCancel}
          className="text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {props.error && <div className="mt-1 text-[11px] text-destructive">{props.error}</div>}
    </div>
  );
}

function DirectoryRow(props: {
  node: WorkspaceFileNode;
  depth: number;
  open: boolean;
  dropActive: boolean;
  onToggle: () => void;
  onDragEnter: () => void;
  onExternalDragEnter: () => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onReveal: () => void;
  onOpenDefault: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onCollapse: () => void;
  onCollapseAll: () => void;
}) {
  const Icon = props.open ? FolderOpenIcon : FolderIcon;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-expanded={props.open}
          onClick={props.onToggle}
          onDragEnter={(event) => {
            if (isExternalFileDrop(event)) props.onExternalDragEnter();
            else props.onDragEnter();
          }}
          onDragOver={props.onDragOver}
          onDragLeave={props.onDragLeave}
          onDrop={props.onDrop}
          className={cn(
            rowBaseClasses,
            "text-foreground hover:bg-sidebar-active/70",
            props.dropActive && "bg-primary/15 ring-1 ring-inset ring-primary/45",
          )}
          style={{ paddingLeft: rowIndent(props.depth), paddingRight: 12 }}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              props.open && "rotate-90",
            )}
          />
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left font-mono">{props.node.name}</span>
        </Button>
      </ContextMenuTrigger>
      <FileTreeContextMenuContent
        node={props.node}
        onCreateFile={props.onCreateFile}
        onCreateDirectory={props.onCreateDirectory}
        onReveal={props.onReveal}
        onOpenDefault={props.onOpenDefault}
        onCopyPath={props.onCopyPath}
        onCopyRelativePath={props.onCopyRelativePath}
        onCollapse={props.onCollapse}
        onCollapseAll={props.onCollapseAll}
      />
    </ContextMenu>
  );
}

function FileTreeContextMenuContent(props: {
  node: WorkspaceFileNode;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onReveal: () => void;
  onOpenDefault: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onCollapse?: () => void;
  onCollapseAll?: () => void;
}) {
  const isDirectory = props.node.type === "directory";
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem onSelect={props.onCreateFile}>
        <FilePlusIcon className="size-4" />
        New File
      </ContextMenuItem>
      <ContextMenuItem onSelect={props.onCreateDirectory}>
        <FolderPlusIcon className="size-4" />
        New Folder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={props.onReveal}>
        <FolderOpenIcon className="size-4" />
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuItem onSelect={props.onOpenDefault}>
        <ExternalLinkIcon className="size-4" />
        Open in Default App
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={props.onCopyPath}>
        <ClipboardCopyIcon className="size-4" />
        Copy Path
      </ContextMenuItem>
      <ContextMenuItem onSelect={props.onCopyRelativePath}>
        <ClipboardCopyIcon className="size-4" />
        Copy Relative Path
      </ContextMenuItem>
      {isDirectory && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={props.onCollapse}>Fold Directory</ContextMenuItem>
          <ContextMenuItem onSelect={props.onCollapseAll}>Collapse All</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

function FileRow(props: {
  buttonRef?: Ref<HTMLButtonElement>;
  node: WorkspaceFileNode;
  depth: number;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onReveal: () => void;
  onOpenDefault: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          ref={props.buttonRef}
          variant="ghost"
          aria-disabled={props.disabled}
          draggable={!props.disabled}
          onClick={() => {
            if (!props.disabled) props.onSelect();
          }}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          className={cn(
            rowBaseClasses,
            props.active
              ? "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40 hover:bg-primary/20"
              : "text-foreground/80 hover:bg-sidebar-active/70 hover:text-foreground",
            props.disabled && "cursor-not-allowed opacity-45",
          )}
          style={{ paddingLeft: rowIndent(props.depth) + 20, paddingRight: 12 }}
          title={props.disabled ? "Only Markdown and text files are editable" : props.node.path}
        >
          <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left font-mono">{props.node.name}</span>
        </Button>
      </ContextMenuTrigger>
      <FileTreeContextMenuContent
        node={props.node}
        onCreateFile={props.onCreateFile}
        onCreateDirectory={props.onCreateDirectory}
        onReveal={props.onReveal}
        onOpenDefault={props.onOpenDefault}
        onCopyPath={props.onCopyPath}
        onCopyRelativePath={props.onCopyRelativePath}
      />
    </ContextMenu>
  );
}
