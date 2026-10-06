import assert from "node:assert/strict";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { NotificationInput } from "../src/activities";
import type { OpeningInput, SalonSeed, SalonSnapshot, WaitlistRequest } from "../src/types";
import {
  createOpening,
  getOpeningStatus,
  getSalonState,
  performStaffAction,
  respondToOffer,
  salonCoordinatorWorkflow,
} from "../src/workflows";

function request(id: string, joinedAt: string, failNextDelivery = false): WaitlistRequest {
  return {
    id,
    clientName: id === "first" ? "First Client" : "Second Client",
    mobile: "(555) 014-0000",
    service: "Haircut & Finish",
    currentAppointment: "2026-10-10 4:00 PM",
    stylistPreference: { kind: "none", acceptsAlternatives: true },
    availability: [{ day: "weekday", part: "afternoon" }],
    joinedAt,
    active: true,
    failNextDelivery,
  };
}

function seed(waitlist: WaitlistRequest[]): SalonSeed {
  return {
    waitlist,
    openingHistory: [],
    config: {
      salonName: "Juniper Salon",
      phone: "(555) 014-0188",
      timezone: "America/Los_Angeles",
      demoMode: true,
      policyWindowMinutes: 15,
      demoWindowSeconds: 15,
      services: [{ name: "Haircut & Finish", durationMinutes: 60 }],
      stylists: ["Lena"],
    },
  };
}

function opening(id: string, offerWindowMs = 3_600_000): OpeningInput {
  return {
    id,
    service: "Haircut & Finish",
    stylist: "Lena",
    date: "2026-10-05",
    time: "14:00",
    durationMinutes: 60,
    offerWindowMs,
    createdAt: "2026-10-05T18:00:00.000Z",
  };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Workflow state.");
}

async function withWorker(
  run: (environment: TestWorkflowEnvironment, taskQueue: string) => Promise<void>,
): Promise<void> {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `juniper-test-${Math.random()}`;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("../src/workflows"),
    activities: {
      sendNotification: async (input: NotificationInput) => ({
        delivered: !input.failDelivery,
        deliveredAt: new Date().toISOString(),
      }),
    },
  });
  try {
    await worker.runUntil(() => run(environment, taskQueue));
  } finally {
    await environment.teardown();
  }
}

test("only one acceptance can reserve an opening", async () => {
  await withWorker(async (environment, taskQueue) => {
    const coordinatorId = "coordinator-acceptance";
    const coordinator = await environment.client.workflow.start(salonCoordinatorWorkflow, {
      workflowId: coordinatorId,
      taskQueue,
      args: [coordinatorId, seed([request("first", "2026-10-01T00:00:00.000Z")])],
    });
    const created = await coordinator.executeUpdate(createOpening, { args: [opening("race")] });
    const state = await eventually(
      () => coordinator.query(getSalonState),
      (snapshot) => snapshot.openings.some((item) => item.id === "race" && item.phase === "offering"),
    );
    const token = state.openings.find((item) => item.id === "race")?.currentOffer?.offerToken;
    assert.ok(token);
    const child = environment.client.workflow.getHandle(created.workflowId);
    const outcomes = await Promise.all([
      child.executeUpdate(respondToOffer, { args: [token, "accept"] }),
      child.executeUpdate(respondToOffer, { args: [token, "accept"] }),
    ]);
    assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ["accepted", "unavailable"]);
    const status = await child.query(getOpeningStatus);
    assert.equal(status.phase, "reserved");
    assert.equal(status.calendarTaskPending, true);
    await child.executeUpdate(performStaffAction, { args: ["confirm-calendar"] });
    assert.equal((await child.result()).phase, "confirmed");
  });
});

test("delivery failure immediately advances to the next client", async () => {
  await withWorker(async (environment, taskQueue) => {
    const coordinatorId = "coordinator-delivery";
    const coordinator = await environment.client.workflow.start(salonCoordinatorWorkflow, {
      workflowId: coordinatorId,
      taskQueue,
      args: [
        coordinatorId,
        seed([
          request("first", "2026-10-01T00:00:00.000Z", true),
          request("second", "2026-10-02T00:00:00.000Z"),
        ]),
      ],
    });
    await coordinator.executeUpdate(createOpening, { args: [opening("delivery")] });
    const state = await eventually(
      () => coordinator.query(getSalonState),
      (snapshot) => snapshot.openings.some((item) =>
        item.id === "delivery" && item.currentOffer?.requestId === "second"),
    );
    const item = state.openings.find((entry) => entry.id === "delivery");
    assert.equal(item?.candidates[0].status, "delivery-failed");
    assert.equal(item?.candidates[1].status, "offered");
    assert.ok(state.alerts.some((alert) => alert.message.includes("could not be delivered")));
  });
});

test("a durable timeout closes an unanswered opening", async () => {
  await withWorker(async (environment, taskQueue) => {
    const coordinatorId = "coordinator-timeout";
    const coordinator = await environment.client.workflow.start(salonCoordinatorWorkflow, {
      workflowId: coordinatorId,
      taskQueue,
      args: [coordinatorId, seed([request("first", "2026-10-01T00:00:00.000Z")])],
    });
    const created = await coordinator.executeUpdate(createOpening, { args: [opening("timeout", 1_000)] });
    const result = await environment.client.workflow.getHandle(created.workflowId).result();
    assert.equal(result.phase, "unfilled");
    assert.equal(result.candidates[0].status, "timed-out");
  });
});

test("one request cannot hold offers from concurrent openings", async () => {
  await withWorker(async (environment, taskQueue) => {
    const coordinatorId = "coordinator-concurrent";
    const coordinator = await environment.client.workflow.start(salonCoordinatorWorkflow, {
      workflowId: coordinatorId,
      taskQueue,
      args: [coordinatorId, seed([request("first", "2026-10-01T00:00:00.000Z")])],
    });
    await Promise.all([
      coordinator.executeUpdate(createOpening, { args: [opening("concurrent-a")] }),
      coordinator.executeUpdate(createOpening, { args: [opening("concurrent-b")] }),
    ]);
    let state = await eventually(
      () => coordinator.query(getSalonState),
      (snapshot: SalonSnapshot) => {
        const items = snapshot.openings.filter((item) => item.id.startsWith("concurrent"));
        return items.filter((item) => item.phase === "offering").length === 1 &&
          items.filter((item) => item.candidates.some((candidate) =>
            candidate.status === "reserved-elsewhere")).length === 1;
      },
    );
    let concurrent = state.openings.filter((item) => item.id.startsWith("concurrent"));
    assert.equal(concurrent.filter((item) => item.phase === "offering").length, 1);
    assert.equal(concurrent.filter((item) =>
      item.candidates.some((candidate) => candidate.status === "reserved-elsewhere")).length, 1);
    const firstOpening = concurrent.find((item) => item.phase === "offering");
    assert.ok(firstOpening?.currentOffer);
    await environment.client.workflow
      .getHandle(firstOpening.workflowId)
      .executeUpdate(respondToOffer, {
        args: [firstOpening.currentOffer.offerToken, "decline"],
      });
    state = await eventually(
      () => coordinator.query(getSalonState),
      (snapshot) => snapshot.openings.some((item) =>
        item.id.startsWith("concurrent") &&
        item.id !== firstOpening.id &&
        item.phase === "offering"),
    );
    concurrent = state.openings.filter((item) => item.id.startsWith("concurrent"));
    assert.equal(concurrent.filter((item) => item.phase === "offering").length, 1);
  });
});

test("staff can stop, reopen with the next client, and cancel", async () => {
  await withWorker(async (environment, taskQueue) => {
    const coordinatorId = "coordinator-control";
    const coordinator = await environment.client.workflow.start(salonCoordinatorWorkflow, {
      workflowId: coordinatorId,
      taskQueue,
      args: [
        coordinatorId,
        seed([
          request("first", "2026-10-01T00:00:00.000Z"),
          request("second", "2026-10-02T00:00:00.000Z"),
        ]),
      ],
    });
    const created = await coordinator.executeUpdate(createOpening, { args: [opening("control")] });
    const child = environment.client.workflow.getHandle(created.workflowId);
    await eventually(() => child.query(getOpeningStatus), (status) => status.currentOffer?.requestId === "first");
    await child.executeUpdate(performStaffAction, { args: ["stop"] });
    assert.equal((await child.query(getOpeningStatus)).phase, "stopped");
    await child.executeUpdate(performStaffAction, { args: ["reopen"] });
    const reopened = await eventually(
      () => child.query(getOpeningStatus),
      (status) => status.currentOffer?.requestId === "second",
    );
    assert.equal(reopened.candidates[0].status, "revoked");
    await child.executeUpdate(performStaffAction, { args: ["cancel"] });
    assert.equal((await child.result()).phase, "canceled");
  });
});
