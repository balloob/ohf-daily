/** Turn an arbitrary generated article id into one stable, single URL segment. */
export function articleSlug(id: string): string {
  const value = String(id ?? "").trim();
  if (!value) return "article";

  // Encode literal tildes first, then use tildes for percent escapes. This keeps
  // slashes and Unicode out of filesystem paths without losing uniqueness.
  return encodeURIComponent(value)
    .replace(/~/g, "%7E")
    .replace(/%/g, "~");
}
