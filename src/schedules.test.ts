import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScheduleSchema,
  listSchedulesSchema,
  listScheduleRunsSchema,
  pauseScheduleSchema,
  resumeScheduleSchema,
  deleteScheduleSchema,
  blockSchema,
} from "./schemas.js";

// A schedule is the one thing an assistant can set up that keeps costing after the conversation
// ends. These guard the two ways that goes wrong: a field silently dropped, and an action that
// starts spending without being asked for explicitly.

test("a Schedule block carries its cadence through the strict block schema", () => {
  // Without these fields on blockSchema, building a scheduled flow with set_workspace_content
  // would be rejected outright — strict() refuses unknown keys, which is the point of it.
  const result = blockSchema.safeParse({
    type: "Schedule",
    label: "Nightly digest",
    schedule: "0 9 * * *",
    scheduleTimeZone: "Europe/Paris",
    rawData: '{"limit":50}',
  });

  assert.equal(result.success, true);
});

test("create_schedule needs a workspace, a block and a cron", () => {
  assert.equal(createScheduleSchema.safeParse({ workspaceId: 1, blockId: 2, cron: "0 9 * * *" }).success, true);
  assert.equal(createScheduleSchema.safeParse({ workspaceId: 1, blockId: 2 }).success, false);
  assert.equal(createScheduleSchema.safeParse({ workspaceId: 1, blockId: 2, cron: "" }).success, false);
});

test("create_schedule rejects a misspelled field instead of ignoring it", () => {
  // "timezone" vs "timeZone" would otherwise be dropped, and the job would run in UTC while the
  // assistant reported the user's local time back to them.
  const result = createScheduleSchema.safeParse({
    workspaceId: 1,
    blockId: 2,
    cron: "0 9 * * *",
    timezone: "Europe/Paris",
  });

  assert.equal(result.success, false);
});

test("the version pin is optional and numeric", () => {
  assert.equal(createScheduleSchema.safeParse({ workspaceId: 1, blockId: 2, cron: "0 9 * * *", versionId: 12 }).success, true);
  assert.equal(createScheduleSchema.safeParse({ workspaceId: 1, blockId: 2, cron: "0 9 * * *", versionId: "latest" }).success, false);
});

test("only the actions that start or destroy something take confirm", () => {
  // Pausing is the safe direction: making it harder than starting would be backwards.
  assert.equal(Object.keys(pauseScheduleSchema.shape).includes("confirm"), false);
  assert.equal(Object.keys(resumeScheduleSchema.shape).includes("confirm"), true);
  assert.equal(Object.keys(deleteScheduleSchema.shape).includes("confirm"), true);
  assert.equal(Object.keys(createScheduleSchema.shape).includes("confirm"), true);
});

test("list_schedules takes a workspace and nothing else", () => {
  assert.equal(listSchedulesSchema.safeParse({ workspaceId: 1 }).success, true);
  assert.equal(listSchedulesSchema.safeParse({ workspaceId: 1, blockId: 2 }).success, false);
});

test("list_schedule_runs is addressed by trigger, not by workspace", () => {
  // Keyed on the trigger because the server resolves access from the trigger's OWN workspace. A
  // workspace id in the call would be a second, caller-supplied source of truth about who may read
  // it — the exact shape that lets a member of one workspace read another's history.
  assert.equal(listScheduleRunsSchema.safeParse({ triggerId: 14 }).success, true);
  assert.equal(listScheduleRunsSchema.safeParse({ workspaceId: 1, triggerId: 14 }).success, false);
  assert.equal(listScheduleRunsSchema.safeParse({}).success, false);
});

test("the run limit is bounded rather than trusted", () => {
  assert.equal(listScheduleRunsSchema.safeParse({ triggerId: 14, limit: 50 }).success, true);
  assert.equal(listScheduleRunsSchema.safeParse({ triggerId: 14, limit: 0 }).success, false);
  // The server caps at 200 as well; agreeing here means the refusal arrives before the round-trip.
  assert.equal(listScheduleRunsSchema.safeParse({ triggerId: 14, limit: 5000 }).success, false);
});

test("reading a schedule's history never asks for confirmation", () => {
  // It writes nothing and spends nothing. Making diagnosis harder than acting is why people skip
  // the diagnosis — which is how a healthy cron gets "fixed" three times before anyone looks.
  assert.equal(Object.keys(listScheduleRunsSchema.shape).includes("confirm"), false);
});

test("update_schedule: the version is optional, confirm gates the repin, unknown fields are refused", async () => {
  const { updateScheduleSchema } = await import("./schemas.js");
  assert.equal(updateScheduleSchema.safeParse({ triggerId: 5 }).success, true);
  assert.equal(updateScheduleSchema.safeParse({ triggerId: 5, versionId: 41, confirm: true }).success, true);
  assert.equal(updateScheduleSchema.safeParse({ triggerId: 5, enabled: true }).success, false);
});
