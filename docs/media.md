# Campaign rendering

Authored during the October 3, 2026 build. The campaign Markdown, renderer, and Swift encoder were created in this build; no prior campaign files or video helpers were imported.

`renderAsset({asset, markdown, outputDir, facts})` reads the exact supplied Markdown. It returns a file manifest, a primary preview, the full input text, and checks with `pass` or `blocked` status. Output paths are relative to the caller's absolute output directory. Callers must allocate contained candidate directories and package only returned files after approval.

| Asset | Produced files |
| --- | --- |
| Website, email, support, partner, ordinary sales collateral | Exact editable Markdown and escaped HTML review |
| Social/display graphic | Editable SVG driven by headline, main copy, and call to action; complete caption remains in Markdown and HTML |
| Video | H.264 MP4, WebVTT, SVG and decoded PNG thumbnails, YouTube metadata in Markdown and JSON, timed scene source, decoded frame proofs, verification report |
| PDF sales collateral | Actual PDF, first-page preview and extracted-text verification; failure blocks release |
| Presentation | HTML copy review; native Google Slides reference required for completion |

Every asset also receives a render manifest that binds its source hash, shared brand identity hash, output filenames, declared facts, checks, and actual creation time. HTML and SVG escape supplied content; raw asset text is never executed as markup or code. No renderer publishes or uploads anything.

## Publisher metadata across channels

Every asset requires one `## Publisher metadata` section. Write a single `lowercase_snake_case: value` field per line; indent continued values by two spaces. This is plain text, not executable YAML. Additional fields are retained. Missing blocks, duplicate keys, malformed lines, or empty required fields block the bundle.

| Channel | Required fields |
| --- | --- |
| Website | `page_title`, `meta_description`, `url_path` |
| Email | `subject`, `preheader`, `sender_name` |
| Social | `platform`, `post_caption`, `alt_text`, `hashtags` |
| Paid | `placement`, `ad_headline`, `ad_description`, `call_to_action`, `destination_instruction` |
| Video | `platform`, `visibility`, `audience_instruction`, `rights_instruction` |
| Sales | `document_title`, `audience`, `distribution_instruction` |
| Support | `article_title`, `article_summary`, `help_center_path` |
| Partners | `listing_title`, `partner_description`, `distribution_instruction` |
| In-product | `surface`, `message_title`, `message_body`, `call_to_action`, `targeting_instruction` |
| Events | `event_title`, `event_format`, `audience`, `registration_instruction` |
| Press | `release_title`, `summary`, `media_contact_instruction`, `release_instruction` |

The renderer exports `publisher-metadata.md` and `publisher-metadata.json` under the same logical asset ID. The JSON contains the complete source SHA-256, channel, unpublished handoff status, and input-derived fields. A metadata-only edit changes the source binding and therefore requires the normal candidate review. Metadata is included in `textContent` and the preserved source Markdown for the caller's full-content audit.

Publisher sections do not appear in the visible page, graphic, or video body. Website page titles/descriptions and support article titles/summaries become properly escaped HTML head metadata. All other fields remain reviewable handoff companions rather than invented live destinations or applied publishing settings. Videos additionally retain their YouTube-specific title, description, tags, chapters, and instructions as separate companions; these canonical values are not duplicated in the universal section.

## Video contract

Each video source uses headings such as `## Scene 1 | 00-06`, followed by the on-screen headline and body. Scenes must start at zero, be contiguous, and total no more than 180 seconds. Separate sections contain YouTube title, YouTube description, Tags, Chapters, and Publisher instructions. Missing metadata blocks the complete bundle. Publisher instructions never become on-screen scene copy.

The encoder creates 1280×720 video at 24 fps. It animates text entry, a background detail, and scene progress. Videos are deliberately silent; captions describe the on-screen copy. They are not narrated footage. Chapter sections are editorial outlines; platform eligibility is not asserted.

The encoder reads back the actual MP4, checks duration and frame rate, and decodes a midpoint frame from every scene. The first decoded frame becomes `thumbnail.png`; later scene proofs are review evidence. These are checks of the actual encoded file, not a claim that text review alone verifies a video.

Current production support requires macOS, AVFoundation, and Swift/Xcode Command Line Tools. The Node application itself uses built-in modules. A compiled encoder is cached in the operating system's temporary directory under a hash of its fresh source. The application reports a blocked video when the compiler, media service, layout, or bundle is unavailable. It does not replace a failed video with a claimed success.

## Native Google Slides

Only `metadata.presentation === true` requires a native presentation. Ordinary sales one-pagers, talk tracks, and FAQs can remain HTML collateral.

A verified reference has the following fields under `metadata.nativeSlides`: `url`, `presentationId`, `verified: true`, `verifiedAtUTC`, `contentSha256`, and `brandIdentitySha256`. The content hash must match the exact supplied Markdown, and the brand hash must match the current shared identity. A stale or missing hash blocks the presentation. The integration recording this evidence must verify the real deck contents; setting a Boolean is not verification. Native references do not grant sharing access or freeze later Google Slides edits.

Brand text comes from `metadata.brand`; a neutral “Campaign” label is used when absent. A video's small category line comes from `metadata.categoryLabel`. Product names, prices, sharing terms, scene text, and YouTube metadata come from the supplied Markdown, not replacement strings embedded in the renderer. Asset styling imports `BRAND` and `BRAND_HASH` from `lib/brand.mjs`, backed by `brand/identity.json`. HTML, graphics, and native Slides use the industrial-blue graphite, steel, silver, white, muted, and electric-blue palette with upright Arial/Helvetica typography. Fictitious AI assets use the approved rising-bar signal mark; another organization receives its own label without that mark. Campaign Control workflow copy is not injected into product collateral. Video scene input carries the same palette, font names, logo rectangle geometry, and identity hash into Swift. The encoder converts top-down SVG logo coordinates into its frame coordinates rather than duplicating logo or color definitions.

## Verified original campaign

The initial 104 Pro500 originals had 621 generated files across 11 channels. The active manifest now selects refreshed bundles for six simplified inputs, including the PDF battlecard; superseded bundles have been removed. The active manifest selects 629 media/companion files. Six videos were encoded and decoded successfully at 18 seconds, 1280×720, 24 fps, with no audio tracks. All 18 midpoint scene images were visually inspected. Measured text bounds found no clipping or overlaps in 46 SVG graphics and thumbnails.

SAL-001 is now a PDF sales battlecard, authorized after the full-run rehearsal exposed the unfinished native Slides revision path. Obsolete native deck snapshots were removed at Peter’s request during the demo reset and archive purge. The hackathon presentation remains in Google Slides. PDF generation uses the existing macOS/Swift toolchain, measures text before drawing, and reopens the result with PDFKit to verify every visible source block. Its PNG preview comes from the actual PDF. Sources and publisher metadata stay separate; only the PDF and metadata enter releases.

Renderer tests cover input preservation, HTML safety, input-driven graphics, content-bound native references, scene/metadata separation, all eleven metadata schemas, metadata-only edits, malformed input and the 104-source inventory. Run the current suite with `npm test`.

Publisher metadata, captions, thumbnails and video files stay together. New revisions use `working/v001/`; approved deliverables use `releases/v001/`, with a `READY-TO-PUBLISH` shortcut for the approved release. Only finished deliverables and publisher companions enter the release. Sources and internal review evidence remain in the workspace.
