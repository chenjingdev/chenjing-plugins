# Gate Report: [spec title]

> spec: [relative path to SPEC.md]
> Pass rule: zero confirmed blocking = passed (G-4) · no round cap (stopping is the user's call) (G-8)
> Scope: the gate measures decidability, not desirability (G-15) — passed means "no ambiguity visible to N cold readers remains", not "the spec is right"

## Round [N] — [ISO timestamp] — reader: [model name] ×[N] (reader 0: adversarial framing, G-14)

**Verdict: [passed | blocked (N confirmed blocking) | passed-with-waivers]**

| # | Severity | Category | Title (anchor) | Votes | Status |
|---|---|---|---|---|---|
| R[N]-1 | confirmed blocking | decision | ... (FR-xxx) | 2/3 | open |
| R[N]-2 | confirmed experimental | decision | ... (FR-yyy) | 2/3 | suggested → [experiment-recorded \| decided now] |
| R[N]-3 | confirmed stale-assumption | — | ... (FR-zzz) | 2/3 | fact → Context Snapshot, clause restated |

<!-- Experimental and stale-assumption rows never affect the verdict (G-13).
     Record the routing/relocation in the Status column. From round 3 onward,
     note the structural-diagnosis choice (continue / split / demote to
     explore / route to experiments) above the round block. -->

### Details
[Paste the raw BLOCKING/DISCRETIONARY/EXPERIMENTAL/STALE-ASSUMPTION/OUT-OF-SCOPE/VERDICT from the reader outputs]
