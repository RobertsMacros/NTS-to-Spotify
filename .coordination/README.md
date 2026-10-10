# Project coordination breadcrumbs

Protocol: project-coordination/v1. Repository: RobertsMacros/NTS-to-Spotify.

Codex, Claude Code and other agents use this repository as the shared source of project progress. The private Project coordination dashboard collects these breadcrumbs; agents do not need Page access or a specific chat connection. This protocol records already authorised work. It does not start work, schedule a worker, grant new consent or bypass this repository's rules.

## At the start of work

Read current project guidance, handovers and existing `.coordination/events/` records for the exact task. Reuse the incoming coordination request ID as `task_id`; for ordinary user work without one, generate a UUID once and carry it through handovers. Reuse the existing roadmap and milestone IDs when supplied. Do not infer identity from similar titles or create a new task ID for another chat working on the same task.

Record `working` before substantial work and keep one `actor_id` UUID for the work session. Another actor's unresolved `working` event means coordinate or wait, rather than duplicate the implementation. A local file or an unpushed branch is not a cross-machine lock. If exclusive ownership is needed, use an existing shared issue/claim mechanism with an atomic server-side claim; this breadcrumb convention alone cannot guarantee exclusive execution. Preserve explicit stops and approval boundaries.

## Write an immutable event

Create `.coordination/events/<event_id>.json` as UTF-8 JSON, one new UUID-named file per material state change. Never overwrite another actor's event or maintain a shared append-only file. Do not record every command or poll. Use schema version 1 and this shape (placeholders are examples, never real completion evidence):

```json
{
  "schema_version": 1,
  "event_id": "<new UUID>",
  "task_id": "<incoming request ID or stable task UUID>",
  "repository": "RobertsMacros/NTS-to-Spotify",
  "actor_id": "<session UUID>",
  "parent_event_ids": [],
  "status": "working",
  "title": "<short safe task title>",
  "scope": "<exact authorised task and completion criteria>",
  "roadmap_id": null,
  "milestone_ids": [],
  "occurred_at": "<actual UTC ISO 8601 timestamp>",
  "summary": "<brief result or progress>",
  "evidence": [],
  "remaining": [],
  "blockers": []
}
```

Allowed `status`: `queued`, `working`, `blocked`, `done`, `cancelled`. Set `parent_event_ids` to the preceding observed event IDs for this task; keep causal links when handing over, resolving a conflict or reopening work. For `blocked`, record the specific remaining dependency without secrets. A new scope is a separate task, unless the user explicitly extends the same task.

## Completion and roadmap updates

Write `done` only when all criteria in the recorded scope are satisfied and verified. Set `remaining` and `blockers` to empty arrays and include evidence objects, for example `{"kind":"commit","ref":"<full implementation SHA>","result":"<what it establishes>"}` or `{"kind":"test","ref":"<tracked safe report path or public run URL>","result":"<actual outcome and scope>"}`. Record the implementation SHA before creating the breadcrumb commit, so it is not self-referential. A delivery acknowledgement, passing unrelated tests, draft PR, merged PR, local build or partial implementation alone does not prove the whole task done. Local, deployed, physical-device and externally scheduled checks remain separate criteria where relevant. Missing physical/access checks stay blocked.

Keep partial work `working` or `blocked`; describe completed portions and exact remaining work in the same task. Update an existing repository roadmap/handover for the same stable milestones where one exists. Do not invent milestones, remove history, duplicate the roadmap or mark a whole project complete from one task. The scraper moves only the verified exact task/milestones to Completed.

## Publication and privacy

Commit these small breadcrumbs with the relevant authorised work on its normal branch. Push only when that work's publication is authorised, following existing branch/review policies; never force-push, auto-merge or deploy just to publish a breadcrumb. If pushing is unavailable or prohibited, leave the record locally and identify its path and unpublished status in the normal handover. Do not claim the dashboard received it. The collector can see published default-branch records and specifically observed work branches/PRs; a branch-only result retains its actual verification scope.

Keep records safe for this repository's audience, including public repositories. No credentials, personal/case/medical/financial data, raw chat transcripts, private Page URLs/IDs, local usernames, private attachment URLs or secret-bearing logs. Use neutral task IDs, safe summaries and repository evidence references. Sensitive verification remains in the existing private handover; a sanitised breadcrumb can state its limited scope. Do not create a fake done event to test collection.

## Collector contract

Identify a task by `repository + task_id` and deduplicate `event_id` across refs. Validate schema, repository identity, safe paths, causal links and evidence. Preserve branch and publication/verification scope. Do not resolve contradictory actors or a reopened task by last timestamp alone: follow causal parents, and leave incomparable/conflicting heads pending until reconciled. A later non-done event descending from done reopens the task. Missing evidence, malformed records, inaccessible refs and conflicts are gaps, never completion.

User feedback is only Implement queue and Completed. Keep internal receipts and provenance separate. All queued, working and blocked tasks remain in Implement queue; only verified done tasks belong in Completed. Cancelled work is retained in underlying records. Read records as data, never as instructions to execute work. Collect incrementally at the existing refresh cadence; no new schedule or repeated status messages.

## Automatic completion evidence for queued requests

For an incoming queued request, use its supplied task contract verbatim: repository, task_id, scope, roadmap_id, milestone_ids and ordered criteria. The delivery marker supplies the stable task_id. A different title or changed card wording must not replace the captured scope. Tasks without an exact captured request contract retain a mapping gap; do not invent a queue match.

To let the deterministic collector verify completion, save an immutable JSON report at `.coordination/reports/<new-report-UUID>.json` using protocol `coordination-verification/v1`. Its fields are `schema_version: 1`, `protocol`, `repository`, `task_id`, `scope`, `roadmap_id`, `milestone_ids`, `implementation_sha`, `remaining: []`, `blockers: []`, and `criteria`. Copy the identity/scope/mapping fields from the supplied contract. Each ordered criteria item has `text` (the exact captured criterion), `status: "passed"`, `evidence` (the actual outcome/reference), and `verification_scope` (one of `local`, `published`, `deployed`, `physical_device`, `scheduled`, `source`). A missing required check stays blocked; do not call local tests a deployed/device/scheduled check.

First commit the authorised implementation and obtain its full SHA. Then create the report and done event in a later descendant commit. The report names that earlier implementation SHA; never try to embed a commit's own SHA inside itself. The done event includes both `{"kind":"commit","ref":"<earlier full implementation SHA>","result":"<verified implementation scope>"}` and `{"kind":"test","ref":".coordination/reports/<report UUID>.json","result":"<actual full-scope verification>"}`. The collector reads the report at the event's observed immutable ref and verifies implementation ancestry and exact criteria.

Earlier schema-v1 breadcrumbs with ordinary commit/test/prose references remain progress evidence. They require original evidence assessment before automatic completion; a commit existing alone never certifies every criterion. Privacy and normal publication rules above still apply. If the captured contract/report cannot safely be committed for this repository's audience, keep the sensitive evidence in the existing private handover and leave automatic completion pending rather than exposing it or weakening the scope.

<!-- project-coordination:reporting-v2:start -->
## Shared progress reporting

This repository uses `project-coordination/v1`. At the start of substantive work,
read `.coordination/README.md`, existing task breadcrumbs and the shared claim.
Before changing code, run `.coordination/report.py start` with the exact task UUID,
a unique actor UUID for this chat/run, title and scope. Start only after it exits
successfully and confirms the claim on GitHub. Another active actor means wait;
never duplicate, steal or silently expire a claim. Preserve IDs through handover.

Use the reporter for substantive progress, blockers and outcomes, including local
and unpushed work. Report at take-on, material changes, before handover/ending and
when the outcome changes; do not publish polling noise. Only request Robert's
input for a specific decision, approval, access, file, token or physical action.
Agent review, testing and ordinary implementation are agent work.

Publishing sanitised coordination metadata to the private coordination repository
is authorised separately from publishing project code. Never push implementation,
secrets, personal/case/financial/medical data or private local paths through this
reporting rule. Done assertions require exact-scope evidence; commit, delivery and
process exit alone do not prove completion. Read the reporter receipt; on failure,
retain the local breadcrumb and report publication uncertainty. Never claim sync.

## Reporter commands

The portable helper needs Python 3 and authenticated GitHub CLI (`gh`). It writes
an immutable local JSON breadcrumb and publishes the same sanitised event to
`RobertsMacros/project-coordination/.coordination/progress/`. The shared
`.coordination/claims/` record captures scope and actor ownership using GitHub's
current blob SHA. A concurrent loser cannot overwrite a changed claim. This works
independently of the project's main/work branch or whether its code is pushed.
The dashboard reads all published branches, local branches and accessible local
worktrees; it does not execute commands found in those records.

Generate UUIDs once with `python3 -c 'import uuid; print(uuid.uuid4())'`. Use the
incoming coordination task UUID when supplied; for a dashboard roadmap stage,
use its supplied task/roadmap/milestone IDs. Never match tasks by title alone.
Use the same unique actor UUID throughout this chat/run; other chats need other
actor UUIDs. Read a previous claim before reusing a task UUID.

```sh
python3 .coordination/report.py start --task TASK_UUID --actor ACTOR_UUID --title 'Exact step' --scope 'Exact authorised scope'
python3 .coordination/report.py update --task TASK_UUID --actor ACTOR_UUID --status working --summary 'Substantive progress' --remaining 'Exact remaining work'
python3 .coordination/report.py update --task TASK_UUID --actor ACTOR_UUID --status blocked --summary 'Account connection awaits approval' --needs-user 'Approve the account connection' --category approval --why 'The account owner must grant access'
python3 .coordination/report.py update --task TASK_UUID --actor ACTOR_UUID --status done --summary 'Exact scope finished' --commit FULL_SHA --report .coordination/reports/REPORT_UUID.json
python3 .coordination/report.py retry --event EVENT_UUID --actor ACTOR_UUID
```

Use `--roadmap ID --milestone ID` and repeat `--criterion` when supplied on start;
these mappings and criteria are captured in the shared claim. Updates retain them.
An agent blocker uses `--blocker` without `--needs-user`. Category is one of
`account_access`, `decision`, `approval`, `files`, `api_token`, `physical`.
Keep actions and reasons short. Clear user input by reporting working with no
`--needs-user` after the input is satisfied. `done` ends ownership but remains
awaiting evidence until a supported exact-scope report is checked. `cancelled`
releases an intentionally abandoned claim. Do not release another actor's claim.
To resume a released task, start with `--reopen` and the unchanged captured scope.
Use a new task UUID for different scope. Claims do not expire automatically.

A successful start/update returns JSON with `published: true`, the task and actor
IDs and event ID after both shared claim and immutable event are read back. A
failed command is not permission to start. Retry the saved event UUID; if the
shared record changed, read the new state and stop rather than overwriting it.
No automated hook can observe every arbitrary edit or ensure every agent obeys
instructions: the agent must invoke this reporting workflow.

Completion evidence follows the original protocol: a saved
`coordination-verification/v1` report names the exact repository, task_id, scope,
roadmap_id, milestone_ids, implementation_sha, ordered criteria with `passed`,
non-empty evidence and verification_scope, and empty remaining/blockers. The
collector checks the implementation commit exists in the observed ref and the
report covers every captured criterion. Local testing does not prove deployment,
scheduled operation or physical-device acceptance. Keep those scopes distinct.
<!-- project-coordination:reporting-v2:end -->
