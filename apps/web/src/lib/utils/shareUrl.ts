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
 * Whether a URL fragment can be a note key: 32 bytes in unpadded base64url,
 * after `1.` for a format 1 note. 43 characters carry 258 bits, so the last
 * one's two low bits are 0: one of 16 characters. Checked before reading,
 * because a format 0 read is spent before the key is used — a link cut short
 * or mangled by a chat app would otherwise burn reads on a key that can never
 * work, each failure looking like a wrong password.
 */
export function isKeyFragment(fragment: string): boolean {
	return /^(1\.)?[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(fragment);
}
