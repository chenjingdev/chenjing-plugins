# System Specification: [SYSTEM NAME]

**Created**: [DATE]
**Status**: Draft
**Gate**: not-run

<!-- A system-level implementation contract.
     Principle: nail down all the "axes" (state, boundaries, contracts, error
     taxonomy) and delegate the "values" (algorithm details, field names,
     formats) as implementation-defined. No pseudocode. -->

## 1. Purpose & Scope
[One paragraph on why this system exists. An Out of scope list is required.]

## 2. Domain Model
[Core entities and relationships. Per entity: field list + types + constraints
 + persistent/ephemeral. Follow story-spec's L6 Data model authoring rule:
 "a todo has text and a time" (no) → "text: string, 1-200 chars after trim" (yes)]

## 3. State Model
[The list of finite states and their transition conditions. Cover, without
 omission, how every state is entered and how it is left.]

## 4. Event Flow
[Event → valid state → effects (ordered list) → behavior on failure. Numbered.]

## 5. Error Taxonomy
[A list of typed errors (e.g., missing_config, parse_error) and the handling
 policy for each.]

## 6. Invariants (MUST) / Defaults (SHOULD) / Choices (MAY)
[RFC 2119 style. Prefix MAY items with "implementation-defined:" to state the
 delegation explicitly.]

## 7. Acceptance Criteria
[Given/When/Then, externally observable, precise enough to translate into
 automated tests. At least 3.]

## Decision Ledger *(mandatory)*

<!-- Admission bar: record decisions that are expensive to reverse, external
     contracts, security/data choices, or genuinely contested forks. Cheap,
     easily-reversed choices are not ledger material. -->

| # | Decision | Rationale (facts at the time) | Rejected alternatives |
|---|---|---|---|

## Deferred to Implementer *(waiver record)*

## Resolved by Experiment *(experiment record)*

<!-- Questions deliberately routed to experiments instead of pre-decided on
     paper (G-13). Not re-raised by cold readers. When an experiment concludes,
     move the answer into the body and log it in the Decision Ledger. -->

- [question] — answered by: [candidate comparison | user reaction | runtime observation], decided by: [milestone/generation]

## Assumptions
[Things not specified that you filled with reasonable defaults. No unstated
 assumptions — declare them all here.]
