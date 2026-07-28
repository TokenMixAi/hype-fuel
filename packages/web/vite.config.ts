import {defineConfig, type Plugin} from "vite";
import react from "@vitejs/plugin-react";

import {
  FAQ,
  PRODUCT_NAME,
  ROUTES,
  SITE_DESCRIPTION,
  SITE_TITLE,
  SITE_URL,
  SOCIAL_DESCRIPTION,
  SOCIAL_TITLE,
} from "./src/content/site";

/**
 * Writes a real HTML file per route, so `/docs` and `/app` are served with their own title,
 * description and canonical rather than the landing page's.
 *
 * This exists because social crawlers and unfurlers do not run React, so `useDocumentMeta` is
 * invisible to them: a shared `/docs` link would have carried the homepage's title and claimed the
 * homepage as its canonical URL. Cloudflare's asset handler resolves `/docs` to `docs/index.html`
 * before the single-page-application fallback, so each route gets correct markup on a cold load and
 * the router takes over from there.
 */
function perRouteHtml(): Plugin {
  return {
    name: "hypefuel-per-route-html",
    enforce: "post",
    apply: "build",

    /*
     * Reads the finished index.html back out of the bundle, so each variant inherits its hashed
     * asset URLs and the injected JSON-LD. `enforce: "post"` is what places this after Vite's own
     * HTML plugin has emitted it.
     */
    generateBundle(_options, bundle) {
      const entry = bundle["index.html"];
      if (!entry || entry.type !== "asset" || typeof entry.source !== "string") {
        this.warn("index.html was not in the bundle, so no per-route HTML was written");
        return;
      }

      for (const route of ROUTES) {
        if (route.path === "/") continue;

        // replaceAll throughout: the social title and description each appear twice, once for Open
        // Graph and once for Twitter.
        const variant = entry.source
          .replaceAll(SITE_TITLE, escapeHtml(route.title))
          .replaceAll(SITE_DESCRIPTION, escapeHtml(route.description))
          .replaceAll(SOCIAL_TITLE, escapeHtml(route.socialTitle ?? route.title))
          .replaceAll(SOCIAL_DESCRIPTION, escapeHtml(route.socialDescription ?? SOCIAL_DESCRIPTION))
          // Quoted and origin-only, so the og:image URL is left alone.
          .replaceAll(`"${SITE_URL}/"`, `"${SITE_URL}${route.path}"`);

        this.emitFile({
          type: "asset",
          fileName: `${route.path.replace(/^\//, "")}/index.html`,
          source: variant,
        });
      }
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Emits structured data and a sitemap from `src/content/site.ts`.
 *
 * Generating rather than hand-writing them is the point: the FAQ that Google reads is the same
 * array the landing page renders, so an answer cannot be reworded in one place and left stale in
 * the other.
 */
function seoAssets(): Plugin {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        "@id": `${SITE_URL}/#app`,
        name: PRODUCT_NAME,
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Any",
        browserRequirements: "Requires an EVM wallet",
        // Using it is free; the 3% is taken out of the swap itself rather than charged up front.
        offers: {"@type": "Offer", price: "0", priceCurrency: "USD"},
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/#faq`,
        mainEntity: FAQ.map((entry) => ({
          "@type": "Question",
          name: entry.q,
          acceptedAnswer: {"@type": "Answer", text: entry.a},
        })),
      },
    ],
  };

  return {
    name: "hypefuel-seo-assets",

    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: {type: "application/ld+json"},
          children: JSON.stringify(jsonLd),
          injectTo: "head",
        },
      ];
    },

    generateBundle() {
      const lastmod = new Date().toISOString().slice(0, 10);
      const urls = ROUTES.map(
        (route) =>
          "  <url>\n" +
          `    <loc>${SITE_URL}${route.path}</loc>\n` +
          `    <lastmod>${lastmod}</lastmod>\n` +
          `    <priority>${route.priority}</priority>\n` +
          "  </url>",
      ).join("\n");

      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source:
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          `${urls}\n` +
          "</urlset>\n",
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), seoAssets(), perRouteHtml()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
