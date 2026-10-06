import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client, Connection } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import type {
  OfferView,
  OpeningStatus,
  SalonSeed,
  SalonSnapshot,
  StaffAction,
  WaitlistRequest,
} from "./types";
import {
  addWaitlistRequest,
  createOpening,
  getSalonState,
  performStaffAction,
  resetSalonDemo,
  respondToOffer,
  salonCoordinatorWorkflow,
  updateWaitlistRequest,
} from "./workflows";

const TASK_QUEUE = "juniper-salon";
const COORDINATOR_ID = "juniper-salon-demo";
const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

function dateInSalonTimezone(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function sampleHistory(today: string): OpeningStatus[] {
  const base = {
    durationMinutes: 60,
    offerWindowMs: 900_000,
    calendarTaskPending: false,
    currentOffer: undefined,
    sample: true,
  };
  return [
    {
      ...base,
      id: "sample-confirmed",
      workflowId: "sample-history-confirmed",
      service: "Haircut & Finish",
      stylist: "Lena",
      date: today,
      time: "11:00",
      createdAt: daysAgoIso(1),
      updatedAt: daysAgoIso(1),
      phase: "confirmed",
      reservedFor: "Samira B.",
      candidates: [{ requestId: "sample-client", clientName: "Samira B.", joinedAt: daysAgoIso(8), status: "accepted" }],
      events: [{ at: daysAgoIso(1), kind: "success", message: "Samira accepted and the calendar was updated." }],
    },
    {
      ...base,
      id: "sample-unfilled",
      workflowId: "sample-history-unfilled",
      service: "Gloss & Blowout",
      stylist: "Maya",
      date: today,
      time: "09:30",
      createdAt: daysAgoIso(2),
      updatedAt: daysAgoIso(2),
      phase: "unfilled",
      candidates: [{ requestId: "sample-client-2", clientName: "Taylor M.", joinedAt: daysAgoIso(7), status: "timed-out" }],
      events: [{ at: daysAgoIso(2), kind: "attention", message: "No clients accepted before outreach ended." }],
    },
  ];
}

function buildSeed(): SalonSeed {
  const today = dateInSalonTimezone();
  const waitlist: WaitlistRequest[] = [
    {
      id: randomUUID(),
      clientName: "Nia Brooks",
      mobile: "(555) 014-2201",
      service: "Haircut & Finish",
      currentAppointment: `${today} 4:30 PM`,
      stylistPreference: { kind: "preferred", stylist: "Lena", acceptsAlternatives: true },
      availability: [{ day: "weekday", part: "afternoon" }, { day: "saturday", part: "morning" }],
      joinedAt: daysAgoIso(6),
      active: true,
      failNextDelivery: false,
    },
    {
      id: randomUUID(),
      clientName: "Mateo Ruiz",
      mobile: "(555) 014-8732",
      service: "Haircut & Finish",
      currentAppointment: `${today} 5:00 PM`,
      stylistPreference: { kind: "none", acceptsAlternatives: true },
      availability: [{ day: "weekday", part: "afternoon" }],
      joinedAt: daysAgoIso(5),
      active: true,
      failNextDelivery: false,
    },
    {
      id: randomUUID(),
      clientName: "Alice Wong",
      mobile: "(555) 014-1168",
      service: "Root Refresh",
      currentAppointment: `${today} 3:30 PM`,
      stylistPreference: { kind: "required", stylist: "Maya", acceptsAlternatives: false },
      availability: [{ day: "weekday", part: "morning" }, { day: "weekday", part: "afternoon" }],
      joinedAt: daysAgoIso(4),
      active: true,
      failNextDelivery: true,
    },
    {
      id: randomUUID(),
      clientName: "Jordan Lee",
      mobile: "(555) 014-9930",
      service: "Gloss & Blowout",
      currentAppointment: `${today} 1:00 PM`,
      stylistPreference: { kind: "preferred", stylist: "Lena", acceptsAlternatives: true },
      availability: [{ day: "saturday", part: "morning" }, { day: "weekday", part: "afternoon" }],
      joinedAt: daysAgoIso(3),
      active: true,
      failNextDelivery: false,
    },
  ];
  return {
    waitlist,
    openingHistory: sampleHistory(today),
    config: {
      salonName: "Juniper Salon",
      phone: "(555) 014-0188",
      timezone: "America/Los_Angeles",
      demoMode: true,
      policyWindowMinutes: 15,
      demoWindowSeconds: Number(process.env.DEMO_WINDOW_SECONDS ?? 15),
      services: [
        { name: "Haircut & Finish", durationMinutes: 60 },
        { name: "Root Refresh", durationMinutes: 90 },
        { name: "Gloss & Blowout", durationMinutes: 75 },
      ],
      stylists: ["Lena", "Maya"],
    },
  };
}

let coordinatorPromise: ReturnType<Client["workflow"]["getHandle"]> | undefined;
async function getCoordinator() {
  if (coordinatorPromise) return coordinatorPromise;
  const client = await getClient();
  const handle = client.workflow.getHandle(COORDINATOR_ID);
  try {
    await handle.query(getSalonState);
  } catch {
    try {
      await client.workflow.start(salonCoordinatorWorkflow, {
        workflowId: COORDINATOR_ID,
        taskQueue: TASK_QUEUE,
        args: [COORDINATOR_ID, buildSeed()],
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already")) throw error;
    }
  }
  coordinatorPromise = handle;
  return handle;
}

async function readState(): Promise<SalonSnapshot> {
  return (await getCoordinator()).query(getSalonState);
}

function findOffer(state: SalonSnapshot, token: string) {
  for (const opening of state.openings) {
    const candidate = opening.candidates.find((item) => item.offerToken === token);
    if (candidate) return { opening, candidate };
  }
  return undefined;
}

function offerView(state: SalonSnapshot, token: string): OfferView | undefined {
  const found = findOffer(state, token);
  if (!found) return undefined;
  const { opening, candidate } = found;
  const states: Record<string, OfferView["state"]> = {
    offered: opening.currentOffer?.offerToken === token ? "available" : "unavailable",
    accepted: "accepted",
    declined: "declined",
    "timed-out": "expired",
  };
  const viewState = states[candidate.status] ?? "unavailable";
  const messages: Record<OfferView["state"], string> = {
    available: "An earlier appointment is waiting for you.",
    accepted: "Your earlier appointment is reserved.",
    declined: "Thanks for letting us know. You remain on the waitlist.",
    expired: "The response window has passed, but you remain on the waitlist.",
    unavailable: "This opening is no longer available.",
  };
  return {
    token,
    state: viewState,
    clientName: candidate.clientName,
    service: opening.service,
    stylist: opening.stylist,
    date: opening.date,
    time: opening.time,
    deadline: candidate.deadline,
    salonName: state.config.salonName,
    salonPhone: state.config.phone,
    message: messages[viewState],
  };
}

app.get("/api/state", async (_request, response) => {
  response.json(await readState());
});

app.post("/api/waitlist", async (request, response) => {
  const result = await (await getCoordinator()).executeUpdate(addWaitlistRequest, { args: [request.body] });
  response.status(201).json(result);
});

app.patch("/api/waitlist/:id", async (request, response) => {
  const result = await (await getCoordinator()).executeUpdate(updateWaitlistRequest, {
    args: [request.params.id, request.body],
  });
  response.json(result);
});

app.post("/api/openings", async (request, response) => {
  const state = await readState();
  const { service, stylist, date, time } = request.body;
  if (!service || !stylist || !date || !time) throw new Error("Service, stylist, date, and time are required.");
  if (date !== dateInSalonTimezone()) throw new Error("This prototype automates same-day openings only.");
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day === 0) throw new Error("The salon is closed on Sundays.");
  const configured = state.config.services.find((item) => item.name === service);
  if (!configured || !state.config.stylists.includes(stylist)) throw new Error("Unknown service or stylist.");
  const opening = await (await getCoordinator()).executeUpdate(createOpening, {
    args: [{
      id: randomUUID(),
      service,
      stylist,
      date,
      time,
      durationMinutes: configured.durationMinutes,
      offerWindowMs: state.config.demoMode
        ? state.config.demoWindowSeconds * 1_000
        : state.config.policyWindowMinutes * 60_000,
      createdAt: new Date().toISOString(),
    }],
  });
  response.status(201).json(opening);
});

app.post("/api/openings/:id/actions", async (request, response) => {
  const state = await readState();
  const opening = state.openings.find((item) => item.id === request.params.id);
  if (!opening || opening.sample) throw new Error("Opening not found.");
  const action = request.body.action as StaffAction;
  const result = await (await getClient()).workflow
    .getHandle(opening.workflowId)
    .executeUpdate(performStaffAction, { args: [action] });
  response.json(result);
});

app.get("/api/offers/:token", async (request, response) => {
  const view = offerView(await readState(), request.params.token);
  if (!view) return response.status(404).json({ error: "Offer not found." });
  response.json(view);
});

app.post("/api/offers/:token/respond", async (request, response) => {
  const state = await readState();
  const found = findOffer(state, request.params.token);
  if (!found || found.opening.sample) {
    return response.status(409).json({ outcome: "unavailable", message: "This opening is no longer available." });
  }
  try {
    const result = await (await getClient()).workflow
      .getHandle(found.opening.workflowId)
      .executeUpdate(respondToOffer, { args: [request.params.token, request.body.response] });
    response.json(result);
  } catch {
    response.status(409).json({ outcome: "unavailable", message: "This opening is no longer available." });
  }
});

app.post("/api/demo/reset", async (_request, response) => {
  const result = await (await getCoordinator()).executeUpdate(resetSalonDemo, { args: [buildSeed()] });
  response.json(result);
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(400).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Juniper Salon is available at http://localhost:${port}`));
