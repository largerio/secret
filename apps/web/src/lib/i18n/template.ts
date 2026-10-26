export type Segment = { readonly text: string } | { readonly slot: string };

/**
 * Split a translated sentence around its `{placeholders}` so a component can
 * put controls or emphasis inside it ("Destroy after {reads} or in {expiry}").
 * Each language keeps its own word order: the slots follow the translation.
 */
export function splitTemplate(message: string): Segment[] {
	const segments: Segment[] = [];
	let last = 0;
	for (const match of message.matchAll(/\{(\w+)\}/g)) {
		if (match.index > last) segments.push({ text: message.slice(last, match.index) });
		// The pattern has one group, always set on a match.
		segments.push({ slot: String(match[1]) });
		last = match.index + match[0].length;
	}
	if (last < message.length) segments.push({ text: message.slice(last) });
	return segments;
}
