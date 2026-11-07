import { LOCALES } from "@largerio/secret-shared/site";
import { Hono } from "hono";

interface CrawlerFile {
	readonly contentType: string;
	readonly body: string;
}

export interface CrawlerRoutes {
	readonly routes: Hono;
	/** The paths they answer, at the root and outside `/api/`: the web app's never. */
	readonly paths: ReadonlyArray<string>;
}

/**
 * The home page, the one page to index, at the same address in every
 * language the web app speaks: the server answers each visitor in theirs.
 */
function sitemap(appUrl: string): string {
	const home = `${appUrl}/`;
	const alternates = [...LOCALES, "x-default"].map(
		(hreflang) => `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${home}" />\n`,
	);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>\n',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n',
		"  <url>\n",
		`    <loc>${home}</loc>\n`,
		...alternates,
		"    <changefreq>monthly</changefreq>\n",
		"    <priority>1.0</priority>\n",
		"  </url>\n",
		"</urlset>\n",
	].join("");
}

/**
 * robots.txt and the sitemap, which the API answers itself: they name the
 * instance's URL. Notes stay out of every index.
 */
export function createCrawlerRoutes(appUrl: string): CrawlerRoutes {
	const files: Readonly<Record<string, CrawlerFile>> = {
		"/robots.txt": {
			contentType: "text/plain",
			body: `User-agent: *\nAllow: /\nDisallow: /note/\nDisallow: /api/\n\nSitemap: ${appUrl}/sitemap.xml\n`,
		},
		"/sitemap.xml": { contentType: "application/xml", body: sitemap(appUrl) },
	};

	const routes = new Hono();
	for (const [path, file] of Object.entries(files)) {
		routes.get(path, (c) => {
			c.header("Content-Type", file.contentType);
			c.header("Cache-Control", "public, max-age=86400");
			return c.body(file.body);
		});
	}

	return { routes, paths: Object.keys(files) };
}
