import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			out: "build",
		}),
		csp: {
			mode: "auto",
			directives: {
				"default-src": ["none"],
				"script-src": ["self", "wasm-unsafe-eval"],
				"style-src": ["self", "unsafe-inline", "https://cdnjs.cloudflare.com"],
				"img-src": ["self", "data:", "blob:"],
				"connect-src": ["self"],
				"font-src": ["self", "https://cdnjs.cloudflare.com"],
				"worker-src": ["self", "blob:"],
				"media-src": ["self", "blob:"],
				"frame-src": ["blob:"],
				"object-src": ["none"],
				"frame-ancestors": ["none"],
				"base-uri": ["self"],
				"form-action": ["self"],
			},
		},
	},
};

export default config;
