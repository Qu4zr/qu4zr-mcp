/**
 * SEO checks for an HTML page, run locally when a page is written.
 *
 * Why here, and why advisory. A qu4zr site is HTML served verbatim, so whether it can be found is
 * decided entirely by what an assistant types into the file — and an instruction in the grounding
 * ("write a canonical tag") drifts, while a check that answers back does not. This is the same
 * shape as validate.ts: a local, fast, non-authoritative reading that closes the loop before the
 * next tool call instead of after the user notices in six weeks.
 *
 * Unlike validate.ts it NEVER blocks the write. A syntax error is a broken file; a missing meta
 * description is an unfinished one, and refusing to save it would leave a half-built page nowhere,
 * with an escape hatch the model would learn to reach for reflexively. The findings come back
 * attached to a successful write, which is enough to get them fixed.
 *
 * It is a text-level reading, not a parser, and it is NOT the authority. `SeoAudit` on the server is
 * (reachable as `POST /api/v1/seo/audit`, and as the `audit_seo` tool): it knows the same page rules
 * plus the ones that need more than one file — duplicate titles across pages, a canonical pointing
 * outside the site, a sitemap listing URLs it does not own. Where the two disagree, the server wins,
 * exactly as its syntax check wins over acorn here. This side may only ever be a SUBSET: a rule code
 * used here that the server does not know fails `SeoRuleParityTests`.
 */

export type SeoMode = "full" | "minimal" | "none";

export interface SeoFinding {
  /**
   * Stable identifier, e.g. `seo.canonical.missing`. The same vocabulary the server's audit emits —
   * every code used here must exist in `SeoAudit.Rules` (held by `SeoRuleParityTests`), so a client
   * can never report a rule the authority has never heard of.
   */
  code: string;
  file: string;
  /** "error" = an indexed page needs this; "warning" = it will rank/present better with it. */
  severity: "error" | "warning";
  message: string;
}

export interface CheckablePage {
  name?: string;
  content?: string;
}

/** Title length Google renders before truncating, near enough. */
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;

const stripComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "");

/**
 * The value of one attribute on one tag, or undefined. Quoted values only — we write the pages.
 *
 * The value runs to the MATCHING delimiter (backreference), not to the next quote of either kind:
 * `content="De l'atelier…"` was being cut at the apostrophe and reported as 4 characters long. In
 * French that is every other sentence.
 */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag);
  return m?.[2];
}

/** The first tag matching a pattern, as raw text. */
const tag = (html: string, pattern: RegExp): string | undefined => pattern.exec(html)?.[0];

/** A `<meta name="x">` (or `property="x"`, for Open Graph) tag's content. */
function meta(html: string, key: string): string | undefined {
  const found = new RegExp(`<meta\\b[^>]*\\s(?:name|property)\\s*=\\s*["']${key}["'][^>]*>`, "i").exec(html);
  return found ? (attr(found[0], "content") ?? "") : undefined;
}

/**
 * Whether this file is a WHOLE PAGE. A fragment — a partial templated in by `files.read`, an email
 * body, a widget — has no head of its own and must not be nagged about one.
 */
export function isHtmlPage(name?: string, content?: string): boolean {
  if (!name || !content) return false;
  if (!/\.html?$/i.test(name)) return false;
  return /<!doctype\s+html/i.test(content) || /<html[\s>]/i.test(content);
}

/**
 * A page that declares itself noindex is exempt: the author has said this one is not for search,
 * which is a legitimate thing for a page to be and a better signal than any flag we could add.
 */
function isNoIndex(html: string): boolean {
  const robots = meta(html, "robots") ?? meta(html, "googlebot");
  return !!robots && /\bnoindex\b/i.test(robots);
}

/** Checks one page. Returns [] when there is nothing to say. */
export function auditPage(name: string, content: string, mode: SeoMode = "full"): SeoFinding[] {
  if (mode === "none" || !isHtmlPage(name, content)) return [];

  const html = stripComments(content);
  if (isNoIndex(html)) return [];

  const findings: SeoFinding[] = [];
  const error = (code: string, message: string) => findings.push({ code, file: name, severity: "error", message });
  const warn = (code: string, message: string) => findings.push({ code, file: name, severity: "warning", message });

  // <head> when there is one: a <title> inside an inline SVG is not the page's title, and looking
  // only at the head is the cheapest way not to mistake one for the other.
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html;
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;

  // ---- the four an indexed page cannot do without ----------------------------

  const lang = attr(tag(html, /<html\b[^>]*>/i) ?? "", "lang");
  if (!lang?.trim()) {
    error("seo.lang.missing", '<html> has no lang attribute — say which language the page is in, e.g. <html lang="fr">.');
  }

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim();
  if (!title) {
    error("seo.title.missing", "No <title> — it is the headline of every search result and browser tab.");
  } else if (title.length > TITLE_MAX) {
    warn("seo.title.too_long", `<title> is ${title.length} chars; it gets truncated past about ${TITLE_MAX}. Put the distinctive words first.`);
  }

  const description = meta(head, "description")?.trim();
  if (description === undefined || description === "") {
    error("seo.description.missing", `No <meta name="description"> — write ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} chars for a human; it is the snippet under the link.`);
  } else if (description.length < DESCRIPTION_MIN) {
    warn("seo.description.too_short", `<meta name="description"> is ${description.length} chars — under ${DESCRIPTION_MIN} it usually gets replaced by scraped page text.`);
  } else if (description.length > DESCRIPTION_MAX) {
    warn("seo.description.too_long", `<meta name="description"> is ${description.length} chars; it gets truncated past about ${DESCRIPTION_MAX}.`);
  }

  const canonical = attr(tag(head, /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i) ?? "", "href");
  if (!canonical?.trim()) {
    error(
      "seo.canonical.missing",
      'No <link rel="canonical"> — the same page answers at both /{slug} and /{slug}/, so it has to ' +
        "name which URL counts. Use the absolute URL.",
    );
  } else if (!/^https?:\/\//i.test(canonical.trim())) {
    error("seo.canonical.relative", `<link rel="canonical" href="${canonical}"> must be an ABSOLUTE URL (https://…), or it settles nothing.`);
  }

  if (mode === "minimal") return findings;

  // ---- the rest: presentation, crawlability, sharing -------------------------

  if (!meta(head, "viewport")) {
    warn("seo.viewport.missing", 'No <meta name="viewport"> — mobile rendering is a ranking signal; use width=device-width, initial-scale=1.');
  }

  if (!/<meta\b[^>]*\bcharset\s*=/i.test(head)) {
    warn("seo.charset.missing", 'No <meta charset="utf-8"> — accented characters are a coin flip without it.');
  }

  const og = ["og:title", "og:description", "og:image"].filter((k) => !meta(head, k));
  if (og.length > 0) {
    warn("seo.opengraph.missing", `Missing Open Graph tags (${og.join(", ")}) — this is what a link to the page looks like when shared.`);
  }

  const h1s = body.match(/<h1[\s>]/gi)?.length ?? 0;
  if (h1s === 0) {
    warn("seo.h1.missing", "No <h1> — every page needs one heading that states what it is.");
  } else if (h1s > 1) {
    warn("seo.h1.multiple", `${h1s} <h1> elements — use one, then <h2>/<h3> beneath it.`);
  }

  const imagesWithoutAlt = (body.match(/<img\b[^>]*>/gi) ?? []).filter((t) => !/\salt\s*=/i.test(t)).length;
  if (imagesWithoutAlt > 0) {
    warn("seo.image.alt_missing", `${imagesWithoutAlt} <img> without alt — describe the image, or alt="" if it is decorative.`);
  }

  if (!/<script\b[^>]*type\s*=\s*["']application\/ld\+json["']/i.test(html)) {
    warn("seo.jsonld.missing", 'No JSON-LD (<script type="application/ld+json">) — the structured data behind rich results.');
  }

  return findings;
}

/** Checks every page in a content payload. */
export function auditFiles(files?: CheckablePage[], mode: SeoMode = "full"): SeoFinding[] {
  const findings: SeoFinding[] = [];
  for (const file of files ?? []) {
    if (file.name && file.content) findings.push(...auditPage(file.name, file.content, mode));
  }
  return findings;
}

/**
 * The advisory attached to a successful write. Undefined when there is nothing to say — an empty
 * note on every write would train the reader to skip the ones that matter.
 */
export function describeSeo(findings: SeoFinding[]): string | undefined {
  if (findings.length === 0) return undefined;

  // Grouped by file, errors first within each: one page's list should read as one list, and a
  // payload of five pages should not interleave into a wall nobody acts on.
  const files = [...new Set(findings.map((f) => f.file))];
  const body = files
    .map((file) => {
      const mine = findings.filter((f) => f.file === file);
      const ordered = [...mine.filter((f) => f.severity === "error"), ...mine.filter((f) => f.severity === "warning")];
      return `${file}\n` + ordered.map((f) => `  ${f.severity === "error" ? "!" : "-"} ${f.message}`).join("\n");
    })
    .join("\n");

  return (
    `SEO — ${files.length === 1 ? "the page was" : "the pages were"} written; ` +
    "this is what is still missing for them to be findable:\n" +
    body +
    "\n(! = an indexed page needs it, - = it will present or rank better with it. " +
    "Fix them with another write_file. A page that is deliberately not for search can say so with " +
    '<meta name="robots" content="noindex">, and is then exempt; pass seo:"none" to skip this check.)'
  );
}
