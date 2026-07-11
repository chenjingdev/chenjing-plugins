# System Specification: [SYSTEM NAME]

**Created**: [DATE]
**Status**: Draft
**Gate**: not-run

<!-- A system-level implementation contract.
     Principle: nail down all the "axes" (state, boundaries, contracts, error
     taxonomy) and delegate the "values" (algorithm details, field names,
     formats) as implementation-defined. No pseudocode.

     Sections 2-5 are CONDITIONAL: include each only when its trigger holds;
     when you omit one, replace its body with one line saying why ("no
     persistent data — domain model implementation-defined"). A small system
     does not owe a full state machine and typed error taxonomy just for
     existing; an unneeded section filled anyway is where false precision
     accumulates. -->

## 1. Purpose & Scope
[One paragraph on why this system exists. An Out of scope list is required.]

## 2. Domain Model *(include when data persists or forms an external contract)*
[Core entities and relationships. Per entity: field list + types + constraints
 + persistent/ephemeral. Follow story-spec's L6 Data model authoring rule:
 "a todo has text and a time" (no) → "text: string, 1-200 chars after trim" (yes)]

## 3. State Model *(include when finite states/transitions carry correctness)*
[The list of finite states and their transition conditions. Cover, without
 omission, how every state is entered and how it is left.]

## 4. Event Flow *(include when ordering, concurrency, retries, or side effects matter)*
[Event → valid state → effects (ordered list) → behavior on failure. Numbered.]

## 5. Error Taxonomy *(include when consumers must distinguish errors or recovery policies differ)*
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

## Implementation Authority & Escalation *(handoff policy — mandatory)*

<!-- The execution contract for whoever implements this spec. Keep the default
     text; add project-specific escalation lines below it. -->

This specification is authoritative for intent, observable behavior,
invariants, compatibility, and safety boundaries. The implementer MUST inspect
the current repository, tests, and dependencies before choosing an approach.
Code references in this document are evidence from authoring time, not
instructions to modify specific files. The implementer MAY change its plan as
new evidence appears, and MUST stop only when an escalation condition below
occurs.

**Escalation conditions** (stop and ask a human):

- A public API or persisted schema must change beyond what this spec declares
- Requirements conflict with an existing system this one touches
- The work cannot be completed within the declared scope
- External writes, deployments, data deletion, or sensitive credentials are required
- An acceptance criterion admits materially different interpretations
- [project-specific condition]

## Assumptions
[Things not specified that you filled with reasonable defaults. No unstated
 assumptions — declare them all here.]
