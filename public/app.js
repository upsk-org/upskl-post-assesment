const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);

let salonState;
let pollTimer;
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || "Something went wrong.");
  return body;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3200);
}

function formatDate(date, options = { month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat("en-US", options).format(new Date(`${date}T12:00:00`));
}

function formatTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
    .format(new Date(2020, 0, 1, hour, minute));
}

function relativeTime(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function countdown(deadline) {
  const seconds = Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1000));
  return `0:${String(seconds).padStart(2, "0")}`;
}

const phaseLabels = {
  matching: "Finding a match",
  offering: "Offer active",
  reserved: "Reserved",
  confirmed: "Confirmed",
  stopped: "Outreach stopped",
  canceled: "Canceled",
  unfilled: "Unfilled",
};

const candidateLabels = {
  waiting: "waiting",
  "reserved-elsewhere": "another offer",
  offered: "offer sent",
  declined: "declined",
  "timed-out": "timed out",
  "delivery-failed": "delivery failed",
  accepted: "accepted",
  "acceptance-canceled": "canceled",
  revoked: "offer closed",
};

function openingCard(opening) {
  const day = formatDate(opening.date, { day: "numeric" });
  const month = formatDate(opening.date, { month: "short" });
  let progress = "Checking the waitlist…";
  if (opening.currentOffer) {
    progress = `<span><strong>${escapeHtml(opening.currentOffer.clientName)} has the offer</strong><small> Waiting for a response</small></span><span class="countdown" data-deadline="${opening.currentOffer.deadline}">${countdown(opening.currentOffer.deadline)}</span>`;
  } else if (opening.phase === "reserved") {
    progress = `<span><strong>Reserved for ${escapeHtml(opening.reservedFor)}</strong><small> Calendar update needed</small></span>`;
  } else {
    progress = `<span><strong>${escapeHtml(opening.events.at(-1)?.message || phaseLabels[opening.phase])}</strong></span>`;
  }

  const candidateTrail = opening.candidates.length
    ? opening.candidates.map((candidate) => `<span class="candidate-chip" data-status="${candidate.status}">${escapeHtml(candidate.clientName)} · ${candidateLabels[candidate.status]}</span>`).join("")
    : '<span class="candidate-chip">No matching clients</span>';

  const actions = [];
  if (opening.currentOffer) {
    actions.push(`<a href="/?offer=${opening.currentOffer.offerToken}" target="_blank">Open client view ↗</a>`);
  }
  if (opening.phase === "reserved") {
    actions.push('<button class="calendar-action" data-opening-action="confirm-calendar">Mark Square updated</button>');
    actions.push('<button data-opening-action="cancel-acceptance">Client can’t make it</button>');
  }
  if (opening.phase === "stopped") actions.push('<button data-opening-action="reopen">Reopen outreach</button>');
  if (["matching", "offering"].includes(opening.phase)) actions.push('<button data-opening-action="stop">Stop outreach</button>');
  if (!["confirmed", "canceled"].includes(opening.phase)) {
    actions.push('<button class="cancel-action" data-opening-action="cancel">Cancel opening</button>');
  }

  return `<article class="opening-card" data-opening-id="${opening.id}">
    <div class="opening-card-top">
      <div class="appointment-name"><span class="date-tile"><strong>${day}</strong><small>${month}</small></span><div><h3>${escapeHtml(opening.service)}</h3><p>${formatTime(opening.time)} · ${escapeHtml(opening.stylist)} · ${opening.durationMinutes} min</p></div></div>
      <span class="status-pill status-${opening.phase}">${phaseLabels[opening.phase]}</span>
    </div>
    <div class="opening-progress">${progress}</div>
    <div class="candidate-trail">${candidateTrail}</div>
    <div class="opening-actions">${actions.join("")}</div>
  </article>`;
}

function renderOpenings() {
  const active = salonState.openings.filter((opening) =>
    !opening.sample && ["matching", "offering", "reserved", "stopped"].includes(opening.phase));
  $("#active-count").textContent = `${active.length} active`;
  $("#active-openings").innerHTML = active.length
    ? active.map(openingCard).join("")
    : `<div class="empty-state"><strong>No openings need attention.</strong><br><small>When a cancellation comes in, add it here and Juniper will take it from there.</small></div>`;
}

function renderAlerts() {
  const pending = salonState.openings
    .filter((opening) => opening.calendarTaskPending)
    .map((opening) => ({
      id: `calendar-${opening.id}`,
      message: `Update Square for ${opening.reservedFor} at ${formatTime(opening.time)}.`,
      createdAt: opening.updatedAt,
    }));
  const alerts = [...pending, ...salonState.alerts].slice(0, 5);
  $("#alerts").innerHTML = alerts.length
    ? alerts.map((alert) => `<article class="alert-item"><p>${escapeHtml(alert.message)}</p><small>${relativeTime(alert.createdAt)}</small></article>`).join("")
    : '<div class="all-calm"><span class="calm-icon">✓</span><p>Everything is moving.</p><small>We’ll surface anything that needs you.</small></div>';
}

function renderHistory() {
  $("#history").innerHTML = salonState.openings.slice(0, 8).map((opening) => `
    <tr><td><strong>${escapeHtml(opening.service)}</strong><small>${formatDate(opening.date)} · ${formatTime(opening.time)}</small></td><td>${escapeHtml(opening.stylist)}</td><td><span class="status-pill status-${opening.phase}">${phaseLabels[opening.phase]}</span></td><td>${escapeHtml(opening.reservedFor || "—")}</td><td>${relativeTime(opening.updatedAt)}</td></tr>`).join("");
}

function availabilityLabel(slots) {
  return slots.map((slot) => `${slot.day === "weekday" ? "Weekday" : "Saturday"} ${slot.part}`).join(", ");
}

function initials(name) {
  return name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

function renderWaitlist() {
  $("#waitlist").innerHTML = salonState.waitlist.map((request) => {
    const preference = request.stylistPreference.kind === "none"
      ? "Any stylist"
      : `${request.stylistPreference.kind === "required" ? "Only" : "Prefers"} ${request.stylistPreference.stylist}`;
    return `<article class="waitlist-row">
      <div class="person"><span class="person-avatar">${initials(request.clientName)}</span><span><strong>${escapeHtml(request.clientName)}</strong><small>${escapeHtml(request.mobile)}</small></span></div>
      <span><strong>${escapeHtml(request.service)}</strong><small>${escapeHtml(preference)}</small></span>
      <span><strong>${escapeHtml(availabilityLabel(request.availability))}</strong><small>Current: ${escapeHtml(request.currentAppointment)}</small></span>
      <span class="waitlist-status ${request.active ? "" : "inactive"}">${request.active ? "Waiting" : "Matched"}</span>
      <button class="fail-toggle ${request.failNextDelivery ? "active" : ""}" data-fail-request="${request.id}">${request.failNextDelivery ? "Next message will fail" : "Simulate failure"}</button>
    </article>`;
  }).join("");
}

function renderStaff() {
  $("#metric-openings").textContent = salonState.metrics.openingsThisWeek;
  $("#metric-refilled").textContent = salonState.metrics.refilledThisWeek;
  $("#metric-rate").textContent = `${salonState.metrics.refillRate}%`;
  $(".demo-badge").innerHTML = `<i></i> Demo time · ${salonState.config.demoWindowSeconds} sec`;
  renderOpenings();
  renderAlerts();
  renderHistory();
  renderWaitlist();
}

async function refreshStaff() {
  try {
    salonState = await api("/api/state");
    renderStaff();
  } catch (error) {
    toast(error.message, true);
  }
}

function populateForms() {
  const serviceOptions = salonState.config.services.map((service) => `<option>${escapeHtml(service.name)}</option>`).join("");
  const stylistOptions = salonState.config.stylists.map((stylist) => `<option>${escapeHtml(stylist)}</option>`).join("");
  $("#opening-service").innerHTML = serviceOptions;
  $("#request-service").innerHTML = serviceOptions;
  $("#opening-stylist").innerHTML = stylistOptions;
  $("#request-stylist").innerHTML = stylistOptions;
  $("#opening-date").value = new Date().toLocaleDateString("en-CA");
  const slots = [
    ["weekday", "morning"], ["weekday", "afternoon"], ["weekday", "evening"],
    ["saturday", "morning"], ["saturday", "afternoon"], ["saturday", "evening"],
  ];
  $("#availability-options").innerHTML = slots.map(([day, part], index) =>
    `<label><input type="checkbox" name="availability" value="${day}:${part}" ${index === 1 ? "checked" : ""}/> ${day === "weekday" ? "Weekday" : "Saturday"} ${part}</label>`).join("");
}

async function setupStaff() {
  $("#today-label").textContent = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  await refreshStaff();
  populateForms();
  pollTimer = setInterval(refreshStaff, 1000);

  $("#new-opening").addEventListener("click", () => $("#opening-dialog").showModal());
  $("#new-request").addEventListener("click", () => $("#request-dialog").showModal());

  $("#opening-form").addEventListener("submit", async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const form = new FormData(event.currentTarget);
      await api("/api/openings", {
        method: "POST",
        body: JSON.stringify({ service: form.get("service"), stylist: form.get("stylist"), date: form.get("date"), time: form.get("time") }),
      });
      $("#opening-dialog").close();
      toast("Outreach started. We’ll keep it moving.");
      await refreshStaff();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $("#request-form").addEventListener("submit", async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const form = new FormData(event.currentTarget);
      const kind = form.get("preferenceKind");
      const availability = form.getAll("availability").map((value) => {
        const [day, part] = value.split(":");
        return { day, part };
      });
      if (!availability.length) throw new Error("Choose at least one availability period.");
      const result = await api("/api/waitlist", {
        method: "POST",
        body: JSON.stringify({
          clientName: form.get("clientName"), mobile: form.get("mobile"), service: form.get("service"),
          currentAppointment: form.get("currentAppointment"), availability, failNextDelivery: false,
          stylistPreference: {
            kind,
            stylist: kind === "none" ? undefined : form.get("preferenceStylist"),
            acceptsAlternatives: kind === "required" ? false : form.get("acceptsAlternatives") === "on",
          },
        }),
      });
      $("#request-dialog").close();
      event.currentTarget.reset();
      toast(result.similarRequestIds.length ? "Client added. We also found a similar request to review." : "Client added to the waitlist.");
      await refreshStaff();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-opening-action]");
    if (actionButton) {
      const openingId = actionButton.closest("[data-opening-id]").dataset.openingId;
      actionButton.disabled = true;
      try {
        const result = await api(`/api/openings/${openingId}/actions`, {
          method: "POST", body: JSON.stringify({ action: actionButton.dataset.openingAction }),
        });
        toast(result.message);
        await refreshStaff();
      } catch (error) { toast(error.message, true); }
      return;
    }
    const failButton = event.target.closest("[data-fail-request]");
    if (failButton) {
      const request = salonState.waitlist.find((item) => item.id === failButton.dataset.failRequest);
      try {
        await api(`/api/waitlist/${request.id}`, {
          method: "PATCH", body: JSON.stringify({ failNextDelivery: !request.failNextDelivery }),
        });
        toast(!request.failNextDelivery ? "The next message to this client will fail." : "Delivery restored.");
        await refreshStaff();
      } catch (error) { toast(error.message, true); }
    }
  });

  $("#reset-demo").addEventListener("click", async () => {
    if (!confirm("Reset the waitlist and dashboard to the sample data? Temporal histories remain available.")) return;
    try {
      salonState = await api("/api/demo/reset", { method: "POST" });
      renderStaff();
      populateForms();
      toast("The sample salon is ready for a fresh walkthrough.");
    } catch (error) { toast(error.message, true); }
  });
}

function renderOffer(offer) {
  $("#offer-greeting").textContent = `Hi, ${offer.clientName.split(" ")[0]}.`;
  $("#offer-message").textContent = offer.message;
  const date = new Date(`${offer.date}T12:00:00`);
  $("#offer-day").textContent = date.getDate();
  $("#offer-month").textContent = new Intl.DateTimeFormat("en-US", { month: "short" }).format(date);
  $("#offer-time").textContent = formatTime(offer.time);
  $("#offer-service").textContent = offer.service;
  $("#offer-stylist").textContent = `with ${offer.stylist}`;
  $("#salon-phone").textContent = offer.salonPhone;
  $("#salon-phone").href = `tel:${offer.salonPhone.replace(/\D/g, "")}`;
  const available = offer.state === "available";
  $("#offer-actions").hidden = !available;
  $("#offer-card").classList.toggle("final", !available);
  $("#offer-countdown").textContent = available && offer.deadline
    ? `${countdown(offer.deadline)} to respond · reserved for you while this timer runs`
    : offer.state === "accepted" ? "Reserved — Juniper will update the salon calendar." : "You’re still welcome to call if you have questions.";
}

async function setupClient(token) {
  $("#staff-app").hidden = true;
  $("#client-app").hidden = false;
  async function refreshOffer() {
    try {
      const offer = await api(`/api/offers/${token}`);
      renderOffer(offer);
    } catch (error) {
      $("#offer-greeting").textContent = "This invitation has closed.";
      $("#offer-message").textContent = error.message;
      $("#offer-actions").hidden = true;
    }
  }
  await refreshOffer();
  pollTimer = setInterval(refreshOffer, 1000);
  $("#offer-actions").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-response]");
    if (!button) return;
    $$("#offer-actions button").forEach((item) => { item.disabled = true; });
    try {
      const result = await api(`/api/offers/${token}/respond`, {
        method: "POST", body: JSON.stringify({ response: button.dataset.response }),
      });
      toast(result.message, result.outcome === "unavailable");
      await refreshOffer();
    } catch (error) {
      toast(error.message, true);
      await refreshOffer();
    }
  });
}

const offerToken = new URLSearchParams(location.search).get("offer");
if (offerToken) {
  setupClient(offerToken).catch((error) => toast(error.message, true));
} else {
  setupStaff().catch((error) => toast(error.message, true));
}
