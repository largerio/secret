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
				"style-src": ["self", "unsafe-inline", "https://fonts.googleapis.com"],
				"img-src": ["self", "data:", "blob:"],
				"connect-src": ["self"],
				"font-src": ["self", "https://fonts.gstatic.com"],
				"worker-src": ["self", "blob:"],
				"media-src": ["self", "blob:"],
				"frame-src": ["blob:"],
				"object-src": ["none"],
				"frame-ancestors": ["none"],
				"base-uri": ["self"],
				// The app never submits a form (the one <form> calls preventDefault),
				// so 'none' costs nothing and closes the exfiltration path a note
				// author could otherwise build with injected markup.
				"form-action": ["none"],
				"upgrade-insecure-requests": true,
			},
		},
	},
};

export default config;
