export function inferLanguage(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d.ts")) return "typescript";
  const ext = lower.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    h: "cpp",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    md: "markdown",
    mdx: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sh: "shellscript",
    zsh: "shellscript",
    bash: "shellscript",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    dockerfile: "dockerfile",
    graphql: "graphql",
    vue: "html",
    svelte: "html",
  };
  return map[ext] ?? "plaintext";
}
