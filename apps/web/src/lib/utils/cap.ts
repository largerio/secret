import { t } from "$lib/i18n/index.svelte";

export async function solveCap(): Promise<string> {
	window.CAP_CUSTOM_WASM_URL = "/wasm/cap_wasm_bg.wasm";
	const Cap = (await import("@cap.js/widget")).default;
	const capClient = new Cap({ apiEndpoint: "/api/cap/" });
	const result = await capClient.solve();
	if (!result.success || !result.token) {
		throw new Error(t("error_generic"));
	}
	return result.token;
}
