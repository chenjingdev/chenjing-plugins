# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`

**Created**: [DATE]

**Status**: Draft

**Gate**: not-run  <!-- not-run | round-N-blocked | passed | passed-with-waivers — writing session updates only -->

**Input**: User description: "$ARGUMENTS"

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories must be prioritized as user journeys ordered by
  importance. Each user story/journey must be independently testable — that is,
  implementing any single one of them should yield a viable MVP (minimum viable
  product) that delivers value on its own.

  Assign each story a priority (P1, P2, P3, etc.), with P1 the most important.
  Think of each story as an independent slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to the user independently
-->

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain why it has this priority and the value it delivers]

**Independent Test**: [Describe how it can be tested independently — e.g., "fully testable via [specific action] and delivers [specific value]"]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Describe this user journey in plain language]

**Why this priority**: [Explain why it has this priority and the value it delivers]

**Independent Test**: [Describe how it can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 3 - [Brief Title] (Priority: P3)

[Describe this user journey in plain language]

**Why this priority**: [Explain why it has this priority and the value it delivers]

**Independent Test**: [Describe how it can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

[Add as many user stories as needed, assigning each a priority]

### Edge Cases

<!--
  ACTION REQUIRED: the content of this section is a placeholder.
  Fill it with the actual edge cases.
-->

- What happens when [boundary condition] occurs?
- How does the system handle [error scenario]?

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: the content of this section is a placeholder.
  Fill it with the actual functional requirements.
-->

### Functional Requirements

- **FR-001**: The system MUST provide [specific capability] (e.g., "let users create an account")
- **FR-002**: The system MUST provide [specific capability] (e.g., "validate the email address")
- **FR-003**: Users MUST be able to [key interaction] (e.g., "reset their password")
- **FR-004**: The system MUST satisfy [data requirement] (e.g., "persist user settings")
- **FR-005**: The system MUST perform [behavior] (e.g., "log all security events")

*Example of marking unclear requirements:*

- **FR-006**: The system MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified — email/password, SSO, OAuth?]
- **FR-007**: The system MUST retain user data for [NEEDS CLARIFICATION: retention period not specified]

### Key Entities *(include if the feature handles data)*

- **[Entity 1]**: [what it represents, key attributes without implementation detail]
- **[Entity 2]**: [what it represents, relationships to other entities]

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: define measurable success criteria.
  They must be technology-neutral and measurable.
-->

### Measurable Outcomes

- **SC-001**: [measurable metric, e.g., "users can complete account creation within 2 minutes"]
- **SC-002**: [measurable metric, e.g., "the system handles 1000 concurrent users with no performance degradation"]
- **SC-003**: [user-satisfaction metric, e.g., "90% of users complete the primary task successfully on the first attempt"]
- **SC-004**: [business metric, e.g., "reduce support tickets related to [X] by 50%"]

## Decision Ledger *(mandatory)*

<!-- Admission bar: record a decision when it is expensive to reverse, is an
     external contract (API/schema/protocol), touches security or data
     handling, had genuinely competing alternatives, or a future session might
     re-litigate it. Cheap, easily-reversed choices are NOT ledger material —
     an all-recording ledger becomes sediment nobody reads. The "rationale" is
     what lets a later session verify assumption freshness (whether that
     rationale still holds). -->

| # | Decision | Rationale (facts at the time) | Rejected alternatives |
|---|---|---|---|
| D-1 | [the decision] | [the conditions/facts at the time that forced this decision] | [alternative considered and dropped + why] |

## Deferred to Implementer *(waiver record)*

<!-- Items the gate raised but the author explicitly delegated as "implementer's
     discretion". Items listed here are not re-raised by cold readers (G-7). -->

- [item]: implementer's discretion. Reason: [why the spec does not need to decide this]

## Resolved by Experiment *(experiment record)*

<!-- Questions deliberately routed to experiments instead of pre-decided on
     paper (G-13) — pre-deciding them would bake in a guess that building
     candidates or observing real behavior answers better. Like waivers, items
     listed here are not re-raised by cold readers. When an experiment
     concludes, move the answer into the body and log it in the Decision
     Ledger with the result as rationale. -->

- [question] — answered by: [candidate comparison | user reaction | runtime observation], decided by: [milestone/generation]

## Context Snapshot *(non-normative — re-verify at implementation)*

<!-- Pre-research findings about the CURRENT code: patterns to follow, files
     to touch, constraints observed, as file:line citations. This section is a
     head start, not contract — the implementer re-verifies against live code
     and tests, and a mismatch means this snapshot aged, never that the code
     violates the spec. Snapshot date required. -->

**Snapshot date**: [DATE]

- [finding, e.g., "auth flow lives in `src/auth/session.ts:41-88`; new endpoints follow the pattern in `src/api/routes/user.ts:12`"]

## Assumptions

<!--
  ACTION REQUIRED: the content of this section is a placeholder.
  List the details the feature description did not specify and that you filled
  with reasonable defaults.
-->

- [assumption about the target users, e.g., "users have a stable internet connection"]
- [assumption about scope boundaries, e.g., "mobile support is out of scope for v1"]
- [assumption about data/environment, e.g., "reuse the existing authentication system"]
- [dependency on an existing system/service, e.g., "requires access to the existing user profile API"]
