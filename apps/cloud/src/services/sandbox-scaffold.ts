const scaffoldModules = import.meta.glob("./sandbox-scaffold/**/*", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

export const SANDBOX_SCAFFOLD_ROOT_DIRECTORY = "/workspace";

export const sandboxScaffoldFiles = Object.entries(scaffoldModules)
  .map(([sourcePath, content]) => ({
    content,
    path: sourcePath.replace("./sandbox-scaffold/", ""),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
