export interface ShareUrlParts {
	readonly scheme: string;
	readonly address: string;
	/** The fragment, `#` included: the decryption key. */
	readonly key: string;
}

/** Cut a share link where it reads best, so the key can be shown apart from the rest. */
export function splitShareUrl(url: string): ShareUrlParts {
	const hash = url.indexOf("#");
	const base = hash < 0 ? url : url.slice(0, hash);
	const schemeEnd = base.indexOf("://") + 3;
	return {
		scheme: base.slice(0, schemeEnd),
		address: base.slice(schemeEnd),
		key: hash < 0 ? "" : url.slice(hash),
	};
}

/**
 * Whether a URL fragment can be a note key: 32 bytes in unpadded base64url.
 * Checked before reading, because a read is spent before the key is used —
 * a link cut short by a chat app would otherwise burn reads on a key that
 * can never work, each failure looking like a wrong password.
 */
export function isKeyFragment(fragment: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(fragment);
}
