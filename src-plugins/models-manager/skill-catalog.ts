/**
 * Bundled catalog for the skill store.
 *
 * There is no upstream skill registry to point at — DSH ships its skill
 * machinery, not a distribution channel — so the store ships this short
 * curated list and lets the reader point it at a JSON document of their own
 * (see the store view's catalog URL). The wire shape is the same either way:
 * an array of drafts the bridge's `/skills/save` accepts verbatim, so
 * installing a catalog entry is exactly the same operation as writing one by
 * hand.
 */

import type { SkillDraft } from './skills.ts'

/** Short label rendered as a chip on each store card. */
export interface CatalogEntry extends SkillDraft {
  /** Free-form grouping shown in the card header. */
  group: string
}

/** Shape accepted from a remote catalog URL. */
export type RemoteCatalog = readonly CatalogEntry[]

export const BUNDLED_CATALOG: readonly CatalogEntry[] = [
  {
    group: 'Git',
    name: 'commit-message',
    description: 'Draft a commit message from the staged diff, following the repository\'s existing style.',
    whenToUse: 'Use when the user asks for a commit message, or asks to commit without specifying wording — and only after reading the real diff.',
    modelInvocable: true,
    userInvocable: true,
    body: `# Commit message

Write the message from the change, not from the request.

## Steps

1. Read what is actually staged: \`git diff --cached\` (plus \`git status\` for
   files the diff omits). Never describe a change you have not read.
2. Read the log to inherit the house style — \`git log --oneline -20\`.
   Match its language, capitalisation, and whether it uses a scope prefix.
3. If recent commits carry trailers or ticket numbers, carry them too.

## Shape

- One line, under ~70 characters: what changed, in the imperative
  ("fix parser hang on empty input", not "fixed" or "fixes").
- Explain **why** in the body when the reason is not obvious from the diff —
  the constraint, the incident, the trade-off. Skip the body when the subject
  already says it.
- One commit, one concern. If the staged diff spans two unrelated changes,
  say so instead of papering over it with a summary line.

## Never

- Do not add a "Generated with …" trailer or any tool attribution unless the
  repository already does so.
- Do not claim a test was run because it looks like it would pass.`,
  },
  {
    group: 'Review',
    name: 'code-review',
    description: 'Review a diff for defects that would actually break, ranked by severity, with concrete failure scenarios.',
    whenToUse: 'Use when the user asks for a review of a diff, branch, or pull request and wants problems found rather than a summary.',
    modelInvocable: true,
    userInvocable: true,
    body: `# Code review

A review's job is to find defects, not to describe the change back to its
author. Report the problems; skip the narration.

## What to look for, in order

1. **Correctness** — inputs that make it wrong. Off-by-one, empty collection,
   null, unicode, concurrent callers, retry after partial success.
2. **State and lifetime** — who owns this object, what happens on unmount /
   shutdown / error, is anything disposed twice or never.
3. **Failure paths** — every error branch: swallowed, logged, or propagated?
   A bare \`catch {}\` is a finding.
4. **Boundaries** — user input, external APIs, file contents. Internal calls
   are trusted; boundaries are not.
5. **Test coverage** — behaviour that changed without a test that would fail
   if it regressed.

## How to report

For each finding: the file and line, one sentence naming the defect, and a
concrete failure scenario (inputs and state in, wrong behaviour out). If you
cannot write the scenario, you have a suspicion, not a finding — say so and
drop it, or go read enough code to settle it.

Rank by severity. Do not pad the list with style preferences: if the project
has no formatter config, formatting is not a review finding.

## What not to do

- Do not rewrite the change unless asked. "Consider extracting X" is noise
  next to "this loop skips the last element".
- Do not approve on the strength of the tests passing. Tests passing tells
  you the tests pass.`,
  },
  {
    group: 'Debugging',
    name: 'bug-repro',
    description: 'Turn a vague bug report into a minimal, runnable reproduction before touching the fix.',
    whenToUse: 'Use when given a bug report, a stack trace, or "it does not work" — before proposing any fix.',
    modelInvocable: true,
    userInvocable: true,
    body: `# Bug reproduction

A fix written against an unconfirmed cause is a guess. Reproduce first.

## Steps

1. **Restate the report as a failing assertion.** "Saving a workspace with a
   trailing slash silently drops the last segment" — not "saving is broken".
   If you cannot phrase one, ask; do not start guessing.
2. **Find the shortest path to it.** Read the code path the report names and
   cut until removing anything more makes the symptom disappear. The
   reproduction should be runnable — a test, a script, a shell command.
3. **Run it and watch it fail.** Paste the real output. If it does not fail,
   your model of the bug is wrong; go back to step 1 rather than adjusting the
   fix to match a reproduction that passes.
4. **Only then locate the cause.** The reproduction tells you which layer is
   lying. Fix the layer, not the symptom.
5. **Confirm.** Re-run the reproduction. Remove any scaffolding you added that
   the fix does not need.

## Bias to watch for

When a reproduction is hard to build, the temptation is to fix the most
suspicious code you have already read. That is how a "fix" lands next to the
bug. If you cannot reproduce, say so and report what you ruled out.`,
  },
  {
    group: 'API',
    name: 'api-surface-review',
    description: 'Review an HTTP API surface for naming, versioning, error shape, and changes that would break existing clients.',
    whenToUse: 'Use when adding, changing, or removing HTTP endpoints, request bodies, response fields, or error codes.',
    modelInvocable: true,
    userInvocable: true,
    body: `# API surface review

An endpoint is a promise to clients you cannot redeploy. Review for the
promise, not just the handler.

## Check, in order

1. **Breaking or not.** Removing a field, narrowing a type, tightening
   validation, changing a status code, or making an optional field required
   breaks existing callers. Say explicitly which of these the change does.
   Additive optional fields do not.
2. **Naming.** Resource nouns are plural and stable; verbs live in the method
   or an action sub-path. A name that describes today's implementation will
   read wrong after the next refactor.
3. **Error shape.** One envelope for all failures, with a machine-readable
   code and a message safe to show a user. Distinguish "you sent something
   wrong" (4xx) from "we are broken" (5xx); never answer 200 with an error
   body.
4. **Idempotency.** Retries happen. A mutating endpoint that is not idempotent
   needs an idempotency key or a documented reason it needs none.
5. **Authz at the boundary.** Every endpoint decides who may call it, and that
   decision lives at the edge — not inside a shared helper that a new caller
   might forget to invoke.
6. **Payload limits and pagination.** Unbounded lists and unbounded bodies are
   outages waiting for a big enough customer.

## Report

For each issue: the endpoint, what breaks, and which callers break. Rank
breaking changes first and give the migration path.`,
  },
  {
    group: 'Frontend',
    name: 'ui-change-verify',
    description: 'Verify a UI change in a real browser before calling it done, instead of trusting types and tests.',
    whenToUse: 'Use when finishing any change that alters what the user sees or clicks — and before reporting it as complete.',
    modelInvocable: true,
    userInvocable: true,
    body: `# Verify a UI change

Type checks and unit tests verify code, not features. A rendered page is the
only evidence that a UI change works.

## Steps

1. **Run it the way a user would.** Start the dev server. If you cannot, say
   so plainly — "not verified in a browser" — rather than implying otherwise.
2. **Walk the golden path.** Perform the interaction the change is about, from
   the state a user starts in, not from a state you hand-crafted.
3. **Walk the edges.** Empty list, one item, a very long string, a slow
   request, a failing request. These are where UI changes break.
4. **Check the neighbours.** Anything sharing state, styles, or a parent
   container can regress. If the change moved a mount point, check that
   whatever used to be there still renders.
5. **Look at it.** Take a screenshot and actually read it. Layout bugs are
   invisible in the DOM and obvious in the pixels.

## Report

State what you exercised and what you saw. "Tested the empty state and a
50-item list; both render" is evidence. "Should work" is not.`,
  },
]
