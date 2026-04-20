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

function getPeerIp(c: Context): string | null {
	const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
	const remote = env?.incoming?.socket?.remoteAddress;
	if (!remote) return null;
	const normalized = normalizeIp(remote);
	return normalized?.ip ?? null;
}

function resolveClientIp(c: Context, trusted: BlockList): string {
	const peer = getPeerIp(c);
	if (peer === null) return "unknown";

	const peerNormalized = normalizeIp(peer);
	if (peerNormalized && trusted.check(peerNormalized.ip, peerNormalized.type)) {
		const forwarded = c.req.header("x-forwarded-for");
		const firstForwarded = forwarded?.split(",")[0]?.trim();
		if (firstForwarded) return firstForwarded;
		const realIp = c.req.header("x-real-ip")?.trim();
		if (realIp) return realIp;
	}

	return peer;
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
				let evicted = false;
				for (const [key, entry] of store) {
					if (entry.resetAt <= now) {
						store.delete(key);
						evicted = true;
						break;
					}
				}
				if (!evicted) {
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
