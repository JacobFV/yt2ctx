import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { requireUser } from "../../../../server/auth";
import {
  createCreditCheckoutSession,
  createRecurringCheckoutSession,
  createSetupCheckoutSession
} from "../../../../server/stripe";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["credits", "recurring", "setup"]),
  packId: z.enum(["starter", "studio"]).optional()
});

export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const body = schema.parse(await request.json());
    const session =
      body.action === "credits"
        ? await createCreditCheckoutSession({
            user,
            packId: body.packId ?? "starter",
            request
          })
        : body.action === "recurring"
          ? await createRecurringCheckoutSession({ user, request })
          : await createSetupCheckoutSession({ user, request });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create checkout session." },
      { status: 400 }
    );
  }
}
