# Exploration Brief: [NAME]

**Created**: [DATE]

**Status**: exploring

**Mode**: explore  <!-- This document is NOT an implementation contract and is
     never gated. Data models, state machines, error taxonomies, and UX are
     candidate-defined — fixing them here would collapse the diversity the
     exploration exists to produce. Only Hard Constraints are normative. -->

**Input**: User description: "$ARGUMENTS"

## Intent *(mandatory)*

[One paragraph: what value hypothesis is being explored. Not what to build —
 what would make any candidate worth keeping.]

## Target User *(mandatory)*

[Who this is for, in one or two lines.]

## Hard Constraints *(mandatory — the only normative section)*

<!-- Boundaries no candidate may cross. Keep this list SHORT — every line here
     shrinks the search space. Typical entries: privacy/security boundaries,
     platform requirements, budget ceilings, "must not touch X". -->

- [constraint]

## Evaluation *(mandatory)*

<!-- How candidates will be compared, in observable terms. This is what turns
     the fan-out into a measurement instead of a vibe check. 2-4 criteria. -->

- [criterion, e.g., "time-to-first-value on a cold start, measured by screen recording"]
- [criterion, e.g., "does the core loop survive 10 realistic tasks without workarounds"]

## Diversity Axes *(mandatory)*

<!-- Directions along which candidates SHOULD differ. Same-prompt fan-out
     converges; assign each candidate a distinct stance. -->

- [axis, e.g., "minimal single-screen vs. dashboard-first"]
- [axis, e.g., "assume power users vs. assume first-timers"]

## Open Questions *(answered by building, not by interview)*

<!-- Questions deliberately left open because candidate comparison or runtime
     observation answers them better than the author's guess. Each entry says
     HOW it will be answered. These migrate into the contract spec's
     "Resolved by Experiment" section if/when /spec contract mode runs. -->

- [question] — answered by: [candidate comparison | user reaction | runtime observation]

## Notes *(optional)*

[Prior art, references, anything the candidate builders should see.]
