import { afterEach, describe, expect, it } from "vitest";
import { skipTo } from "../skipLink.js";

/** A page with a skip link to its main region, as the root layout renders one. */
function page() {
	const link = document.createElement("a");
	link.href = "#main-content";
	const main = document.createElement("main");
	main.id = "main-content";
	main.tabIndex = -1;
	document.body.append(link, main);
	return { link, main };
}

afterEach(() => {
	document.body.replaceChildren();
	history.replaceState(null, "", "/note/abc#1.key");
});

describe("skipTo", () => {
	it("moves the focus to the main region, and keeps the address as it is", () => {
		history.replaceState(null, "", "/note/abc#1.key");
		const { link, main } = page();
		link.addEventListener("click", (event) => skipTo(event, main));

		link.click();

		expect(document.activeElement).toBe(main);
		expect(location.hash).toBe("#1.key");
	});

	it("still keeps the address before the region exists", () => {
		const event = new MouseEvent("click", { cancelable: true });
		skipTo(event, undefined);

		expect(event.defaultPrevented).toBe(true);
	});
});
