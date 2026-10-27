/**
 * Prometheus text exposition (format 0.0.4), no dependencies: counters, gauges
 * and histograms kept in memory and rendered on demand.
 *
 * Label values come from the code, from bounded sets (route patterns, never raw
 * paths): every distinct value is a series kept for the life of the process.
 *
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */

export type Labels = Readonly<Record<string, string>>;

export const EXPOSITION_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface Counter {
	/** Add `by` (default 1); `inc(labels, 0)` exposes a series before its first event. */
	inc(labels: Labels, by?: number): void;
}

export interface Gauge {
	set(labels: Labels, value: number): void;
	/** Drop every series, e.g. when the value can no longer be read. */
	reset(): void;
}

export interface Histogram {
	observe(labels: Labels, value: number): void;
}

export interface Registry {
	counter(name: string, help: string, labelNames?: readonly string[]): Counter;
	gauge(name: string, help: string, labelNames?: readonly string[]): Gauge;
	histogram(
		name: string,
		help: string,
		labelNames: readonly string[],
		buckets: readonly number[],
	): Histogram;
	/** Every family, in registration order, ending with a newline. */
	render(): string;
}

export function escapeHelp(text: string): string {
	return text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

export function escapeLabelValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function formatValue(value: number): string {
	if (value === Number.POSITIVE_INFINITY) return "+Inf";
	if (value === Number.NEGATIVE_INFINITY) return "-Inf";
	return String(value);
}

function formatLabels(labels: Labels): string {
	const pairs = Object.entries(labels).map(
		([name, value]) => `${name}="${escapeLabelValue(value)}"`,
	);
	return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}

/**
 * The declared labels only, in declaration order, so that `{a, b}` and
 * `{b, a}` are one series. A missing label is empty, as Prometheus reads it.
 */
function pick(labelNames: readonly string[], labels: Labels): Labels {
	return Object.fromEntries(labelNames.map((name) => [name, labels[name] ?? ""]));
}

export function createRegistry(): Registry {
	const families: Array<{ name: string; help: string; type: string; lines: () => string[] }> = [];

	function series<T>(
		name: string,
		help: string,
		type: string,
		labelNames: readonly string[],
		format: (labels: Labels, value: T) => string[],
	) {
		const entries = new Map<string, { labels: Labels; value: T }>();
		families.push({
			name,
			help,
			type,
			lines: () => [...entries.values()].flatMap((entry) => format(entry.labels, entry.value)),
		});
		return {
			update(labels: Labels, change: (current: T | undefined) => T): void {
				const picked = pick(labelNames, labels);
				const key = JSON.stringify(Object.values(picked));
				entries.set(key, { labels: picked, value: change(entries.get(key)?.value) });
			},
			clear(): void {
				entries.clear();
			},
		};
	}

	const sample = (name: string) => (labels: Labels, value: number) => [
		`${name}${formatLabels(labels)} ${formatValue(value)}`,
	];

	return {
		counter(name, help, labelNames = []) {
			const values = series(name, help, "counter", labelNames, sample(name));
			return {
				inc(labels, by = 1) {
					values.update(labels, (current) => (current ?? 0) + by);
				},
			};
		},

		gauge(name, help, labelNames = []) {
			const values = series(name, help, "gauge", labelNames, sample(name));
			return {
				set(labels, value) {
					values.update(labels, () => value);
				},
				reset: values.clear,
			};
		},

		histogram(name, help, labelNames, buckets) {
			interface Observations {
				readonly counts: number[];
				readonly sum: number;
				readonly count: number;
			}
			const values = series<Observations>(name, help, "histogram", labelNames, (labels, obs) => {
				let cumulative = 0;
				const lines = buckets.map((bound, index) => {
					cumulative += obs.counts[index] as number;
					return `${name}_bucket${formatLabels({ ...labels, le: formatValue(bound) })} ${String(cumulative)}`;
				});
				return [
					...lines,
					`${name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${String(obs.count)}`,
					`${name}_sum${formatLabels(labels)} ${formatValue(obs.sum)}`,
					`${name}_count${formatLabels(labels)} ${String(obs.count)}`,
				];
			});
			return {
				observe(labels, value) {
					values.update(labels, (current) => {
						// Per bucket here; render() makes them cumulative.
						const counts = current?.counts ?? buckets.map(() => 0);
						const index = buckets.findIndex((bound) => value <= bound);
						return {
							counts: counts.map((n, i) => (i === index ? n + 1 : n)),
							sum: (current?.sum ?? 0) + value,
							count: (current?.count ?? 0) + 1,
						};
					});
				},
			};
		},

		render() {
			const lines = families.flatMap((family) => [
				`# HELP ${family.name} ${escapeHelp(family.help)}`,
				`# TYPE ${family.name} ${family.type}`,
				...family.lines(),
			]);
			return `${lines.join("\n")}\n`;
		},
	};
}
