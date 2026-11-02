import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFiles, auditPage, describeSeo, isHtmlPage } from "./seo.js";

/**
 * The local SEO reading of a page. Its job is to close the loop on the one thing a grounding
 * instruction cannot guarantee — that the tags were actually typed — without ever standing between
 * an author and saving their file.
 */

const GOOD = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Boulangerie Marceau — pains au levain à Lyon</title>
  <meta name="description" content="Boulangerie artisanale du 6e arrondissement : pains au levain naturel, viennoiseries pur beurre et fournées chaudes toute la journée.">
  <link rel="canonical" href="https://api.qu4zr.io/marceau/">
  <meta property="og:title" content="Boulangerie Marceau">
  <meta property="og:description" content="Pains au levain à Lyon 6e.">
  <meta property="og:image" content="https://api.qu4zr.io/marceau/og.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery"}</script>
</head>
<body>
  <h1>Boulangerie Marceau</h1>
  <img src="pain.jpg" alt="Une miche de pain au levain">
</body>
</html>`;

const BARE = `<!doctype html><html><head></head><body><p>hello</p></body></html>`;

const messages = (html: string, name = "pages/index.html") =>
  auditPage(name, html).map((f) => f.message).join("\n");

// ---- what counts as a page --------------------------------------------------

test("a complete page is recognised", () => {
  assert.equal(isHtmlPage("pages/index.html", GOOD), true);
});

test("a fragment is not a page and is never nagged", () => {
  // A partial templated in by files.read has no head of its own. Reporting a missing <title> on it
  // would be noise on every write, which is how a useful check gets ignored.
  const fragment = `<section><h2>Nos horaires</h2><p>7h-19h</p></section>`;
  assert.equal(isHtmlPage("pages/hours.html", fragment), false);
  assert.deepEqual(auditPage("pages/hours.html", fragment), []);
});

test("a stylesheet is not a page", () => {
  assert.equal(isHtmlPage("pages/app.css", "body{color:red}"), false);
});

// ---- the findings -----------------------------------------------------------

test("a page written properly has nothing to report", () => {
  assert.deepEqual(auditPage("pages/index.html", GOOD), []);
});

test("a bare page is told the four things an indexed page needs", () => {
  const errors = auditPage("pages/index.html", BARE).filter((f) => f.severity === "error");

  assert.deepEqual(errors.map((e) => e.code), [
    "seo.lang.missing",
    "seo.title.missing",
    "seo.description.missing",
    "seo.canonical.missing",
  ]);
});

test("every finding carries a code", () => {
  // The code is the shared vocabulary with the server's audit — a UI keys its "fix this" off it, and
  // SeoRuleParityTests holds this file to the server's catalogue.
  const findings = auditPage("pages/index.html", BARE);

  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => /^seo\.[a-z0-9_.]+$/.test(f.code)), JSON.stringify(findings.map((f) => f.code)));
});

test("a relative canonical is an error, not a pass", () => {
  // Both /{slug} and /{slug}/ serve the root, so a relative canonical settles nothing.
  const html = GOOD.replace('href="https://api.qu4zr.io/marceau/"', 'href="/marceau/"');

  const finding = auditPage("pages/index.html", html).find((f) => /canonical/.test(f.message));

  assert.equal(finding?.severity, "error");
  assert.match(finding!.message, /ABSOLUTE/);
});

test("an over-long title is a warning, not a blocker", () => {
  const long = "A".repeat(80);
  const html = GOOD.replace(/<title>[^<]*<\/title>/, `<title>${long}</title>`);

  const finding = auditPage("pages/index.html", html).find((f) => /<title>/.test(f.message));

  assert.equal(finding?.severity, "warning");
  assert.match(finding!.message, /80 chars/);
});

test("a title inside an inline SVG is not the page title", () => {
  // The head is read first precisely so an <svg><title> in the body can't stand in for it.
  const html = BARE.replace("<body>", "<body><svg><title>logo</title></svg>");

  assert.match(messages(html), /No <title>/);
});

test("an apostrophe does not end an attribute", () => {
  // Reading a double-quoted value up to "the next quote of either kind" cut
  // content="De l'atelier…" at the apostrophe and called a 137-character description 4 characters
  // long. In French that is every other sentence.
  const html = GOOD.replace(
    "Boulangerie artisanale du 6e arrondissement : pains au levain naturel, viennoiseries pur beurre et fournées chaudes toute la journée.",
    "De l'atelier de menuiserie de 1932 au fournil d'aujourd'hui : l'histoire du Pétrin Doré, boulangerie au levain de la Croix-Rousse à Lyon.",
  );

  assert.deepEqual(auditPage("pages/about.html", html).filter((f) => f.code.startsWith("seo.description")), []);
});

test("a single-quoted attribute is read to its own delimiter", () => {
  const html = GOOD.replace('<html lang="fr">', "<html lang='fr'>");

  assert.deepEqual(auditPage("pages/index.html", html).filter((f) => f.code === "seo.lang.missing"), []);
});

test("a commented-out tag does not count as present", () => {
  const html = GOOD.replace(/<link rel="canonical"[^>]*>/, "<!-- <link rel=\"canonical\" href=\"https://x/\"> -->");

  assert.match(messages(html), /canonical/);
});

test("two h1s and an image with no alt are reported", () => {
  const html = GOOD.replace("<h1>Boulangerie Marceau</h1>", "<h1>A</h1><h1>B</h1>").replace(
    'alt="Une miche de pain au levain"',
    "",
  );

  const text = messages(html);
  assert.match(text, /2 <h1>/);
  assert.match(text, /1 <img> without alt/);
});

// ---- the exemptions ---------------------------------------------------------

test("a page that declares noindex is exempt", () => {
  // The author has said this one is not for search. That is a legitimate page, and a better signal
  // than any flag the tool could offer.
  const html = BARE.replace("<head>", '<head><meta name="robots" content="noindex, nofollow">');

  assert.deepEqual(auditPage("pages/admin.html", html), []);
});

test('seo:"minimal" keeps the errors and drops the advice', () => {
  const findings = auditPage("pages/index.html", BARE, "minimal");

  assert.equal(findings.length, 4);
  assert.ok(findings.every((f) => f.severity === "error"));
});

test('seo:"none" says nothing at all', () => {
  assert.deepEqual(auditPage("pages/index.html", BARE, "none"), []);
});

// ---- payloads and rendering -------------------------------------------------

test("auditFiles reads every page in a payload and names each file", () => {
  const findings = auditFiles(
    [
      { name: "pages/index.html", content: GOOD },
      { name: "pages/about.html", content: BARE },
      { name: "utils.js", content: "function x(){}" },
    ],
    "minimal",
  );

  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.file === "pages/about.html"));
});

test("nothing to report renders no note at all", () => {
  // An empty advisory on every write trains the reader to skip the ones that matter.
  assert.equal(describeSeo([]), undefined);
});

test("the note groups by file and leads with the errors", () => {
  const note = describeSeo(auditPage("pages/index.html", BARE))!;
  const [, fileLine, firstFinding] = note.split("\n");

  assert.equal(fileLine, "pages/index.html");
  assert.match(firstFinding, /^ {2}!/);
});

test("several pages are listed under their own names", () => {
  const note = describeSeo(
    auditFiles([
      { name: "pages/index.html", content: BARE },
      { name: "pages/about.html", content: BARE },
    ]),
  )!;

  assert.match(note, /^pages\/index\.html$/m);
  assert.match(note, /^pages\/about\.html$/m);
  assert.match(note, /the pages were written/);
});
