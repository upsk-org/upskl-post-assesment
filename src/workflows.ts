import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  startChild,
  uuid4,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  CandidateProgress,
  OfferResponseResult,
  OpeningEvent,
  OpeningInput,
  OpeningStatus,
  OpeningWorkflowInput,
  ReservationDecision,
  ReservationRequest,
  SalonSeed,
  SalonSnapshot,
  StaffAction,
  StaffActionResult,
  StaffAlert,
  WaitlistMutationResult,
  WaitlistRequest,
  WaitlistRequestInput,
} from "./types";

const { sendNotification } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 1 },
});

export const getSalonState = defineQuery<SalonSnapshot>("getSalonState");
export const addWaitlistRequest = defineUpdate<WaitlistMutationResult, [WaitlistRequestInput]>("addWaitlistRequest");
export const updateWaitlistRequest = defineUpdate<WaitlistMutationResult, [string, Partial<WaitlistRequestInput>]>("updateWaitlistRequest");
export const createOpening = defineUpdate<OpeningStatus, [OpeningInput]>("createOpening");
export const resetSalonDemo = defineUpdate<SalonSnapshot, [SalonSeed]>("resetSalonDemo");

export const reservationRequested = defineSignal<[ReservationRequest]>("reservationRequested");
export const reservationDecided = defineSignal<[ReservationDecision]>("reservationDecided");
export const reservationReleased = defineSignal<[{ requestId: string; openingId: string }]>("reservationReleased");
export const requestAccepted = defineSignal<[{ requestId: string; openingId: string }]>("requestAccepted");
export const deliveryFailureConsumed = defineSignal<[string]>("deliveryFailureConsumed");
export const openingChanged = defineSignal<[OpeningStatus]>("openingChanged");

export const getOpeningStatus = defineQuery<OpeningStatus>("getOpeningStatus");
export const respondToOffer = defineUpdate<OfferResponseResult, [string, "accept" | "decline"]>("respondToOffer");
export const performStaffAction = defineUpdate<StaffActionResult, [StaffAction]>("performStaffAction");

function isoNow(): string {
  return new Date(Date.now()).toISOString();
}

function isTerminal(phase: OpeningStatus["phase"]): boolean {
  return phase === "confirmed" || phase === "canceled";
}

function isActive(phase: OpeningStatus["phase"]): boolean {
  return !["confirmed", "canceled", "unfilled"].includes(phase);
}

function cloneSnapshot(
  waitlist: WaitlistRequest[],
  openings: Record<string, OpeningStatus>,
  alerts: StaffAlert[],
  reservations: Record<string, string>,
  config: SalonSeed["config"],
): SalonSnapshot {
  const openingList = Object.values(openings).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const opportunities = openingList.filter((opening) => opening.phase !== "canceled");
  const refilled = opportunities.filter((opening) => ["reserved", "confirmed"].includes(opening.phase)).length;
  return {
    waitlist: [...waitlist].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)),
    openings: openingList,
    alerts: alerts.slice(-12).reverse(),
    reservations: { ...reservations },
    metrics: {
      openingsThisWeek: opportunities.length,
      refilledThisWeek: refilled,
      refillRate: opportunities.length ? Math.round((refilled / opportunities.length) * 100) : 0,
      activeOpenings: openingList.filter((opening) => isActive(opening.phase)).length,
    },
    config,
    updatedAt: isoNow(),
  };
}

function matchingCandidates(waitlist: WaitlistRequest[], opening: OpeningInput): WaitlistRequest[] {
  const day = new Date(`${opening.date}T12:00:00Z`).getUTCDay() === 6 ? "saturday" : "weekday";
  const hour = Number(opening.time.slice(0, 2));
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  return waitlist
    .filter((request) => {
      if (!request.active || request.service !== opening.service) return false;
      if (!request.availability.some((slot) => slot.day === day && slot.part === part)) return false;
      const preference = request.stylistPreference;
      if (preference.kind === "required") return preference.stylist === opening.stylist;
      if (preference.kind === "preferred" && !preference.acceptsAlternatives) {
        return preference.stylist === opening.stylist;
      }
      return true;
    })
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

function initialOpeningStatus(
  opening: OpeningInput,
  workflowId: string,
  candidates: WaitlistRequest[],
): OpeningStatus {
  const at = isoNow();
  return {
    ...opening,
    workflowId,
    phase: "matching",
    candidates: candidates.map((candidate) => ({
      requestId: candidate.id,
      clientName: candidate.clientName,
      joinedAt: candidate.joinedAt,
      status: "waiting",
    })),
    calendarTaskPending: false,
    events: [{
      at,
      kind: "info",
      message: candidates.length
        ? `${candidates.length} matching ${candidates.length === 1 ? "client" : "clients"} found in waitlist order.`
        : "No eligible clients were found.",
    }],
    updatedAt: at,
  };
}

export async function salonCoordinatorWorkflow(
  coordinatorWorkflowId: string,
  seed: SalonSeed,
): Promise<void> {
  let waitlist = [...seed.waitlist];
  let config = seed.config;
  let generation = 1;
  let openings: Record<string, OpeningStatus> = Object.fromEntries(
    seed.openingHistory.map((opening) => [opening.id, opening]),
  );
  let reservations: Record<string, string> = {};
  let reservationWaiters: Record<
    string,
    Array<{ openingWorkflowId: string; openingId: string }>
  > = {};
  let alerts: StaffAlert[] = [];
  const snapshot = () => cloneSnapshot(waitlist, openings, alerts, reservations, config);

  setHandler(getSalonState, snapshot);

  setHandler(addWaitlistRequest, (input) => {
    const exact = waitlist.find((request) =>
      request.active &&
      request.mobile === input.mobile &&
      request.service === input.service &&
      request.currentAppointment === input.currentAppointment,
    );
    if (exact) throw new Error("An active request already exists for this appointment and service.");
    const similarRequestIds = waitlist
      .filter((request) => request.active && (request.mobile === input.mobile || request.clientName === input.clientName))
      .map((request) => request.id);
    const request: WaitlistRequest = {
      ...input,
      id: input.id ?? uuid4(),
      joinedAt: input.joinedAt ?? isoNow(),
      active: input.active ?? true,
    };
    waitlist.push(request);
    return { request, similarRequestIds };
  });

  setHandler(updateWaitlistRequest, (requestId, changes) => {
    const index = waitlist.findIndex((request) => request.id === requestId);
    if (index < 0) throw new Error("Waitlist request not found.");
    const updated = { ...waitlist[index], ...changes, id: requestId };
    waitlist[index] = updated;
    const similarRequestIds = waitlist
      .filter((request) => request.id !== requestId && request.active &&
        (request.mobile === updated.mobile || request.clientName === updated.clientName))
      .map((request) => request.id);
    return { request: updated, similarRequestIds };
  });

  setHandler(createOpening, async (opening) => {
    if (openings[opening.id]) throw new Error("This opening already exists.");
    const candidates = matchingCandidates(waitlist, opening);
    const workflowId = `juniper-opening-${generation}-${opening.id}`;
    const initial = initialOpeningStatus(opening, workflowId, candidates);
    openings[opening.id] = initial;
    await startChild(openingWorkflow, {
      workflowId,
      args: [{ opening, workflowId, coordinatorWorkflowId, candidates, salonName: config.salonName, salonPhone: config.phone }],
    });
    return initial;
  });

  setHandler(reservationRequested, async (request) => {
    const waitlistRequest = waitlist.find((item) => item.id === request.requestId);
    const existing = reservations[request.requestId];
    const granted = Boolean(waitlistRequest?.active && (!existing || existing === request.openingId));
    if (granted) reservations[request.requestId] = request.openingId;
    if (!granted && waitlistRequest?.active) {
      const waiters = reservationWaiters[request.requestId] ?? [];
      if (!waiters.some((waiter) => waiter.openingWorkflowId === request.openingWorkflowId)) {
        waiters.push({
          openingWorkflowId: request.openingWorkflowId,
          openingId: request.openingId,
        });
      }
      reservationWaiters[request.requestId] = waiters;
    }
    await getExternalWorkflowHandle(request.openingWorkflowId).signal(reservationDecided, {
      requestId: request.requestId,
      granted,
      final: !waitlistRequest?.active,
    });
  });

  setHandler(reservationReleased, async ({ requestId, openingId }) => {
    if (reservations[requestId] === openingId) delete reservations[requestId];
    const request = waitlist.find((item) => item.id === requestId);
    const waiters = reservationWaiters[requestId] ?? [];
    while (request?.active && waiters.length) {
      const next = waiters.shift();
      if (!next) break;
      reservations[requestId] = next.openingId;
      try {
        await getExternalWorkflowHandle(next.openingWorkflowId).signal(
          reservationDecided,
          { requestId, granted: true },
        );
        break;
      } catch {
        delete reservations[requestId];
      }
    }
    if (waiters.length) reservationWaiters[requestId] = waiters;
    else delete reservationWaiters[requestId];
  });

  setHandler(requestAccepted, async ({ requestId, openingId }) => {
    const request = waitlist.find((item) => item.id === requestId);
    if (request) request.active = false;
    if (reservations[requestId] === openingId) delete reservations[requestId];
    const waiters = reservationWaiters[requestId] ?? [];
    delete reservationWaiters[requestId];
    await Promise.all(waiters.map(async (waiter) => {
      try {
        await getExternalWorkflowHandle(waiter.openingWorkflowId).signal(
          reservationDecided,
          { requestId, granted: false, final: true },
        );
      } catch {
        // The waiting opening may already be closed.
      }
    }));
  });

  setHandler(deliveryFailureConsumed, (requestId) => {
    const request = waitlist.find((item) => item.id === requestId);
    if (request) request.failNextDelivery = false;
  });

  setHandler(openingChanged, (opening) => {
    openings[opening.id] = opening;
    const latest = opening.events.at(-1);
    if (latest?.kind === "attention") {
      const id = `${opening.id}:${latest.at}:${latest.message}`;
      if (!alerts.some((alert) => alert.id === id)) {
        alerts.push({ id, openingId: opening.id, createdAt: latest.at, message: latest.message });
      }
    }
  });

  setHandler(resetSalonDemo, async (nextSeed) => {
    const activeIds = Object.values(openings)
      .filter((opening) => !opening.sample && !isTerminal(opening.phase))
      .map((opening) => opening.workflowId);
    await Promise.all(activeIds.map(async (workflowId) => {
      try {
        await getExternalWorkflowHandle(workflowId).cancel();
      } catch {
        // A child may complete between reading state and cancellation.
      }
    }));
    generation += 1;
    waitlist = [...nextSeed.waitlist];
    config = nextSeed.config;
    openings = Object.fromEntries(nextSeed.openingHistory.map((opening) => [opening.id, opening]));
    reservations = {};
    reservationWaiters = {};
    alerts = [];
    return snapshot();
  });

  await condition(() => false);
}

function addEvent(status: OpeningStatus, message: string, kind: OpeningEvent["kind"] = "info"): void {
  const at = isoNow();
  status.events.push({ at, kind, message });
  status.updatedAt = at;
}

export async function openingWorkflow(input: OpeningWorkflowInput): Promise<OpeningStatus> {
  const coordinator = getExternalWorkflowHandle(input.coordinatorWorkflowId);
  const status = initialOpeningStatus(input.opening, input.workflowId, input.candidates);
  let reservationDecision: ReservationDecision | undefined;
  let offerResponse: "accept" | "decline" | undefined;
  let staffAction: StaffAction | undefined;
  const publish = async () => coordinator.signal(openingChanged, status);
  // Signal and Update handlers mutate these values between Workflow tasks. Small
  // accessors keep TypeScript from incorrectly narrowing them across awaits.
  const currentPhase = (): OpeningStatus["phase"] => status.phase;
  const currentReservation = (): ReservationDecision | undefined => reservationDecision;
  const currentResponse = (): "accept" | "decline" | undefined => offerResponse;
  const finish = async (): Promise<OpeningStatus> => {
    await condition(allHandlersFinished);
    return status;
  };

  setHandler(getOpeningStatus, () => status);
  setHandler(reservationDecided, (decision) => { reservationDecision = decision; });

  setHandler(respondToOffer, async (token, response) => {
    const candidate = status.candidates.find((item) => item.offerToken === token);
    if (!candidate || status.phase !== "offering" || status.currentOffer?.offerToken !== token) {
      return {
        outcome: "unavailable",
        message: "This opening is no longer available, but you remain on the waitlist.",
      };
    }
    candidate.respondedAt = isoNow();
    status.currentOffer = undefined;
    offerResponse = response;
    if (response === "accept") {
      candidate.status = "accepted";
      status.phase = "reserved";
      status.reservedFor = candidate.clientName;
      status.calendarTaskPending = true;
      addEvent(status, `${candidate.clientName} accepted. The opening is reserved while staff updates Square.`, "success");
      await publish();
      return {
        outcome: "accepted",
        message: `You're reserved with ${status.stylist} on ${status.date} at ${status.time}.`,
      };
    }
    candidate.status = "declined";
    status.phase = "matching";
    addEvent(status, `${candidate.clientName} declined. Moving to the next client.`);
    await publish();
    return { outcome: "declined", message: "Thanks for letting us know. You remain on the waitlist." };
  });

  setHandler(performStaffAction, async (action) => {
    if (action === "confirm-calendar") {
      if (status.phase !== "reserved") {
        return { accepted: false, message: "There is no reservation to confirm.", phase: status.phase };
      }
      status.phase = "confirmed";
      status.calendarTaskPending = false;
      staffAction = action;
      addEvent(status, "Square was updated. The appointment is confirmed.", "success");
    } else if (action === "cancel-acceptance") {
      if (status.phase !== "reserved") {
        return { accepted: false, message: "There is no accepted offer to cancel.", phase: status.phase };
      }
      const accepted = status.candidates.find((candidate) => candidate.status === "accepted");
      if (accepted) accepted.status = "acceptance-canceled";
      status.phase = "stopped";
      status.calendarTaskPending = false;
      status.reservedFor = undefined;
      staffAction = action;
      addEvent(status, "The accepted offer was canceled. Outreach can be reopened.", "attention");
    } else if (action === "reopen") {
      if (status.phase !== "stopped") {
        return { accepted: false, message: "Only stopped outreach can be reopened.", phase: status.phase };
      }
      status.phase = "matching";
      staffAction = action;
      addEvent(status, "Outreach reopened. Looking for the next client.");
    } else if (action === "stop") {
      if (isTerminal(status.phase) || status.phase === "stopped") {
        return { accepted: false, message: "Outreach is not currently running.", phase: status.phase };
      }
      const active = status.candidates.find((candidate) => candidate.status === "offered");
      if (active) {
        active.status = "revoked";
        active.respondedAt = isoNow();
      }
      status.currentOffer = undefined;
      status.phase = "stopped";
      staffAction = action;
      addEvent(status, "Staff stopped outreach. The opening remains unfilled.", "attention");
    } else {
      if (isTerminal(status.phase)) {
        return { accepted: false, message: "The opening is already closed.", phase: status.phase };
      }
      const active = status.candidates.find((candidate) => candidate.status === "offered");
      if (active) {
        active.status = "revoked";
        active.respondedAt = isoNow();
      }
      status.currentOffer = undefined;
      status.phase = "canceled";
      status.calendarTaskPending = false;
      staffAction = action;
      addEvent(status, "The opening was canceled and outstanding offers were closed.", "attention");
    }
    await publish();
    return { accepted: true, message: status.events.at(-1)?.message ?? "Updated.", phase: status.phase };
  });

  await publish();

  for (const request of input.candidates) {
    while (currentPhase() === "stopped") await condition(() => currentPhase() !== "stopped");
    if (currentPhase() === "canceled" || currentPhase() === "confirmed") return finish();

    const candidate = status.candidates.find((item) => item.requestId === request.id) as CandidateProgress;
    reservationDecision = undefined;
    await coordinator.signal(reservationRequested, {
      openingWorkflowId: input.workflowId,
      openingId: input.opening.id,
      requestId: request.id,
    });
    await condition(() => reservationDecision?.requestId === request.id);
    if (!currentReservation()?.granted) {
      candidate.status = "reserved-elsewhere";
      addEvent(status, `${request.clientName} is considering another opening. Waiting without sending a competing offer.`);
      await publish();
      reservationDecision = undefined;
      while (!currentReservation()) {
        await condition(
          () =>
            currentReservation()?.requestId === request.id ||
            currentPhase() === "stopped" ||
            currentPhase() === "canceled",
        );
        if (currentPhase() === "canceled") return finish();
        while (currentPhase() === "stopped") {
          await condition(() => currentPhase() !== "stopped");
        }
      }
      if (!currentReservation()?.granted) {
        candidate.status = "reserved-elsewhere";
        addEvent(status, `${request.clientName} accepted another opening, so outreach moved on.`);
        await publish();
        continue;
      }
      candidate.status = "waiting";
      addEvent(status, `${request.clientName} became available for this opening.`);
      await publish();
    }

    if (currentPhase() === "stopped" || currentPhase() === "canceled") {
      await coordinator.signal(reservationReleased, { requestId: request.id, openingId: input.opening.id });
      if (currentPhase() === "canceled") return finish();
      while (currentPhase() === "stopped") await condition(() => currentPhase() !== "stopped");
      continue;
    }

    const token = uuid4();
    const deadline = new Date(Date.now() + input.opening.offerWindowMs).toISOString();
    const delivery = await sendNotification({
      kind: "offer",
      clientName: request.clientName,
      mobile: request.mobile,
      failDelivery: request.failNextDelivery,
      message: `${input.salonName} has an earlier ${input.opening.service} with ${input.opening.stylist} on ${input.opening.date} at ${input.opening.time}.`,
    });
    if (request.failNextDelivery) await coordinator.signal(deliveryFailureConsumed, request.id);

    if (!delivery.delivered) {
      candidate.status = "delivery-failed";
      candidate.respondedAt = isoNow();
      addEvent(status, `Message to ${request.clientName} could not be delivered. Check their mobile number.`, "attention");
      await coordinator.signal(reservationReleased, { requestId: request.id, openingId: input.opening.id });
      await publish();
      continue;
    }

    candidate.status = "offered";
    candidate.offeredAt = delivery.deliveredAt;
    candidate.deadline = deadline;
    candidate.offerToken = token;
    status.phase = "offering";
    status.currentOffer = { requestId: request.id, clientName: request.clientName, deadline, offerToken: token };
    offerResponse = undefined;
    staffAction = undefined;
    addEvent(status, `Offer sent to ${request.clientName}.`);
    await publish();

    const responded = await condition(
      () => currentResponse() !== undefined || staffAction !== undefined || currentPhase() !== "offering",
      input.opening.offerWindowMs,
    );

    if (!responded && currentPhase() === "offering") {
      candidate.status = "timed-out";
      candidate.respondedAt = isoNow();
      status.currentOffer = undefined;
      status.phase = "matching";
      addEvent(status, `${request.clientName}'s offer expired. Moving to the next client.`);
      await coordinator.signal(reservationReleased, { requestId: request.id, openingId: input.opening.id });
      await publish();
      continue;
    }

    if (currentResponse() === "decline") {
      await coordinator.signal(reservationReleased, { requestId: request.id, openingId: input.opening.id });
      continue;
    }

    if (currentResponse() === "accept") {
      await coordinator.signal(requestAccepted, { requestId: request.id, openingId: input.opening.id });
      await sendNotification({
        kind: "confirmation",
        clientName: request.clientName,
        mobile: request.mobile,
        message: `Reserved: ${input.opening.service} with ${input.opening.stylist} on ${input.opening.date} at ${input.opening.time}.`,
      });
      while (currentPhase() === "reserved" || currentPhase() === "stopped") {
        await condition(() => currentPhase() === "confirmed" || currentPhase() === "canceled" || currentPhase() === "matching");
      }
      if (currentPhase() === "confirmed" || currentPhase() === "canceled") return finish();
      continue;
    }

    await coordinator.signal(reservationReleased, { requestId: request.id, openingId: input.opening.id });
    if (currentPhase() === "canceled") {
      await sendNotification({
        kind: "revoked",
        clientName: request.clientName,
        mobile: request.mobile,
        message: "This opening is no longer available.",
      });
      return finish();
    }
  }

  if (status.phase === "matching") {
    status.phase = "unfilled";
    addEvent(status, "No more eligible clients. The opening remains unfilled.", "attention");
    await publish();
  }
  return finish();
}
