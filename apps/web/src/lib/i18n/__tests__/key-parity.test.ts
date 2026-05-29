import { describe, expect, it } from "vitest";
import de from "../../../../../../messages/de.json";
import en from "../../../../../../messages/en.json";
import es from "../../../../../../messages/es.json";
import fr from "../../../../../../messages/fr.json";
import itLocale from "../../../../../../messages/it.json";
import ja from "../../../../../../messages/ja.json";
import ko from "../../../../../../messages/ko.json";
import pt from "../../../../../../messages/pt.json";
import ru from "../../../../../../messages/ru.json";
import zh from "../../../../../../messages/zh.json";

// `en` is the source of truth for the set of message keys. Every other locale
// must expose exactly the same keys — no missing translations, no stale extras.
const locales: Record<string, Record<string, string>> = {
	fr,
	es,
	de,
	pt,
	it: itLocale,
	ja,
	zh,
	ru,
	ko,
};

const enKeys = Object.keys(en).sort();

describe("i18n key parity", () => {
	it("has a non-empty source locale", () => {
		expect(enKeys.length).toBeGreaterThan(0);
	});

	for (const [name, messages] of Object.entries(locales)) {
		it(`locale "${name}" has exactly the same keys as en`, () => {
			const keys = Object.keys(messages).sort();
			const missing = enKeys.filter((k) => !(k in messages));
			const extra = keys.filter((k) => !(k in en));
			expect(missing, `missing keys in "${name}"`).toEqual([]);
			expect(extra, `extra keys in "${name}"`).toEqual([]);
		});
	}
});
