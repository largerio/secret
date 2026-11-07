import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import type { AppConfig } from "../config.js";
import { createSiteSecurityHeaders } from "../middleware/security.js";
import { negotiate } from "./encodings.js";
import { HTML_CONTENT_TYPE, serveFile } from "./files.js";
import type { Site } from "./load.js";
import { createShellRenderer, type Page, visitorOf } from "./shell.js";

/** Paths the API answers, never the web app: the ones the web server in front used to proxy. */
export function isApiPath(path: string): boolean {
	return (
		path === "/api" || path.startsWith("/api/") || path === "/robots.txt" || path === "/sitemap.xml"
	);
}

/**
 * One route per entry at the root of the build (`/_app/*`, `/favicon.svg`…):
 * logs and metrics name a route pattern, and these stay few whatever the
 * build holds, where a path each would not.
 */
function staticRoutes(paths: Iterable<string>): ReadonlyArray<string> {
	const routes = new Set<string>();
	for (const path of paths) {
		const slash = path.indexOf("/", 1);
		routes.add(slash === -1 ? path : `${path.slice(0, slash)}/*`);
	}
	return [...routes].filter((route) => !isApiPath(route));
}

export interface SiteRoutes {
	/** Pages and static files, mounted at the root. */
	readonly routes: Hono<AppEnv>;
	/** The site's headers on what it answers, `api` on the API's paths. */
	readonly securityHeaders: (api: MiddlewareHandler) => MiddlewareHandler;
	/**
	 * `middleware` on the API's paths alone: compress() there, since the site
	 * sends copies it compressed once, and must never compress per request
	 * what it answers (a client asking for deflate only gets the file as it is).
	 */
	readonly apiOnly: (middleware: MiddlewareHandler) => MiddlewareHandler;
	/**
	 * A path nothing answered: the shell with a 404, which the app renders as
	 * its error page, for a GET outside the API; undefined for the API's 404.
	 */
	readonly notFound: (c: Context) => Response | undefined;
	/** Answered by the hundred on a page's first load: not worth a log line each, unless they fail. */
	readonly staticPaths: ReadonlyArray<string>;
}

/**
 * The web app, served by the API: its pages rendered from the shell, its files
 * from memory. The client router takes over once the page has loaded, so a
 * path the server does not know is the router's to render too.
 */
export function createSiteRoutes(site: Site, config: AppConfig): SiteRoutes {
	const render = createShellRenderer(site, config);
	const siteHeaders = createSiteSecurityHeaders(site.scriptHashes, "same-origin");
	const embeddedHeaders = createSiteSecurityHeaders(site.scriptHashes, "cross-origin");

	function page(c: Context, which: Page, status: 200 | 404): Response {
		const rendered = render(which, visitorOf(c));
		const copy = negotiate(c.req.header("accept-encoding"), rendered.encodings);
		c.header("Cache-Control", "no-cache");
		// Rendered in the visitor's language and theme, sent in the coding they accept.
		c.header("Vary", "Accept-Language, Cookie, Accept-Encoding");
		if (copy) {
			c.header("Content-Encoding", copy.encoding);
		}
		return c.body(copy?.body ?? rendered.body, status, { "Content-Type": HTML_CONTENT_TYPE });
	}

	/**
	 * A page's path with a trailing slash, sent where SvelteKit sent it: to
	 * the path without, query kept. The Location is this request's own path
	 * less its last character, so it starts with /note/ and never names
	 * another site.
	 */
	function withoutTrailingSlash(c: Context): Response {
		const url = new URL(c.req.url);
		return c.redirect(`${url.pathname.slice(0, -1)}${url.search}`, 308);
	}

	const routes = new Hono<AppEnv>();
	routes.get("/", (c) => page(c, "home", 200));
	routes.get("/note/:id", (c) => page(c, "note", 200));
	routes.get("/note/:id/", withoutTrailingSlash);
	routes.get("/note/:id/manage", (c) => page(c, "manage", 200));
	routes.get("/note/:id/manage/", withoutTrailingSlash);
	for (const route of staticRoutes(site.files.keys())) {
		routes.get(route, (c) => {
			const file = site.files.get(c.req.path);
			return file ? serveFile(c, file) : page(c, "notFound", 404);
		});
	}

	return {
		routes,
		securityHeaders: (api) => (c, next) => {
			if (isApiPath(c.req.path)) return api(c, next);
			return site.files.get(c.req.path)?.embeddable
				? embeddedHeaders(c, next)
				: siteHeaders(c, next);
		},
		apiOnly: (middleware) => (c, next) => (isApiPath(c.req.path) ? middleware(c, next) : next()),
		notFound(c) {
			// Hono answers a HEAD with its GET's headers, but the request keeps its method.
			const method = c.req.method;
			if ((method !== "GET" && method !== "HEAD") || isApiPath(c.req.path)) return undefined;
			return page(c, "notFound", 404);
		},
		staticPaths: [...site.files.keys()],
	};
}
