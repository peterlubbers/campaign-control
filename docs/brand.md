# Product defaults and company branding

**Campaign Control owns the tool. Fictitious AI owns the example campaign.** The workbench adopts the selected company’s theme while keeping its product name and copy.

| Location | Owner and purpose |
| --- | --- |
| [brand/identity.json](../brand/identity.json) | Campaign Control defaults: slate surfaces, soft blue interface accent, Arial, and a neon-blue boxed Relay symbol. No Fictitious AI logo. |
| [fictitious-ai/brand/](../fictitious-ai/brand/) | Fictitious AI’s electric-blue theme and signal logo. Used by its campaign and its Campaign Control workspace. |
| [launch-control.config.json](../launch-control.config.json) | Selects the company identity through `campaign.brand`. Omit that field for product defaults. |

`campaign.brand` is an identity JSON path relative to the config file. The application reads it at startup and passes the same selected identity to the interface and renderers. Restart after configuration or brand changes. A different `--campaign` or `LAUNCH_CAMPAIGN_DIR` override uses product defaults, so another company never accidentally inherits Fictitious AI’s logo. Use a custom configuration to pair that campaign with its own brand.

Home shows the boxed Relay symbol before **Campaign Control**. Relay is the approved option A: one input branching into three channels, using electric blue `#00B2FF`. The [standalone SVG](../brand/relay-mark.svg), browser icon, app header, repository header, and native title slide use this mark. Inside a campaign, the header shows the selected company identity once, while the location label and browser title retain **Campaign Control**. The product name also stays in the footer. The generic `/brand/logo.svg` and `/brand.css` endpoints serve the selected identity; there is no company-specific route in the tool.

Product copy remains:

> Agentic campaign updates.<br>
> Inhuman scale. Human control.

Those lines describe Campaign Control. They are not Fictitious AI campaign headlines. Its existing copy, Pro500 facts, and requested Pro1000 change remain separate from styling.

The Fictitious AI signal mark is three rising bars with a detached spark. Its original identity JSON and [SVG](../fictitious-ai/brand/fictitious-ai.svg) moved without changing their bytes, preserving the existing media and native Slides identity fingerprint. Previously recorded visual reviews remain point-in-time evidence, not new verification of the remote deck. Detailed session verification records remain local.

Company themes support the existing six color tokens, fonts, and optional rectangle-based logo geometry. A missing or malformed configured identity is an error, not a silent brand substitution. Templates stay simple; arbitrary SVG imports and a theme editor are outside this change.

Render changes into new versions. Changing the selected identity on restart invalidates an existing current approval. The publisher must review the new representations before a new release. Styling never changes product facts or authorizes publication.

## Product rename compatibility

The product is **Campaign Control**, with a boxed Relay symbol. The checkout is `campaign-control/`. Existing configuration filenames, `.launch-control/` private state, environment variable names, HTTP service identifiers, and CSRF headers remain compatible with running sessions. They are internal compatibility identifiers, not the displayed product name. Historical provenance and the example company identity remain byte-preserved. Its unused `copy.productName` value records the earlier product name; app copy comes from the current product identity and interface. Changing that company identity would invalidate previously verified campaign media, so this product rename does not rewrite it.
