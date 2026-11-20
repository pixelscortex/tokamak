---
name: ui-design
description: Design, implement, or visually review application interfaces using practical rules for hierarchy, layout, typography, color, depth, imagery, and component polish. Use when composing or improving UI; adapt to the existing design system and task.
---

# UI Design

Use this rulebook to make concrete visual decisions while building or improving an interface. It is self-contained and requires no companion files.

## Apply the rules

Identify the user's task, intended audience, primary content, and primary action. Preserve the requested scope, established brand, and useful existing components. Read the relevant sections below, make a coherent implementation, then inspect the rendered result at its actual size and at relevant viewport widths when relevant, feasible, and within the authorized task. A source-only review does not require launching an app; do not start services, install dependencies, or change unrelated configuration merely to satisfy this skill. Fix the most consequential hierarchy, grouping, readability, and interaction problems before decorative details.

Treat the examples and numbers as starting points, not universal tokens. Prefer existing design tokens when they work. Do not turn a visual preference into an accessibility regression, invent product features to exercise a rule, or redesign unrelated screens. For a review, report observable problems with concrete remedies; do not mechanically list every rule. If rendering or interaction checks are unavailable, state that limitation rather than claim visual verification.

Throughout the interface, preserve semantic structure, accessible names, keyboard operation, visible focus, readable contrast, and usable targets throughout. Never rely on hover or color alone to convey essential information.

## 1. Begin with a useful feature

- Design the central task before deciding the application shell. Enumerate its essential inputs and actions; let real features inform navigation and containers. A simple product may need very little shell.
- Explore uncertain structure with rough alternatives; defer fonts, icons, and shadows until the arrangement works. Coarse sketches are useful because they resist premature polish. Wireframes are disposable decision aids: move into a working interface once the direction is clear.
- Establish hierarchy with spacing, size, weight, and tonal contrast before adding color. A grayscale pass can expose weak priority and grouping; color should reinforce an already understandable composition. Keep selection identifiable without color, such as with a checkmark and border, and retain accessible field labels.
- Alternate small design and implementation cycles. Use the feature and revise real errors, long lists, and overlapping content instead of designing every hypothetical screen first. Do not imply optional functionality in the initial design until ready to build it. Keep a useful initial version shippable when optional capabilities prove expensive; do not remove requirements the user needs.
- Choose an audience-appropriate personality and express it consistently through type, palette, corners, and language. Serif can suggest tradition, rounded sans playfulness, neutral sans restraint; these are contextual associations. Match formality in instructions and transactional copy. Study the audience's other products for context, without cloning a competitor.
- Keep corner treatments coherent across cards, inputs, and buttons. Square, slightly rounded, and generously rounded treatments communicate different tones; use deliberate variations rather than arbitrary mixtures.

## 2. Constrain repeated decisions

- Use finite scales for recurring sizes, spacing, colors, weights, line-heights, dimensions, shadows, radii, borders, and opacity. Grow the system when decisions recur; a complete up-front system is unnecessary. Avoid near-duplicate values invented per component.
- Compare a plausible token with its immediate neighbors in the actual component, eliminate worse options, and repeat if a neighbor wins. For example, compare 16px against 12px and 24px rather than tuning an icon one pixel at a time.
- Use smaller absolute intervals at small sizes and larger intervals at large sizes. Relative differences matter more than equal pixel steps. A roughly 25% spacing-step heuristic can be a starting point; a 640-to-768px step is 20%, so do not enforce the percentage as a validation rule.
- Example spacing/sizing vocabulary in px: `4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 640, 768`. Choose only what is useful and reconcile with existing tokens.

## 3. Make hierarchy unmistakable

- Rank primary, secondary, and tertiary content. Equal emphasis produces noise. Before enlarging the focal item again, reduce competing weight: soften inactive navigation, remove a secondary region's unnecessary filled container, or quiet supporting text. Keep secondary content legible and discoverable. When restyling data-heavy screens, preserve underlying values, signs, labels, and available actions; visual examples are not permission to alter data.
- Use weight and color alongside size. A reasonably sized bold title and readable supporting copy often work better than an enormous heading beside tiny text. Start with two or three text colors and two weights: often 400/500 normal and 600/700 emphasis. Avoid weights below 400 for small UI text; lighter weights may work at display sizes.
- On colored surfaces, choose an opaque, background-related secondary text color rather than transplanting neutral grey or automatically reducing white opacity. Transparency can look disabled and reveal patterns through letters. Check the actual background, including images or patterns.
- Remove redundant labels from displayed data only when recognizable formats or context preserve meaning. This does not authorize removing form labels. Combine ambiguous values with units or meaning, such as a count plus its noun, instead of repeating a label-colon-value pattern.
- Usually emphasize values over their captions. In a specification lookup, labels may deserve more emphasis because users search for property names. Choose based on the lookup task and keep both halves readable.
- Separate heading semantics from appearance. Use the correct heading level, then style for visual importance; a structural heading may be a small label. Visually hide it only when visible context is clear and accessible structure remains useful.
- Balance visual mass, not bounding boxes. A solid icon can overpower adjacent text; soften its contrast if it should be subordinate. A pale separator can gain visibility through thickness rather than a harsh darker color: compare the same pale separator at 1px and 2px, alongside a darker 1px alternative, in context.
- Rank actions before styling them. Usually one primary action gets the strongest fill; secondary actions get quieter fill or outline; tertiary actions may be link-like. Preserve affordances in each theme.
- Destructive severity does not automatically make an entry point the primary action. It can remain quiet on the originating screen, with explicit consequences and a prominent destructive choice at the final decision point. Respect the product's actual confirmation flow.

## 4. Use space and constraints intentionally

- Begin generously spaced, then tighten while viewing the full composition. Starting cramped encourages accepting barely sufficient space. Deliberate density is appropriate when simultaneous visibility serves a task, such as a data-heavy dashboard.
- Size content for its job rather than the viewport. Forms and checkout rows often need a constrained width even beneath full-width navigation. Leave outside margins; do not force genuinely wide content into a narrow column.
- If a wide canvas makes composition difficult, start around a 400px mobile canvas, then adapt upward. Revisit narrow-screen compromises rather than stretching every region. The canvas is an exercise, not a mandatory breakpoint.
- When a narrow form feels isolated on desktop, place section descriptions in a neighboring column instead of making inputs excessively wide. Stack appropriately on smaller screens and preserve clear associations.
- Use grids to simplify alignment, not dictate every width. A content-sized sidebar can remain fixed while the main region flexes; an avatar can retain its intended size in differently sized cards. A percentage sidebar may waste space on wide screens and squeeze labels on narrow ones. Adapt the layout when fixed content no longer fits.
- Give components a preferred maximum width and allow shrinkage when space requires it. Avoid breakpoint span changes that make a login card unexpectedly wider on a medium viewport than a large one. The illustrated 500px card is not a universal maximum.
- Adjust responsive relationships independently. Large headings often need a larger proportional reduction than body text. A desktop 18px/45px pair need not become 14px/35px on mobile; 20–24px might suit that particular mobile title better. Keep actual readability and hierarchy in view.
- Tune button padding separately from type: large variants may need proportionally more breathing room, compact variants less. Tune the horizontal and vertical axes independently: in the illustrated large-button comparison, horizontal padding changes from 20px to 30px while vertical padding stays at 15px. These are visual examples, not target-size requirements. Compare variants together and retain usable interactive targets.
- Make within-group gaps smaller than between-group gaps. A label should be closer to its field, a heading to its following paragraph, and a count to its own icon than to neighboring groups. Equal gaps create ambiguous associations, both horizontally and vertically. Keep wrapped lines within one list item closer than separate items. Improve the relationship by shrinking an inner gap, enlarging an outer gap, or both; merely adding space everywhere does not resolve ambiguity. Borders and surfaces can supplement proximity.

## 5. Design text for its reading context

- Use a constrained, non-linear type scale. An example is `12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72px`; do not use all sizes by default or make the smallest the body size. Hand-pick useful intervals rather than adopting a ratio that omits needed UI sizes or creates unwanted fractions. Modular scales can still suit long-form work; round generated values intentionally when fractional sizes are undesirable.
- Prefer predictable root-relative `rem` or explicit size tokens for font sizes. Nested `em` font sizes compound: a .875em child in a 20px parent becomes 17.5px, not the 14px implied by a 16px root. This is not a prohibition on `em` for other dimensions.
- Choose fonts at their actual intended reading size. A neutral sans or system stack is a useful starting point; a suitable system stack can also provide fallbacks after a chosen custom family. Open spacing and a healthy x-height often help small text; condensed display faces may fail there. Expressive faces remain appropriate when they suit the task.
- To narrow font choices, consider breadth of weights, popularity, and choices on well-designed sites. Five weights or ten styles including italics is an imperfect quality signal, not proof. Inspect actual glyphs and rendering. Historical font-directory counts are not current facts.
- Aim for roughly 45–75 characters per paragraph line; around 20–35em width is an approximate starting point, dependent on the font. Constrain paragraphs independently of wide images or grids. Read real copy rather than trusting a width formula.
- Align adjacent mixed-size text by baseline when it improves the row, rather than automatically centering it; for a flex row, compare `align-items: baseline` with `align-items: center`. Small baseline offsets become especially visible when the text items are close together. Do not extend this mechanically to every icon or non-text control.
- Tune line-height to measure and font size. Body text might start near 1.5; longer lines and smaller text often need more, large multiline headlines less. The examples range from about 1 for display text to 2 for wide text. Check reading flow, cohesion, font metrics, and clipping rather than copying ratios.
- Make inline prose links clearly interactive. In link-heavy interfaces, use deliberate weight or contrast rather than saturating every title. Ancillary links can be quieter, but hover-only disclosure must not hide essential affordances from touch or keyboard users.
- Align prose to the language's starting edge. Centering can work for short headings and short independent blocks; longer paragraphs usually read better start-aligned. Shorten an overlong centered feature blurb or change its alignment; two or three lines is a heuristic, not a hard limit.
- Right-align comparable numeric table columns and handle decimal precision, units, and signs deliberately so place values align. If deliberately justifying prose, test language-aware hyphenation, correct language metadata, and browser support to avoid large word gaps; start alignment is usually simpler.
- Begin with the font's default tracking. Test tighter spacing for large headlines set in a loose text face, and slightly wider spacing for uppercase labels. Examples of `-0.05em` and `0.05em` are font-specific, not global settings. Tracking cannot turn an unsuitable display face into readable small body text.

## 6. Build functional color families

- Build neutral, primary, and semantic/accent families with shades for actual roles, rather than applying five vivid generator swatches everywhere. A starting point might be 8–10 neutrals, one or two primary hues with 5–10 shades, plus accents needed for states and categories. These are planning examples, not quotas.
- Use a finite named palette. For a chromatic family, choose a base that works on a button, a dark endpoint for text, and a light endpoint for tinted surfaces. The base need not be 50% HSL lightness. For neutrals, begin with dark text and subtle off-white endpoints. Test actual components and revise the shared scale rather than inventing local near-duplicates.
- Fill perceptual gaps: one method assigns endpoints 100/900 and base 500, finds 300/700, then 200/400/600/800. Inspect for uneven jumps and redundant neighbors; arithmetic equality does not ensure visual equality.
- HSL makes hue, saturation, and lightness relationships understandable. Do not confuse HSL lightness with HSB brightness: full HSB brightness need not be white. Modern color spaces are also available; HSL is a useful editing model rather than a required implementation format.
- At very light or dark values, constant HSL saturation may look washed out. Test increasing saturation toward the extremes; there is no mandatory curve. Equal HSL lightness also does not mean equal perceived brightness—yellow and blue make the difference obvious.
- Consider gentle hue rotation to preserve richness: move toward nearby yellow/cyan/magenta directions to brighten, or red/green/blue directions to darken. Combine with lightness changes and inspect the whole ramp. Roughly 20–30° can be a useful upper range for keeping family resemblance, not a contrast guarantee. Darker yellow may benefit from a move toward orange.
- Tint neutrals blue for a cooler atmosphere or yellow/orange for warmth. Tune saturation at the extremes to retain temperature; check the resulting text and surfaces together.

## 7. Make contrast and meaning robust

- Measure actual text/background pairs. WCAG AA text thresholds are 4.5:1 for normal text and 3:1 for large text; large means at least 18pt regular (usually 24 CSS px) or 14pt bold (about 18.67 CSS px). Do not substitute an approximate 18px cutoff for the formal threshold. Check applicable non-text contrast too. HSL lightness and illustrative perceived-brightness formulas are not WCAG contrast calculations.
- If white text on a vivid badge fails, do not automatically darken every badge until secondary statuses dominate. Try dark text on a pale tint from the same family; measure each pair and retain explicit status labels.
- If secondary text on a dark chromatic panel becomes almost indistinguishable from primary white text, test a shift toward a perceptually brighter hue while preserving hierarchy. Verify contrast rather than assuming the hue shift succeeds. The 20–30° family-resemblance heuristic concerns related palette shades; it is not a universal limit on text/background hue differences. A larger text hue shift can be appropriate; evaluate contrast and hierarchy in context.
- Encode status and chart meaning beyond hue: signs, arrows, text, direct labels, patterns, or line styles. Differences in lightness may improve separation but do not alone provide a complete non-color alternative. Check grayscale and color-vision simulations and provide accessible data or descriptions where needed.

## 8. Make depth coherent and restrained

- Use an imagined light source above to coordinate raised and inset cues. Choose the intended side profile first: flat-edged examples can assume a viewer looking slightly downward, exposing a raised element’s top edge or an inset element’s bottom lip. Raised controls can have a fine upper highlight and a tight lower shadow; recessed wells can have a dark upper inset shadow and a light lower lip. Choose highlight colors intentionally instead of washing everything out with translucent white. Keep close-contact blur small, and prevent upper inset shadow leaking into the lower edge.
- Use physical cues only when they improve clarity. Remove elaborate realism that adds noise without useful hierarchy.
- Choose elevation before shadow: a button needs little lift, a dropdown more, a modal stronger separation. Define a small ordered vocabulary—about five is an example—starting with useful smallest and largest shadows, then filling the middle with progressively increasing sizes. Inspect it on identical surfaces; exact arithmetic intervals are unnecessary. Avoid bespoke shadows for every component.
- Reinforce spatial interaction: lift a dragged item with stronger shadow and let a pressed button move perceptually toward its surface by reducing shadow. Preserve other feedback.
- Combine a broad, soft cast shadow with a tighter, darker contact shadow when one blur cannot provide both elevation and edge definition. Weaken the tight contact layer as elevation increases; high objects should not retain a heavy attached edge.
- Flat interfaces can still imply depth through related light/dark surfaces or short solid zero-blur offsets. Within a hue family, lighter surfaces often read nearer and darker ones recessed; evaluate in context rather than treating lightness as a universal spatial law.
- Overlap can establish layers: let a card cross a section boundary, extend beyond a parent, or place small controls on an edge. Preserve responsive layout, reading order, and operability. Separate overlapping avatars with a rim matching the local background; the pictured 4px border is illustrative.

## 9. Design with real images and intended asset sizes

- Assess actual photography early for composition, light, and color. Commission professional work for specific needs or use suitable quality stock for generic needs; an expensive camera or a late placeholder replacement does not guarantee quality.
- Check text across every underlying light and dark patch and across responsive crops. Switching text color alone rarely fixes a highly variable image. Test dark overlays for light copy or light overlays for dark copy.
- Other options include reducing image contrast and then compensating brightness, or reducing contrast, desaturating, and colorizing with a multiply tint. Each changes the image's character; tune for the actual asset and measure text contrast.
- A broad, zero-offset text shadow can improve local separation while retaining more image detail. Keep it diffuse rather than visibly displaced and combine with appropriate tonal treatment. The pictured 55% overlay, -70% contrast/+40% brightness, or 50px/40%-black shadow are examples, not presets.
- Respect intended asset scale. Enlarged bitmaps blur; small vector icons remain sharp but may become chunky and under-detailed. Use large-size artwork or retain the small icon inside a larger colored shape. Redraw tiny favicon variants with pixel-appropriate stroke weight, lengths, and detail rather than shrinking a detailed logo mechanically; simplification need not reduce the number of shapes. Inspect the result at its actual small display size as well as magnified.
- Keep screenshots intelligible at display size. Give them room, capture a smaller-device layout, show a meaningful crop, or simplify unimportant detail into illustrative lines and shapes. A typeless illustration can replace text with neutral bars while retaining useful color hierarchy, filled states, and recognizable icon shapes. A simplified illustration must not pretend to be a readable, faithful screenshot. Assess screenshot legibility at the actual display size.
- Normalize unpredictable uploads in consistent aspect-ratio frames, using centered cover cropping as a starting point where appropriate, then adjusting the focal alignment to the subject. Inspect portraits, landscapes, and subject placement; show the whole image when the task requires it.
- Keep pale uploaded images from merging into pale surfaces using a subtle inset shadow or translucent inner border. Avoid an opaque ring that clashes with the image. An inset shadow suggests recess, so use the border alternative when that cue is undesirable.

## 10. Add polish where it helps

- Improve existing details before adding decoration: meaningful list icons (for example, a glyph inside a colored disc when appropriate), expressive quotation marks, distinctive but readable link treatments, and coherent selected controls. Preserve list semantics, and do not use icons that falsely imply completion. Controls retain semantics, focus, and keyboard behavior; check selected, unselected, disabled, and focused states across relevant themes. Measure essential control boundaries and state indicators where applicable, rather than requiring contrast from every decorative border.
- A restrained accent line can add identity to a card, active navigation, alert, heading, or page edge. Fit its length, alignment, and weight to the element it marks rather than forcing one accent dimension everywhere. Use it selectively so accents do not compete; pair state color with another cue.
- Differentiate selected panels or sections with surface color. Subtle gradients can add energy; the suggested hue separation of about 30° is an aesthetic guideline, not a contrast guarantee. When recoloring a surface, retune its primary and secondary text and CTA treatment as well; a contrasting action strip may help. Check text across the entire gradient, including the lightest region behind light text.
- Use low-contrast repeating motifs, edge patterns, sparse shapes, or pale illustrations for texture. Keep them subordinate, allow sensible cropping, and verify text remains dominant on narrow screens too. Decoration need not cover the entire surface: a header band, edge, or corner can suffice. A polished reference is not proof of accessible contrast; verify foreground text against both the pattern and the base surface. Do not turn sampled decoration contrast into a mandatory token.
- Design the first-use empty state deliberately: explain the purpose and next step, provide an appropriate creation action, and use illustration when helpful. Remove filters, tabs, or search that cannot help with zero content. Avoid redundant competing copies of the same creation action when one clear path suffices. Consider an action-oriented heading that explains what to create and why, while keeping useful global navigation. These are contextual options, not a rule that every repeated CTA is wrong. Preserve useful recovery and navigation; a filtered no-results state may need a different action from a new empty collection.
- Replace redundant borders with spacing, subtle surface differences, or a restrained shadow. Test removing borders already duplicated by surface color. Shadow separation often works best when foreground and background differ; retain boundaries needed for comprehension and affordance. The techniques can coexist: the illustrated picker progressively replaces its outer border with shadow, interior rules with tinted regions, and row rules with whitespace, retaining the earlier improvements. Redistribute separation rather than merely deleting it; this sequence is an example, not a required recipe.
- A dropdown can use sections, columns, concise descriptions, and meaningful icons when these clarify a complex choice. Do not inflate a simple list, and preserve correct keyboard and focus behavior.
- Make tables hierarchical: combine related values in one cell with primary/secondary text when independent sorting is unnecessary. Keep separate sortable fields when users need them. Use identifying imagery and labeled statuses only when useful, never color-only status.
- Consider selectable cards for an important single-choice decision with comparable attributes. Preserve single-selection radio semantics, clear non-color selection (for example, a border and check badge, optionally reinforced by a content tint), focus, and keyboard operation; a simple radio list may be better when space or complexity matters.

## 11. Review and learn from the result

Inspect the actual interface, rather than judging only tokens or source code:

1. Is the primary task clear, with deliberate content and action hierarchy?
2. Do proximity and grouping communicate the right relationships?
3. Does content keep an appropriate width through breakpoint changes and long-content states?
4. Are real text, numbers, images, and screenshots readable at display size?
5. Do contrast, focus, keyboard access, and redundant status cues survive every relevant state?
6. Are depth, borders, accents, and decoration helping rather than competing?
7. Does the empty/new-user experience offer a useful next step?

Study good interfaces by recording specific decisions you would not naturally make and the context in which they work. When useful for learning, reconstruct a reference without inspecting its CSS, then compare at matching dimensions. Investigate details such as heading leading, uppercase tracking, layered shadows, and crop placement. These are techniques to evaluate, not mandatory styles or permission to copy a reference into unrelated work.
