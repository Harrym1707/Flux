# GEO visibility metrics

FLUX can aggregate manually collected answer-engine observations with the helper exported from `@flux/core` as `calculateGeoVisibilityMetrics`. The helper only calculates rates; it does not query answer engines or imply that a result is stable across prompts or dates.

- Mention, citation and link rates use all observations as the denominator.
- Correct-description and category-association rates use only observations where FLUX was mentioned.
- Those conditional rates are `null` when no observations mention FLUX, which means “no evidence yet,” not zero accuracy.
- Metrics can be broken out per engine with `calculateGeoVisibilityByEngine`.

Track repeated prompts and preserve the engine and observation time. Keep public claims grounded in reproducible product data; a visibility metric does not establish product performance.
