import { BlockList, isIPv4, isIPv6 } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

interface RateLimitStore {
	readonly hits: number;
	readonly resetAt: number;
}

const MAX_STORE_SIZE = 10_000;

export interface RateLimitResult {
	readonly middleware: MiddlewareHandler;
	readonly cleanup: () => void;
}

export interface RateLimitOptions {
	readonly windowMs: number;
	readonly max: number;
	readonly trustedProxies?: ReadonlyArray<string>;
}

type IpType = "ipv4" | "ipv6";

function normalizeIp(ip: string): { readonly ip: string; readonly type: IpType } | null {
	if (ip.startsWith("::ffff:")) {
		const v4 = ip.slice(7);
		if (isIPv4(v4)) return { ip: v4, type: "ipv4" };
	}
	if (isIPv4(ip)) return { ip, type: "ipv4" };
	if (isIPv6(ip)) return { ip, type: "ipv6" };
	return null;
}

export function buildTrustedBlockList(cidrs: ReadonlyArray<string>): BlockList {
	const list = new BlockList();
	for (const raw of cidrs) {
		const entry = raw.trim();
		if (entry === "") continue;
		const [addr, prefixStr] = entry.split("/");
		if (!addr) throw new Error(`Invalid trusted proxy entry: ${raw}`);
		const normalized = normalizeIp(addr);
		if (!normalized) throw new Error(`Invalid trusted proxy address: ${raw}`);
		if (prefixStr === undefined) {
			list.addAddress(normalized.ip, normalized.type);
		} else {
			const prefix = Number(prefixStr);
			if (!Number.isInteger(prefix) || prefix < 0) {
				throw new Error(`Invalid trusted proxy prefix: ${raw}`);
			}
			list.addSubnet(normalized.ip, prefix, normalized.type);
		}
	}
	return list;
}

function getPeerIp(c: Context): { readonly ip: string; readonly type: IpType } | null {
	const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
	const remote = env?.incoming?.socket?.remoteAddress;
	if (!remote) return null;
	return normalizeIp(remote);
}

function resolveClientIp(c: Context, trusted: BlockList): string {
	const peer = getPeerIp(c);
	if (peer === null) return "unknown";

	if (trusted.check(peer.ip, peer.type)) {
		// Only trust a forwarded value that parses as a valid IP. Otherwise an
		// untrusted client behind the proxy could inject arbitrary
		// X-Forwarded-For/X-Real-IP strings to spoof another client's key or
		// churn the bounded rate-limit store (evicting legitimate entries).
		const forwarded = c.req.header("x-forwarded-for");
		const firstForwarded = forwarded?.split(",")[0]?.trim();
		const forwardedIp = firstForwarded ? normalizeIp(firstForwarded) : null;
		if (forwardedIp) return forwardedIp.ip;
		const realIp = c.req.header("x-real-ip")?.trim();
		const realIpNormalized = realIp ? normalizeIp(realIp) : null;
		if (realIpNormalized) return realIpNormalized.ip;
	}

	return peer.ip;
}

export type NotesRateClass = "create" | "read" | "exists" | "chunks";

/**
 * Classify a `/api/v1/notes…` path into the one rate-limit bucket that applies.
 *
 * Hono runs every middleware whose path matches, so registering these bounds as
 * layered `app.use()` rules made them stack: a chunk upload matched both the
 * chunk rule and the generic `/notes/*` rule, and the tighter bound won —
 * capping a chunked upload at 60 chunks/min and putting the advertised 500 MB
 * limit (125 chunks) out of reach. Selecting exactly one bucket per request
 * keeps each documented bound the one actually enforced.
 *
 * @param path Full request path, e.g. `/api/v1/notes/upload/abc/chunks/3`.
 */
export function classifyNotesPath(path: string): NotesRateClass {
	const sub = path.slice("/api/v1/notes".length).replace(/\/$/, "");
	if (sub.endsWith("/exists")) return "exists";
	if (/^\/upload\/[^/]+\/chunks\/[^/]+$/.test(sub)) return "chunks";
	if (sub === "" || sub === "/upload" || sub === "/upload/init") return "create";
	return "read";
}

export function createRateLimit(options: RateLimitOptions): RateLimitResult {
	const store = new Map<string, RateLimitStore>();
	const trusted = buildTrustedBlockList(options.trustedProxies ?? []);

	const cleanupInterval = Math.min(30_000, options.windowMs);
	const timer = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of store) {
			if (entry.resetAt <= now) {
				store.delete(key);
			}
		}
	}, cleanupInterval);

	const middleware: MiddlewareHandler = async (c: Context, next) => {
		const ip = resolveClientIp(c, trusted);
		const now = Date.now();
		const existing = store.get(ip);

		if (existing === undefined || existing.resetAt <= now) {
			if (store.size >= MAX_STORE_SIZE && existing === undefined) {
				// Bulk-evict every expired entry in one sweep: freeing all reusable
				// slots at once (instead of one per request) keeps a full store from
				// rejecting new clients under sustained traffic.
				for (const [key, entry] of store) {
					if (entry.resetAt <= now) {
						store.delete(key);
					}
				}
				if (store.size >= MAX_STORE_SIZE) {
					return c.json({ error: "Too many requests" }, 429);
				}
			}
			store.set(ip, { hits: 1, resetAt: now + options.windowMs });
			await next();
			return;
		}

		if (existing.hits >= options.max) {
			return c.json({ error: "Too many requests" }, 429);
		}

		store.set(ip, { hits: existing.hits + 1, resetAt: existing.resetAt });
		await next();
	};

	return { middleware, cleanup: () => clearInterval(timer) };
}
