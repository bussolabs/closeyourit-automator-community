# Coworkers prototype

Extends CloseYourIt's established interface. Visual authority and product context:
`closeyourit-docs/DESIGN.md`, `closeyourit-docs/PRODUCT.md`, and the existing Rails chat surface.
Mode: Operate. No new brand or design-system changes.

## Direction contract

THESIS: Select a persistent Dot, keep talking while it works, and inspect its saved memory.
OWN-WORLD: Inherit CloseYourIt's stone paper, white surfaces, indigo actions, Atkinson font,
1px borders, 6px controls and 8px panels; no shadows.
STORY: The operator selects a Dot on the left, chats in the center, and opens tasks or memory.
FIRST VIEWPORT: One section named Coworkers, a 288px Dot list, a flexible conversation and
an optional 288px task pane. The composer stays below the conversation. Narrow screens stack
the list and conversation; secondary panels become explicit views in the functional version.
FORM: Existing chat composition extended to persistent agents; no concept seed applies.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance.

The mockup uses empty states and the real local test identity, not fabricated work or results.
The user approved the arrangement and the dedicated-area entry on 2026-10-04. The
functional artifact is `prototypes/coworkers/public/index.html`. The prototype home
demonstrates entry/return without imitating live organization or account data. The
production integration will retain the Rails top bar and replace its usual sidebar
with Dots. On mobile, a Dot selector replaces the sidebar and tasks have their own view.

The implementation evidence, inherited system and uncanonized prototype differences
are recorded in the [Coworkers design record](coworkers-design-review.md).
