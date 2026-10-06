export type NotificationInput = {
  kind: "offer" | "confirmation" | "revoked";
  clientName: string;
  mobile: string;
  message: string;
  failDelivery?: boolean;
};

export type NotificationResult = { delivered: boolean; deliveredAt: string };

/** Simulated SMS gateway for the prototype. */
export async function sendNotification(input: NotificationInput): Promise<NotificationResult> {
  const delivered = !input.failDelivery;
  console.log(`[message:${input.kind}] ${delivered ? "delivered" : "failed"} for ${input.clientName}`);
  return { delivered, deliveredAt: new Date().toISOString() };
}
