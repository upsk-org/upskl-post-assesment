export type DayKind = "weekday" | "saturday";
export type DayPart = "morning" | "afternoon" | "evening";

export type AvailabilitySlot = { day: DayKind; part: DayPart };

export type StylistPreference = {
  kind: "none" | "preferred" | "required";
  stylist?: string;
  acceptsAlternatives: boolean;
};

export type WaitlistRequest = {
  id: string;
  clientName: string;
  mobile: string;
  service: string;
  currentAppointment: string;
  stylistPreference: StylistPreference;
  availability: AvailabilitySlot[];
  joinedAt: string;
  active: boolean;
  failNextDelivery: boolean;
};

export type WaitlistRequestInput = Omit<WaitlistRequest, "id" | "joinedAt" | "active"> & {
  id?: string;
  joinedAt?: string;
  active?: boolean;
};

export type OpeningInput = {
  id: string;
  service: string;
  stylist: string;
  date: string;
  time: string;
  durationMinutes: number;
  offerWindowMs: number;
  createdAt: string;
};

export type CandidateStatus =
  | "waiting"
  | "reserved-elsewhere"
  | "offered"
  | "declined"
  | "timed-out"
  | "delivery-failed"
  | "accepted"
  | "acceptance-canceled"
  | "revoked";

export type CandidateProgress = {
  requestId: string;
  clientName: string;
  joinedAt: string;
  status: CandidateStatus;
  offeredAt?: string;
  deadline?: string;
  respondedAt?: string;
  offerToken?: string;
};

export type OpeningPhase =
  | "matching"
  | "offering"
  | "reserved"
  | "confirmed"
  | "stopped"
  | "canceled"
  | "unfilled";

export type OpeningEvent = {
  at: string;
  kind: "info" | "success" | "attention";
  message: string;
};

export type CurrentOffer = {
  requestId: string;
  clientName: string;
  deadline: string;
  offerToken: string;
};

export type OpeningStatus = OpeningInput & {
  workflowId: string;
  phase: OpeningPhase;
  candidates: CandidateProgress[];
  currentOffer?: CurrentOffer;
  reservedFor?: string;
  calendarTaskPending: boolean;
  events: OpeningEvent[];
  updatedAt: string;
  sample?: boolean;
};

export type StaffAlert = {
  id: string;
  openingId: string;
  createdAt: string;
  message: string;
};

export type SalonConfig = {
  salonName: string;
  phone: string;
  timezone: string;
  demoMode: boolean;
  policyWindowMinutes: number;
  demoWindowSeconds: number;
  services: Array<{ name: string; durationMinutes: number }>;
  stylists: string[];
};

export type SalonSeed = {
  waitlist: WaitlistRequest[];
  openingHistory: OpeningStatus[];
  config: SalonConfig;
};

export type SalonSnapshot = {
  waitlist: WaitlistRequest[];
  openings: OpeningStatus[];
  alerts: StaffAlert[];
  reservations: Record<string, string>;
  metrics: {
    openingsThisWeek: number;
    refilledThisWeek: number;
    refillRate: number;
    activeOpenings: number;
  };
  config: SalonConfig;
  updatedAt: string;
};

export type WaitlistMutationResult = {
  request: WaitlistRequest;
  similarRequestIds: string[];
};

export type OfferResponseResult = {
  outcome: "accepted" | "declined" | "unavailable";
  message: string;
};

export type StaffAction = "stop" | "reopen" | "cancel" | "cancel-acceptance" | "confirm-calendar";

export type StaffActionResult = {
  accepted: boolean;
  message: string;
  phase: OpeningPhase;
};

export type OfferView = {
  token: string;
  state: "available" | "accepted" | "declined" | "expired" | "unavailable";
  clientName: string;
  service: string;
  stylist: string;
  date: string;
  time: string;
  deadline?: string;
  salonName: string;
  salonPhone: string;
  message: string;
};

export type ReservationRequest = {
  openingWorkflowId: string;
  openingId: string;
  requestId: string;
};

export type ReservationDecision = {
  requestId: string;
  granted: boolean;
  final?: boolean;
};

export type OpeningWorkflowInput = {
  opening: OpeningInput;
  workflowId: string;
  coordinatorWorkflowId: string;
  candidates: WaitlistRequest[];
  salonName: string;
  salonPhone: string;
};

