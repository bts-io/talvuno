// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

// Served at the root of https://docs.talvuno.h1n054ur.dev as a Cloudflare Worker with static assets.
export default defineConfig({
	site: "https://docs.talvuno.h1n054ur.dev",
	markdown: {
		smartypants: false,
	},
	integrations: [
		// Diagrams are drawn in the reader's browser, so the build needs no headless browser.
		mermaid({ theme: "base", autoTheme: true }),
		starlight({
			title: "Talvuno",
			description: "Self-hosted softphone and two-way SMS for your Twilio numbers, on Cloudflare Workers.",
			favicon: "/favicon.ico",
			logo: {
				light: "./src/assets/logo-light.png",
				dark: "./src/assets/logo-dark.png",
				alt: "Talvuno",
				replacesTitle: true,
			},
			head: [
				{ tag: "meta", attrs: { property: "og:image", content: "https://docs.talvuno.h1n054ur.dev/og-image.png" } },
				{ tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
				{ tag: "meta", attrs: { property: "og:image:height", content: "630" } },
				{ tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
				{ tag: "meta", attrs: { name: "twitter:image", content: "https://docs.talvuno.h1n054ur.dev/og-image.png" } },
			],
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/bts-io/talvuno" }],
			customCss: ["./src/styles/custom.css"],
			sidebar: [
				{
					label: "Start here",
					items: [
						{ label: "Introduction", slug: "introduction" },
						{ label: "Getting started", slug: "getting-started" },
						{ label: "Twilio setup", slug: "twilio-setup" },
						{ label: "Single sign-on", slug: "single-sign-on" },
					],
				},
				{
					label: "Using Talvuno",
					items: [
						{ label: "The app", slug: "using" },
						{ label: "Notifications and installing", slug: "notifications" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "Security", slug: "security" },
						{ label: "Architecture", slug: "architecture" },
						{ label: "Development", slug: "development" },
						{ label: "FAQ and limitations", slug: "faq" },
					],
				},
			],
		}),
	],
});
