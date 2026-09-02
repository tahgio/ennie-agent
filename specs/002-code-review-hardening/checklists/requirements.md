# Specification Quality Checklist: Post-Review Hardening

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-02
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`

### Validation iteration 1 — 2026-09-02

**Passing.** All content-quality items pass. The specification describes behaviours and outcomes
rather than code changes; file paths and symbol names from the source review are confined to the
Traceability table, which records provenance rather than prescribing implementation.

Success criteria are stated as measurable deltas from an observed baseline (SC-001 "0% → 100%",
SC-012 "3 mismatches → 0", SC-009 "0 of 10 → 10 of 10") and are verifiable without knowing how they
are implemented.

Scope is bounded in three directions: the source review is the ceiling, §7 of that review is
recorded under Out of Scope with a requirement (FR-051) forbidding its alteration, and FR-049
forbids capability-contract changes beyond the two the specification deliberately makes.

**Blocking.** Two `[NEEDS CLARIFICATION]` markers remain, both deliberate and both scope-shaping:

1. **FR-028 / US5 acceptance scenario 1** — whether contradictory taxon inputs are refused or
   accepted-with-notice. This changes an existing capability contract that third-party clients may
   already depend on, so it is not a detail a reasonable default can settle. It is the only item in
   this specification that could break an existing caller.
2. **FR-041** — whether measured coverage acts as a blocking gate. A threshold changes what
   contributors experience on unrelated changes and can block work that is otherwise correct; the
   alternative is information-only reporting. Both are defensible and the choice is the project's.

Consequently "All functional requirements have clear acceptance criteria" is also unmet: US5's first
acceptance scenario cannot be written concretely until Question 1 is answered.

**Not blocking.** Every other requirement was resolved by informed default and the default is
recorded in Assumptions — ceiling sizes, interruption exit status, verbosity forwarding, the
update-proposal mechanism, and the placement of the year bound.

Re-run this checklist after the two questions are answered.

### Validation iteration 2 — 2026-09-02

**Passing — 16/16.** The two items blocked by iteration 1 now pass; iteration 1's own re-run
condition ("after the two questions are answered") has been met.

Both questions were answered and are recorded in the specification's `## Clarifications` section,
Session 2026-09-02:

1. **FR-028 / US5 acceptance scenario 1** — contradictory taxon inputs are **refused**, with a
   recoverable failure naming both supplied values and directing the caller to supply exactly one.
   The scenario that iteration 1 said "cannot be written concretely" is now written concretely, and
   the change is carved out explicitly by FR-049 as one of the two sanctioned contract changes.
2. **FR-041** — coverage is **reported for information only**, stated as a testable negative: "It
   MUST NOT act as a blocking gate: no coverage threshold may fail a run."

Consequently "All functional requirements have clear acceptance criteria" is also met: every FR now
has at least one acceptance scenario or success criterion that can be checked without knowing how it
is implemented.

No `[NEEDS CLARIFICATION]` markers remain (0 occurrences). No regressions: the fourteen items
passing at iteration 1 still pass against the unchanged specification text.
