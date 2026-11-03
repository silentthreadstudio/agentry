/**
 * jsonld.ts — schema.org structured data for the head. Pure builders: no I/O, no Astro.
 * Nothing here carries ratings, reviews or counts; only facts the plugin states about itself.
 */
import { PUBLISHER, REPO_URL, SITE_DESCRIPTION, SITE_NAME } from "./site.ts";

export type JsonLd = Record<string, unknown>;

/** The home page's `SoftwareApplication`. `siteUrl` is the canonical origin + base, ending in "/". */
export function softwareApplication(siteUrl: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${siteUrl}#software`,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: siteUrl,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any operating system that runs Claude Code",
    softwareRequirements: "Claude Code; Node.js 24 or newer",
    license: "https://spdx.org/licenses/MIT.html",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    sameAs: [REPO_URL],
    publisher: { "@type": "Organization", name: PUBLISHER.name, url: PUBLISHER.url },
  };
}

/** The home page's `WebSite`. */
export function webSite(siteUrl: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteUrl}#website`,
    name: SITE_NAME,
    url: siteUrl,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@type": "Organization", name: PUBLISHER.name, url: PUBLISHER.url },
  };
}

/** A `BreadcrumbList`; every crumb is `{ name, url }` with an absolute URL. */
export function breadcrumbs(crumbs: { name: string; url: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

/** Serialise for an inline `<script type="application/ld+json">` (a `<` can never close it). */
export function serialise(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
