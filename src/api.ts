// Thin client for the autograder.io REST API.
// Endpoint shapes come from eecs-autograder/autograder-server (rest_api/urls.py and
// submission_views.py); field names mirror the JSON the server returns.

export interface User {
  pk: number;
  username: string;
  first_name: string;
  last_name: string;
}

export interface Course {
  pk: number;
  name: string;
  semester: string | null;
  year: number | null;
}

export interface ExpectedFile {
  pk: number;
  pattern: string;
  min_num_matches: number;
  max_num_matches: number;
}

export interface Project {
  pk: number;
  name: string;
  course: number;
  soft_closing_time: string | null;
  submission_limit_per_day: number | null;
  allow_submissions_past_limit: boolean;
  num_bonus_submissions: number;
  total_submission_limit: number | null;
  disallow_student_submissions: boolean;
  min_group_size: number;
  max_group_size: number;
  expected_student_files: ExpectedFile[];
  use_honor_pledge: boolean;
  honor_pledge_text: string;
  timezone: string;
}

export interface Group {
  pk: number;
  project: number;
  member_names: string[];
  extended_due_date: string | null;
  bonus_submissions_remaining: number;
  num_submissions: number;
  num_submits_towards_limit: number;
}

export type SubmissionStatus =
  | "received"
  | "queued"
  | "being_graded"
  | "waiting_for_deferred"
  | "finished_grading"
  | "removed_from_queue"
  | "rejected"
  | "error";

/** Statuses during which the server refuses a new submission. */
export const ACTIVE_STATUSES: SubmissionStatus[] = ["received", "queued", "being_graded"];

export interface Submission {
  pk: number;
  group: number;
  timestamp: string;
  submitter: string;
  submitted_filenames: string[];
  discarded_files: string[];
  missing_files: Record<string, number>;
  status: SubmissionStatus;
  is_past_daily_limit: boolean;
  is_bonus_submission: boolean;
  position_in_queue: number;
}

export interface CommandResult {
  pk: number;
  ag_test_command_name: string;
  student_description: string;
  student_on_fail_description: string | null;
  timed_out: boolean | null;
  return_code_correct: boolean | null;
  expected_return_code: number | null;
  actual_return_code: number | null;
  stdout_correct: boolean | null;
  stderr_correct: boolean | null;
  total_points: number;
  total_points_possible: number;
  fdbk_settings: {
    visible: boolean;
    show_actual_stdout: boolean;
    show_actual_stderr: boolean;
    stdout_fdbk_level: ValueFeedbackLevel;
    stderr_fdbk_level: ValueFeedbackLevel;
  };
}

export type ValueFeedbackLevel = "no_feedback" | "correct_or_incorrect" | "expected_and_actual";

/** The server shows actual output when either flag allows it (submission_feedback.py _show_actual_stdout),
 *  and only `expected_and_actual` comes with an expected-vs-actual diff. */
export function canSeeOutput(cmd: Pick<CommandResult, "fdbk_settings">, stream: "stdout" | "stderr"): boolean {
  const f = cmd.fdbk_settings;
  return stream === "stdout"
    ? f.show_actual_stdout || f.stdout_fdbk_level === "expected_and_actual"
    : f.show_actual_stderr || f.stderr_fdbk_level === "expected_and_actual";
}

export function hasDiff(cmd: Pick<CommandResult, "fdbk_settings">, stream: "stdout" | "stderr"): boolean {
  return cmd.fdbk_settings[`${stream}_fdbk_level`] === "expected_and_actual";
}

export interface CaseResult {
  pk: number;
  ag_test_case_name: string;
  student_description: string;
  total_points: number;
  total_points_possible: number;
  ag_test_command_results: CommandResult[];
}

export interface SuiteResult {
  pk: number;
  ag_test_suite_name: string;
  student_description: string;
  total_points: number;
  total_points_possible: number;
  setup_name: string | null;
  setup_return_code: number | null;
  setup_timed_out: boolean | null;
  fdbk_settings: { show_setup_stdout: boolean; show_setup_stderr: boolean };
  ag_test_case_results: CaseResult[];
}

export interface MutationSuiteResult {
  pk: number;
  mutation_test_suite_name: string;
  student_tests: string[];
  discarded_tests: string[];
  invalid_tests: string[] | null;
  timed_out_tests: string[] | null;
  num_bugs_exposed: number | null;
  bugs_exposed: string[] | null;
  all_bug_names: string[] | null;
  total_points: number;
  total_points_possible: number;
}

export interface SubmissionResults {
  pk: number;
  total_points: string | number;
  total_points_possible: string | number;
  ag_test_suite_results: SuiteResult[];
  mutation_test_suite_results: MutationSuiteResult[];
}

export type FeedbackCategory = "normal" | "past_limit_submission" | "ultimate_submission";

/** Students may only request `normal` for in-limit submissions and
 *  `past_limit_submission` for the rest (rest_api/permissions.py). */
export function feedbackCategoryFor(sub: Pick<Submission, "is_past_daily_limit">): FeedbackCategory {
  return sub.is_past_daily_limit ? "past_limit_submission" : "normal";
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface UploadFile {
  name: string;
  data: Uint8Array;
}

export class AutograderClient {
  constructor(private baseUrl: string, private token: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
      ...init,
      headers: { Authorization: `Token ${this.token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      let body: unknown = undefined;
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = text; }
      throw new ApiError(res.status, describeError(res.status, body), body);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }

  currentUser() { return this.json<User>("/api/users/current/"); }

  /** Courses you're a student in. Staff courses are deliberately left out: this is a student tool,
   *  and a staff token can read other students' submissions (FERPA-protected), so we never go there. */
  coursesEnrolled(userPk: number) {
    return this.json<Course[]>(`/api/users/${userPk}/courses_is_enrolled_in/`);
  }

  projects(coursePk: number) { return this.json<Project[]>(`/api/courses/${coursePk}/projects/`); }
  project(projectPk: number) { return this.json<Project>(`/api/projects/${projectPk}/`); }

  async myGroup(userPk: number, projectPk: number): Promise<Group | undefined> {
    const groups = await this.json<Group[]>(`/api/users/${userPk}/groups_is_member_of/`);
    return groups.find((g) => g.project === projectPk);
  }

  /** Students in a size-1 project get a group on demand via this endpoint. */
  createSoloGroup(projectPk: number) {
    return this.json<Group>(`/api/projects/${projectPk}/groups/solo_group/`, { method: "POST" });
  }

  group(groupPk: number) { return this.json<Group>(`/api/groups/${groupPk}/`); }
  submissions(groupPk: number) { return this.json<Submission[]>(`/api/groups/${groupPk}/submissions/`); }
  submission(pk: number) { return this.json<Submission>(`/api/submissions/${pk}/`); }

  results(sub: Pick<Submission, "pk" | "is_past_daily_limit">) {
    return this.json<SubmissionResults>(
      `/api/submissions/${sub.pk}/results/?feedback_category=${feedbackCategoryFor(sub)}`);
  }

  async commandOutput(sub: Pick<Submission, "pk" | "is_past_daily_limit">, cmdResultPk: number,
                      stream: "stdout" | "stderr"): Promise<string> {
    const res = await this.request(
      `/api/submissions/${sub.pk}/ag_test_cmd_results/${cmdResultPk}/${stream}/` +
      `?feedback_category=${feedbackCategoryFor(sub)}`);
    return res.text();
  }

  /** Expected-vs-actual diff lines ("  ", "- " expected, "+ " yours), [] when they match,
   *  or null when the test has no expected output or it isn't shown to students. */
  async commandDiff(sub: Pick<Submission, "pk" | "is_past_daily_limit">, cmdResultPk: number,
                    stream: "stdout" | "stderr"): Promise<string[] | null> {
    const res = await this.request(
      `/api/submissions/${sub.pk}/ag_test_cmd_results/${cmdResultPk}/${stream}_diff/` +
      `?feedback_category=${feedbackCategoryFor(sub)}`);
    // "No diff" comes back as an empty body, not JSON.
    const text = (await res.text()).trim();
    const body: unknown = text ? JSON.parse(text) : null;
    return Array.isArray(body) ? body.map(String) : null;
  }

  async suiteSetupOutput(sub: Pick<Submission, "pk" | "is_past_daily_limit">, suiteResultPk: number,
                         stream: "stdout" | "stderr"): Promise<string> {
    const res = await this.request(
      `/api/submissions/${sub.pk}/ag_test_suite_results/${suiteResultPk}/${stream}/` +
      `?feedback_category=${feedbackCategoryFor(sub)}`);
    return res.text();
  }

  async submittedFile(subPk: number, filename: string): Promise<Uint8Array> {
    const res = await this.request(
      `/api/submissions/${subPk}/file/?filename=${encodeURIComponent(filename)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** POST a submission. The server accepts ONLY repeated `submitted_files` fields;
   *  any other key (e.g. an honor-pledge flag) is rejected as an invalid field. */
  submit(groupPk: number, files: UploadFile[]) {
    const form = new FormData();
    for (const f of files) {
      form.append("submitted_files", new Blob([new Uint8Array(f.data)]), f.name);
    }
    return this.json<Submission>(`/api/groups/${groupPk}/submissions/`, { method: "POST", body: form });
  }
}

function describeError(status: number, body: unknown): string {
  if (status === 401) return "Not signed in to autograder.io (token missing or revoked).";
  if (status === 403) return "autograder.io refused the request (403).";
  if (body && typeof body === "object") {
    const parts = Object.entries(body as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : JSON.stringify(v)}`);
    if (parts.length) return parts.join("; ");
  }
  return `autograder.io returned HTTP ${status}${typeof body === "string" && body ? `: ${body.slice(0, 200)}` : ""}`;
}

export function num(x: string | number | null | undefined): number {
  return typeof x === "number" ? x : x ? parseFloat(x) : 0;
}
