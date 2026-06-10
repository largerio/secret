/**
 * Render markdown to sanitized HTML. marked and DOMPurify are lazy-imported so
 * the markdown pipeline stays out of the initial bundle — it only loads when a
 * markdown note is previewed or viewed.
 */
export async function renderMarkdown(text: string): Promise<string> {
	const [{ marked }, DOMPurify] = await Promise.all([
		import("marked"),
		import("isomorphic-dompurify"),
	]);
	const raw = marked.parse(text, { async: false }) as string;
	return DOMPurify.default.sanitize(raw);
}
