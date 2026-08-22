# Repository Guidelines

## Project Purpose

This repository is a proof-of-concept conversational AI tutor. The long-term product should learn from lecture slides, PDFs, books, and lecture transcripts, then teach that material through natural spoken conversation.

The intended experience must support true conversational interruption: a learner can speak while the tutor is talking, the tutor immediately stops and listens, responds naturally, remembers where the lesson was interrupted, and resumes from the correct point. Over time, the product should also track learner understanding and misconceptions.

## Proof-of-Concept Priorities

Work in this order unless the user explicitly changes the priorities:

1. Realtime, natural voice conversation.
2. Reliable interruption and barge-in behavior.
3. Answers grounded in uploaded course material.
4. Lesson-state recovery after interruptions.
5. Simple learner mastery tracking.

Protect the earlier priorities when implementing later ones. A feature that makes interruption handling or realtime conversation less reliable should not be accepted merely to add broader functionality.

## Engineering Constraints

- Use Next.js and TypeScript.
- Keep the proof of concept simple; do not design prematurely for hypothetical scale.
- Make small, incremental, reviewable changes.
- Do not add a database unless the user explicitly requests one. Prefer in-memory state or simple local fixtures for the proof of concept when persistence is not required.
- Never expose API keys, secrets, or privileged provider credentials in frontend code. Keep secrets server-side and access them through server-only modules, route handlers, or equivalent trusted boundaries.
- The project must work on both Windows and macOS. Prefer cross-platform Node.js scripts and APIs, and avoid operating-system-specific shell commands where practical.
- Add dependencies only when they provide clear value for the current proof-of-concept requirement.
- Explain important architecture decisions, especially decisions involving realtime audio, interruption handling, grounding, lesson state, security boundaries, or new infrastructure.

## Implementation Guidance

- Treat interruption as an explicit state transition, not merely a UI event. Preserve enough lesson state to know what the tutor was explaining and where a useful resumption should begin.
- Keep realtime conversation, course-material retrieval, lesson progression, and learner mastery conceptually separate, but introduce abstractions only when the current implementation needs them.
- Prefer the smallest viable grounding pipeline for uploaded materials. Make source attribution and uncertainty visible where useful, and do not present unsupported model knowledge as if it came from course material.
- Start mastery tracking with a transparent, simple representation. Avoid opaque scoring systems until product requirements justify them.
- Keep browser/server boundaries clear. Assume all client-delivered code and network traffic can be inspected by users.
- Where browser or provider behavior differs, choose standards-based APIs and document any unavoidable platform limitations.

## Validation

After code changes, run the repository's existing type-check and production build commands. If the repository does not yet define them, add conventional package scripts when application setup is explicitly requested. Also run focused tests or linting when they exist and are relevant.

Report which checks ran and whether they passed. If a check cannot run, explain why rather than silently skipping it.

For documentation-only changes, verify the changed file for correctness; a full application build is unnecessary unless the documentation affects generated or validated output.

## Scope Discipline

- Implement only what the current request requires.
- Do not create the application, add infrastructure, or select external AI/voice providers unless requested.
- Preserve existing user changes and avoid unrelated refactors.
- When a choice has meaningful architectural consequences, state the decision and its tradeoffs succinctly.
