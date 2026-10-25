# Coworkers design record

Recorded on 2026-10-04 from the local functional prototype. This is an ordinary
extension of CloseYourIt, not a new visual identity or a production component release.
The shared `closeyourit-docs/PRODUCT.md` and `closeyourit-docs/DESIGN.md` remain the
authority. No root design document or system sidecar was created or changed.

## Evidence and scope

- Direction: [Coworkers brief](coworkers-brief.md).
- Shipped source: [HTML](../../prototypes/coworkers/public/index.html),
  [behavior](../../prototypes/coworkers/public/app.js),
  [translations](../../prototypes/coworkers/public/locales.js), and
  [stylesheet source](coworkers.tokens.css).
- Visual evidence: [desktop](../../.impeccable/review/desktop.png),
  [390px conversation](../../.impeccable/review/mobile.png), and
  [390px tasks](../../.impeccable/review/mobile-tasks.png). These are captures of the
  local prototype, not generated illustrations or fabricated product data.
- Runtime boundaries and integration evidence are maintained in the
  [prototype README](../../prototypes/coworkers/README.md). This design record does
  not certify task results or repeat the backend validation.

The source and screenshots were inspected without opening a browser. The independent
finish reviewer returned **ship** for the four reviewed fixes: state semantics,
incumbent accent, 44px primary phone targets, and Enter/Shift+Enter behavior. All four
were resolved with no material regression in that scope. This is not a full production
design-system or accessibility certification.

## Overview

The inherited Engineering Notebook world remains visible: neutral paper around white
working surfaces, thin rules, restrained indigo and compact readable text. The approved
surface keeps persistent Dots on the left, conversation in the center, and tasks behind
an explicit control. Memory opens in a dialog. On phones, a Dot selector replaces the
list and the task view replaces the conversation until closed.

The prototype uses real local history and explicit empty states. Its task state
`completed` is translated as “Response ready,” not a claim that the user's goal has
been independently verified. The local entry page and footer explicitly identify the
experiment; production navigation remains future Rails integration.

## Colors

Paper, white surfaces, stone borders and zinc text reuse the incumbent palette roles.
The stylesheet explicitly pins the incumbent indigo values: action `#4f46e5`, strong
text `#4338ca`, soft selection `#eef2ff`, and selected border `#e0e7ff`. This preserves
the incumbent accent despite the current Tailwind palette's generated color format.

Indigo marks actions, selection and Dot authorship. Warnings use amber and errors use
red. State names remain readable text. Successful completion and requested stop
notifications use a neutral surface rather than warning styling. Task error details
can still appear in red after a requested stop; this is an observed local behavior,
not a new semantic-color rule.

## Typography

Atkinson Hyperlegible Next is loaded locally at weight 400, with the incumbent sans
fallback stack. The WOFF2 is byte-identical to the Rails asset
`app/assets/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2`:
SHA-256 `5cb240a4d99ab7e6fc3a4d4e6d11d89789fdffe9c86a8384000d662c53283f6f`.
The [SIL Open Font License](../../prototypes/coworkers/FONT-LICENSE.txt) accompanies it.

Observed sizes are 14px body, 12px labels, 16px section titles, 18px dialog title,
22px conversation empty-state title, 24px local-home title and 11px footer. Reading
copy uses a 24px line height in the thread and field explanations. Semibold labels
use CSS weight 600; only the regular font file is bundled. No separate Mono face is
bundled, so task counts and costs do not yet inherit the incumbent data typography.

## Layout

The desktop shell has 14px outer padding, a 12px gap below the header, a 256px Dot
list, flexible conversation and optional 320px task pane. Conversation articles have
a 672px maximum width. The composer remains outside the scrolling conversation.
These measurements describe the build: the earlier brief proposed 288px for both
side regions. The wider result pane is a deliberate functional extension. That
dimensional difference is recorded rather than promoted to a system token or silently
corrected in the contract.

Below 768px, the left list is hidden, the selector is shown and the task pane occupies
the workspace width. Closing tasks restores the conversation and keyboard focus to
its toggle. The 390px screenshots show both views within the viewport without visible
horizontal page overflow. A screenshot is not a substitute for a complete interaction
or accessibility audit.

## Elevation & Depth

Surfaces use 1px borders and tonal separation, without shadows, gradients or animated
decoration. The native modal adds a translucent black backdrop. The task pane uses a
subtle stone surface against the white conversation.

## Shapes

Controls and task items use 6px corners; outer panels, composer and modal use 8px
corners. These match incumbent form language. The task cards nested within a pane
are a local presentation, not an exception added to the shared panel rules.

## Components

- **Actions:** indigo primary buttons, neutral outlined secondary actions and
  half-opacity disabled states. Send and New task explicitly set a 44px minimum
  height on phones and 34px from 768px. Other controls retain their observed compact
  dimensions; this record does not claim that every control is 44px.
- **Focus:** a global 2px indigo outline with 2px offset; the composer additionally
  changes its border on focus within.
- **Composer:** Send sits inside the message box. Enter requests submission when Send
  is enabled; Shift+Enter inserts a line. IME composition is excluded from submission.
  Both languages explain this shortcut below the field.
- **Dots:** selection uses a soft indigo fill, border and `aria-current`; each Dot keeps
  its draft separately. The narrow-screen selector is a native select.
- **Tasks:** textual running/completed/failed/stopped/interrupted states, a selected
  result, successful-read count and estimated model cost. Stop is shown for running
  work. The pane toggle exposes its expanded state and moves focus when opened/closed.
- **Memory and forms:** a native modal dialog hosts explicit save/cancel controls,
  labelled fields and inline errors. Memory revision conflicts remain visible rather
  than silently overwriting newer data.
- **Language:** functional copy is provided in Italian and English. The fixed publisher
  credit retains its canonical Italian text and links.

## Do's and Don'ts

Preserve the shared system when integrating this surface into Rails. Reuse its actual
navigation and components; the prototype's hand-written HTML is not a replacement
component catalog. Keep the separation between persistent identity, conversation and
task work explicit, as approved for this surface.

Do not canonize the following local drift: native selectors (shared H1/H14), simplified
top bar and mobile navigation, missing shared Mono metrics, differing type/spacing
steps, left-aligned transcript without per-message times/day separators (L1–L3),
hand-written controls, or the prototype's reduced output formatting instead of the
shared markdown renderer. The font weight loading, always-visible mobile footer and
dialog sizing likewise remain prototype details, not changes to incumbent rules.

No drift was repaired in this documentation pass. The task authorizes an isolated
prototype and a design record, not changes to the shared brand, design authority or
production surfaces. No shipping raster assets were added; the three screenshots
above are review evidence only.

The browser runtime remains attached to an agent-owned local TaskSpace. It is not an
autonomous Linux service; deployment and Linux runtime support are outside this record.
