/**
 * DOMPurify's default allowlist keeps `<form>`, `<input>`, `<button>`, `<style>`
 * and the whole SVG/MathML surface. Note authors control this markdown, so the
 * defaults let one build a pixel-perfect fake "enter your password" form on the
 * app's own origin — `form-action 'self'` would allow the submit, and the secret
 * would land in the reverse proxy's access log as a query string. The SVG/MathML
 * namespaces are also where DOMPurify's mXSS bypasses historically live, and a
 * markdown note needs neither.
 */
const SANITIZE_CONFIG = {
	USE_PROFILES: { html: true },
	FORBID_TAGS: ["form", "input", "button", "select", "textarea", "option", "style"],
	FORBID_ATTR: ["style", "action", "formaction", "name"],
	ALLOW_DATA_ATTR: false,
};

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
	return DOMPurify.default.sanitize(raw, SANITIZE_CONFIG);
}
