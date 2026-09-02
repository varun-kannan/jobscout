/**
 * Bun embeds these at build time via `import ... with { type: "text" }`, so the
 * compiled binary carries its own schema with no files alongside it.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}
