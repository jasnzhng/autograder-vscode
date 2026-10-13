# autograder.io API notes

← [Back to README](../README.md)

autograder.io is open source ([eecs-autograder/autograder-server](https://github.com/eecs-autograder/autograder-server)). The endpoints below were checked against `autograder/rest_api/urls.py`, the submission views, and `rest_api/permissions.py`. Field names match the JSON the server returns. Typed definitions are in [`src/api.ts`](../src/api.ts).

## Authentication

```
Authorization: Token <40-hex-char token>
```

Visiting `https://autograder.io/web/__apitoken__` while signed in downloads the token as a file named `agtoken`. The file contains just the token. Each user has **one** token, and the website's own session uses the same one. `DELETE /api/users/current/revoke_api_token/` revokes it everywhere.

## Read endpoints used

| Endpoint | Used for |
|---|---|
| `GET /api/users/current/` | Validating the token; getting the user pk. |
| `GET /api/users/<pk>/courses_is_enrolled_in/` | The course picker. |
| `GET /api/courses/<pk>/projects/` | The project picker. |
| `GET /api/projects/<pk>/` | Deadline, daily limit, honor pledge, `expected_student_files` (`pattern`, `min_num_matches`, `max_num_matches`). |
| `GET /api/users/<pk>/groups_is_member_of/` | Your group for the project. `num_submits_towards_limit` = submissions used today. |
| `GET /api/groups/<pk>/submissions/` | The submission list. |
| `GET /api/submissions/<pk>/` | Polling a submission's status. |
| `GET /api/submissions/<pk>/results/?feedback_category=…` | Suites → cases → commands with points and feedback settings; mutation-testing suites. |
| `GET /api/submissions/<pk>/ag_test_cmd_results/<pk>/{stdout,stderr}/?feedback_category=…` | A test command's output (plain text). |
| `GET /api/submissions/<pk>/ag_test_cmd_results/<pk>/{stdout,stderr}_diff/?feedback_category=…` | Expected-vs-actual diff (JSON list of strings, see below). |
| `GET /api/submissions/<pk>/ag_test_suite_results/<pk>/{stdout,stderr}/?feedback_category=…` | A suite's setup output. |
| `GET /api/submissions/<pk>/file/?filename=…` | The files you submitted (source maps, hash matching). |

### Student data only

Every submission the extension reads comes from your own group (`groups_is_member_of` → `groups/<pk>/submissions/`). It only requests submissions that appear in that list (or that it just created), and it doesn't call `courses_is_staff_for/`. A staff token could read any student's submissions, which are FERPA-protected records. So even if an IA's workspace ends up bound to a staff project (say, a `makesubmit` with that project's URL), the extension shows only the IA's own group and never anyone else's submissions.

### Feedback categories

A student may request only:

- `normal`, for submissions where `is_past_daily_limit` is false;
- `past_limit_submission`, for submissions where it's true;
- `ultimate_submission`, after the deadline, for the submission that counts, when the course allows it.

Any other request is refused. The extension picks the category from `is_past_daily_limit`.

`fdbk_settings` on each command result says what you may see:

- Your output is visible when `show_actual_stdout` is true **or** `stdout_fdbk_level` is `expected_and_actual` (likewise for stderr). Many projects use only the latter, so checking `show_actual_*` alone would wrongly hide it.
- A diff exists only when the level is `expected_and_actual` and the test has an expected output. Otherwise the diff endpoint answers `200` with an **empty body** (not JSON).

Protected tests usually hide both.

### Output diffs

The server runs GNU `diff` with the expected output first and yours second, and returns one string per line: a two-character prefix (`"  "` in both, `"- "` expected only, `"+ "` yours only) followed by the line **including its `\n`**. A line without a trailing `\n` is the last line of a file that doesn't end in a newline, which is why `"- sausage"` and `"+ sausage\n"` count as different. `\r` is kept inside lines. A matching output may come back as `[]`. The test's ignore-case/whitespace/blank-line options are applied by the server. See `get_diff` in `autograder/core/utils.py`.

## Write endpoints (direct submit only)

| Endpoint | Notes |
|---|---|
| `POST /api/groups/<pk>/submissions/` | Multipart. The body may contain **only** repeated `submitted_files` fields; any other key is rejected as `invalid_fields`. The honor pledge is enforced only by the website's UI. Returns `400` while another submission is still being graded. |
| `POST /api/projects/<pk>/groups/solo_group/` | Creates a one-person group if you don't have one yet. Asked for explicitly, and never called during a dry run. |

### Submission statuses

`received` → `queued` → `being_graded` → `waiting_for_deferred` → `finished_grading`, plus `removed_from_queue`, `rejected` and `error`. The server won't accept a new submission while one is `received`, `queued` or `being_graded`.
