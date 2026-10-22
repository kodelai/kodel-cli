# Task adapter for Jira Cloud

Follow-up to `task_backlog_tasks_for_things_the_agent_finds_on_the_way.md`: the `jira` adapter for the task
adapter interface. It is the hardest exam of that interface (workflow graphs, required fields, a rich-text
format), so it comes after the core and the `local` adapter, and preferably after a simpler real adapter
(Linear or GitHub) has passed the conformance suite.

## Scope

Jira Cloud, REST API v3. Jira Data Center (API v2, wiki markup) is out of scope. No new dependency: HTTP through
the injected `fetch` of Node 22 with the call's `AbortSignal`. Everything the agent sees is the interface of the
core plan; this plan says how Jira fills it.

## Verify first

The research for this plan could not open the main v3 reference pages (issues, search, remote links), so the
items below come from secondary sources or memory. **Check each against the official docs before coding** and
record the result here:

| Item | Why it is uncertain |
|---|---|
| `GET /rest/api/3/project/{key}/statuses` (statuses of a project, with category and description) | named from memory |
| `GET /rest/api/3/priority/search` (the old `GET /priority` is deprecated) | named from a secondary source |
| `GET /rest/api/3/issue/createmeta/{project}/issuetypes[/{typeId}]` (types, required fields, allowed values) | named from memory |
| Body of `POST .../transitions`; whether `resolution` is required or set by a post-function | secondary sources |
| `ORDER BY priority` direction (most important first?) | not confirmed |
| Moving a subtask to another parent with `PUT fields.parent` | not confirmed for all project types |
| The lag of search after a create | window not known |
| Label rules (allowed characters, length) for `kodel-run-<id>` | to confirm |
| Token permissions for labels and transitions | depends on the project's permission scheme |

## Config (`tasks.adapters.jira`)

```yaml
tasks:
  enabled: true
  adapter: jira
  adapters:
    jira:
      site: https://acme.atlassian.net
      email: dev@acme.com
      token_env: JIRA_API_TOKEN     # the name of the variable, never the token
      project: KDL
      default_type: Task
      subtask_type: Sub-task
      run_label_prefix: kodel-run-
      fields: { Component: Backend }              # defaults for required create fields
      status_fields: { Done: { resolution: Done } }   # defaults when moving to a status
      transitions: { Done: Resolve Issue }        # which move to take when several lead to a status
```

Basic authentication (`email:token`, base64). The token is read from the environment each time an adapter is
created, never logged and never returned (`redact` covers error messages). A wrong or missing token does not
stop the server: the first call fails with `TASK_AUTH_FAILED` and `kodel task doctor` shows why.

## Capabilities

`{ contract: 1, subtasks: true, runs: "full", comment: "append", fields: true }`. Runs are labels
`kodel-run-<id>` (searchable with JQL `labels = ...`; a run has no URL, so remote links do not fit). Comments
are written to Jira and read back (the last 20). Extra fields (assignee, labels, sprint, ...) are declared in
`schema().fields` with `readonly` and `summary` chosen by the adapter.

## Operations

| Operation | Jira | Notes |
|---|---|---|
| schema: statuses | `GET .../project/{project}/statuses` | `state` from the status category: `new` → `todo`, `indeterminate` → `progress`, `done` → `done` |
| schema: priorities | `GET .../priority/search` | in the order Jira gives (most important first) |
| schema: types and fields | `GET .../issue/createmeta/{project}/issuetypes[/{typeId}]` | `required`, allowed values, field type → `kind`; internal ids in `FieldInfo.id` |
| schema: transitions (with a key) | `GET .../issue/{key}/transitions?expand=transitions.fields` | depend on the current status and the permissions |
| create | `POST /rest/api/3/issue` | `project`, `issuetype`, `summary`, `description` (ADF), `priority`, `labels`, `parent`, other fields; URL is `site/browse/KEY` |
| create: comment | `POST .../issue/{key}/comment` | a second call after the create |
| get | `GET .../issue/{key}?fields=...` | key or numeric id; the numeric id is `Task.id`; an old key redirects after a move |
| update: fields | `PUT .../issue/{key}` | 204, no body; only fields on the edit screen; `clear` sends `null` for the named field |
| update: status | `POST .../issue/{key}/transitions` | `{ transition: {id}, fields?, update: { comment: [{ add: { body } }] } }`: the comment rides in the same request |
| add_run | `PUT .../issue/{key}` with `update.labels: [{ add }]` | idempotent |
| list | `POST /rest/api/3/search/jql` | token paging (`nextPageToken`), 50 per page; the old `/search` is removed |
| parent | `PUT` with `fields.parent` | detach is not possible for a subtask type |

## Rules

- **Keys**: `resolveKey` takes `kdl-12`, `KDL-12`, a bare `12` (the configured project is added) and a
  `.../browse/KDL-12` URL; pattern `[A-Z][A-Z0-9_]+-[1-9][0-9]*`. Always return the current key.
- **Moving to a status X**: take the transitions of the current status and keep those whose target status is `X`
  (case-insensitive). One: do it. Several: use `adapters.jira.transitions[X]`, else `TASK_TRANSITION_REFUSED`
  listing the transitions. None: `TASK_TRANSITION_REFUSED` listing the reachable statuses. Required fields of the
  transition come from the call's `fields`, then from `status_fields[X]`; missing ones are
  `TASK_FIELDS_REQUIRED` with `details.missing` (for example `resolution`). Fields first, then the transition;
  a failure in between reports `details.applied`.
- **Text**: Jira v3 takes descriptions and comments only as ADF. Text to ADF: paragraphs at blank lines, a single
  newline is a `hardBreak`, fenced blocks are `codeBlock`, other markdown stays literal text. ADF to text walks
  `paragraph`, `text`, `hardBreak`, `codeBlock` and lists. The conversion is lossy (rich formatting is lost).
- **JQL** is built from filter values with escaping (strings in double quotes, `"` and `\` escaped); agent
  input is never pasted into JQL as is. `state` maps to `statusCategory` (`todo` = `new`, `progress` =
  `indeterminate`, `done` = `Done`); `priority`, `labels = "kodel-run-<id>"`, `parent = KEY`, `parent is EMPTY`
  for `top_level`, always `project = <project>`. The next-page token of Jira goes into `next` together with a
  hash of the filter. The search lags behind writes: a task just created may not be listed yet; `get` sees it.
- **Subtasks**: created with `subtask_type` and `fields.parent.key`. Jira's own rules apply (a subtask has no
  children, the parent type is restricted by the project); violations are `INVALID_TASK` with Jira's text.
  `clear` with `parent` on a subtask is refused by the adapter without a request.
- **Errors**: 401 `TASK_AUTH_FAILED`; 403 `TASK_AUTH_FAILED` (permissions); 404 is `undefined` for get/update
  (Jira also answers 404 when the issue is not visible); 400 with a field map is `TASK_FIELDS_REQUIRED` when a
  required field is missing, else `INVALID_TASK` with Jira's text; 429 `TASK_RATE_LIMITED` with
  `details.retry_after_s`; 5xx, network, timeout `TASK_ADAPTER_FAILED`. Reads are retried up to twice (with
  `Retry-After`); writes never. Three limits apply at once (hourly, burst, per-issue writes).
- **Create is not retried** (no idempotency key); the agent is told to call `task_list` after a timeout. The
  adapter has no duplicate protection of its own.

## Tests

- The conformance suite on a **fake HTTP server** with recorded Jira answers (the injected `fetch`); no live
  calls in CI.
- Unit tests: ADF both ways; JQL escaping (quotes, backslash, newline); choosing a transition (one, several
  with config, none); `requires` → `TASK_FIELDS_REQUIRED`; mapping of response codes; parsing keys and URLs;
  run label names; trimming the schema to its limits; no token in any error text.
- An optional live test driven by environment variables, off by default.

## Risks

- The verify-first items may change the endpoints or the semantics above.
- Required custom fields vary by project and type; the defaults in config and `TASK_FIELDS_REQUIRED` cover the
  common cases, not all.
- Search lag and the lack of idempotent create make duplicates possible after a timeout.
- Lossy ADF conversion; localized status and priority names (the agent uses the names `task_schema` lists).
