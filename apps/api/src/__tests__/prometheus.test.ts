import { describe, expect, it } from "vitest";
import {
	createRegistry,
	EXPOSITION_CONTENT_TYPE,
	escapeHelp,
	escapeLabelValue,
	formatValue,
} from "../prometheus.js";

describe("createRegistry", () => {
	it("renders each family with its HELP and TYPE, in registration order", () => {
		const registry = createRegistry();
		const requests = registry.counter("app_requests_total", "Requests served.", ["route"]);
		const temperature = registry.gauge("app_temperature_celsius", "Current temperature.");

		requests.inc({ route: "/a" });
		requests.inc({ route: "/a" }, 2);
		requests.inc({ route: "/b" }, 0);
		temperature.set({}, -1.5);

		expect(registry.render()).toBe(
			[
				"# HELP app_requests_total Requests served.",
				"# TYPE app_requests_total counter",
				'app_requests_total{route="/a"} 3',
				'app_requests_total{route="/b"} 0',
				"# HELP app_temperature_celsius Current temperature.",
				"# TYPE app_temperature_celsius gauge",
				"app_temperature_celsius -1.5",
				"",
			].join("\n"),
		);
	});

	it("keeps a family without samples to its HELP and TYPE", () => {
		const registry = createRegistry();
		registry.gauge("app_last_run_timestamp_seconds", "Last run.");

		expect(registry.render()).toBe(
			"# HELP app_last_run_timestamp_seconds Last run.\n# TYPE app_last_run_timestamp_seconds gauge\n",
		);
	});

	it("orders labels as declared and treats a missing one as empty", () => {
		const registry = createRegistry();
		const counter = registry.counter("app_total", "Help.", ["method", "status"]);

		counter.inc({ status: "2xx", method: "GET" });
		counter.inc({ method: "GET", status: "2xx", extra: "dropped" });
		counter.inc({ method: "POST" });

		expect(registry.render()).toContain(
			'app_total{method="GET",status="2xx"} 2\napp_total{method="POST",status=""} 1\n',
		);
	});

	it("escapes label values and help text", () => {
		const registry = createRegistry();
		registry
			.gauge("app_info", 'A \\ backslash\nand "quotes".', ["version"])
			.set({ version: 'say "hi"\\\n' }, 1);

		const text = registry.render();

		expect(text).toContain('# HELP app_info A \\\\ backslash\\nand "quotes".\n');
		expect(text).toContain('app_info{version="say \\"hi\\"\\\\\\n"} 1\n');
	});

	it("replaces a gauge's value and drops every series on reset", () => {
		const registry = createRegistry();
		const gauge = registry.gauge("app_items", "Items.", ["state"]);

		gauge.set({ state: "queued" }, 4);
		gauge.set({ state: "queued" }, 2);
		expect(registry.render()).toContain('app_items{state="queued"} 2\n');

		gauge.reset();
		expect(registry.render()).not.toContain("app_items{");
	});

	it("renders histograms with cumulative buckets, +Inf, sum and count", () => {
		const registry = createRegistry();
		const histogram = registry.histogram(
			"app_duration_seconds",
			"Durations.",
			["route"],
			[0.25, 1],
		);

		histogram.observe({ route: "/a" }, 0.0625);
		histogram.observe({ route: "/a" }, 0.5);
		// A bucket's bound is inclusive.
		histogram.observe({ route: "/a" }, 0.25);
		histogram.observe({ route: "/a" }, 3);

		expect(registry.render()).toBe(
			[
				"# HELP app_duration_seconds Durations.",
				"# TYPE app_duration_seconds histogram",
				'app_duration_seconds_bucket{route="/a",le="0.25"} 2',
				'app_duration_seconds_bucket{route="/a",le="1"} 3',
				'app_duration_seconds_bucket{route="/a",le="+Inf"} 4',
				'app_duration_seconds_sum{route="/a"} 3.8125',
				'app_duration_seconds_count{route="/a"} 4',
				"",
			].join("\n"),
		);
	});

	it("renders an unlabelled histogram without empty braces", () => {
		const registry = createRegistry();
		registry.histogram("app_wait_seconds", "Waits.", [], [1]).observe({}, 2);

		expect(registry.render()).toContain(
			'app_wait_seconds_bucket{le="1"} 0\napp_wait_seconds_bucket{le="+Inf"} 1\napp_wait_seconds_sum 2\napp_wait_seconds_count 1\n',
		);
	});
});

describe("exposition helpers", () => {
	it("formats the special float values the way Prometheus parses them", () => {
		expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
		expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
		expect(formatValue(Number.NaN)).toBe("NaN");
		expect(formatValue(1_700_000_000.25)).toBe("1700000000.25");
	});

	it("escapes only what the format requires", () => {
		expect(escapeHelp('a\\b\nc"d')).toBe('a\\\\b\\nc"d');
		expect(escapeLabelValue('a\\b\nc"d')).toBe('a\\\\b\\nc\\"d');
	});

	it("advertises the text format", () => {
		expect(EXPOSITION_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
	});
});
