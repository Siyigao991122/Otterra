# Floorplan Geometry V2

Floorplan V2 is an isolated replacement candidate for the current floor-plan geometry pipeline.
It must remain disconnected from `/design` until benchmark fixtures and the review UI pass the
acceptance gate.

## Non-negotiable pipeline rules

1. Detect and preserve doors/windows before repairing wall gaps.
2. Use semantic recognition to classify evidence, not to invent final CAD coordinates.
3. Reconstruct and validate geometry deterministically.
4. Keep one canonical meter-based, Y-up coordinate frame for the web scene.
5. Never promote a result with unresolved openings or an invalid footprint without user review.
6. Keep the legacy pipeline available until V2 wins the benchmark set.

## Current stage

The first stage provides:

- a versioned `otterra-floorplan/v2` package;
- architectural-wall filtering;
- near-axis wall normalization;
- endpoint snapping without bridging visible opening gaps;
- collinear overlap merging;
- door/window host assignment;
- blocking diagnostics and reproducible statistics;
- a parallel `/api/floorplan-v2/normalize` endpoint.

The endpoint is intentionally not called by the production upload flow.

## Next gates

1. Add benchmark fixtures with manually approved wall/opening truth.
2. Implement vector-PDF evidence extraction without relying on archived geometry-first modules.
3. Add raster semantic-mask ingestion.
4. Add a source-overlay review/editor for walls and hosted openings.
5. Compare V2 against the legacy pipeline before any production integration.
