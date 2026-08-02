// stridelux-payments-fn — checkout session, Stripe webhook, coupon validation
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const sesClient = new SESv2Client({});
const SES_FROM  = process.env.SES_FROM_ADDRESS;
const SITE_URL  = process.env.FRONTEND_URL;
const PRODUCTS = "stridelux-products";
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const Stripe = require("stripe");

const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
const client   = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ORDERS   = "stridelux-orders";
const COUPONS  = "stridelux-coupons";
const FRONTEND = process.env.FRONTEND_URL;

// ── Professional order-confirmation email helpers ─────────────────────────────

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD"
  }).format(Number(value || 0));
}

function formatOrderDate(value) {
  const date = value ? new Date(value) : new Date();

  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Toronto"
  }).format(date);
}

function buildConfirmationEmail(order) {
  const shortId = String(order.orderId || "").slice(0, 8);
  const customerName =
    order.shippingInfo?.fullName ||
    order.customerName ||
    "Customer";

  const orderUrl =
    `${SITE_URL}/account/orders/${encodeURIComponent(order.orderId)}`;

  const subtotal = Number(order.subtotal || 0);
  const shipping = Number(order.shippingCost || 0);
  const tax = Number(order.tax || 0);
  const discount = Number(order.discountAmount || 0);
  const total = Number(order.total || 0);

  const items = Array.isArray(order.items) ? order.items : [];

  const itemRows = items
    .map((item) => {
      const name = escapeHtml(item.name || "Product");
      const quantity = Number(item.quantity || 1);
      const unitPrice = Number(item.price || 0);
      const lineTotal = unitPrice * quantity;

      const sizeText = item.selectedSize || item.size
        ? `Size: ${escapeHtml(item.selectedSize || item.size)}`
        : "";

      const imageUrl = item.image
        ? escapeHtml(
            item.image.startsWith("http")
              ? item.image
              : `${SITE_URL}${item.image}`
          )
        : "";

      return `
        <tr>
          <td
            style="
              padding:18px 8px;
              border-bottom:1px solid #ececec;
              vertical-align:middle;
            "
          >
            <table
              role="presentation"
              width="100%"
              cellspacing="0"
              cellpadding="0"
            >
              <tr>
                ${
                  imageUrl
                    ? `
                      <td
                        width="82"
                        style="
                          width:82px;
                          padding-right:14px;
                          vertical-align:middle;
                        "
                      >
                        <img
                          src="${imageUrl}"
                          alt="${name}"
                          width="72"
                          height="72"
                          style="
                            width:72px;
                            height:72px;
                            object-fit:contain;
                            display:block;
                            background:#f5f5f5;
                            border-radius:10px;
                          "
                        />
                      </td>
                    `
                    : ""
                }

                <td style="vertical-align:middle;">
                  <div
                    style="
                      color:#111111;
                      font-size:15px;
                      font-weight:700;
                      line-height:1.4;
                    "
                  >
                    ${name}
                  </div>

                  ${
                    sizeText
                      ? `
                        <div
                          style="
                            margin-top:5px;
                            color:#777777;
                            font-size:13px;
                          "
                        >
                          ${sizeText}
                        </div>
                      `
                      : ""
                  }
                </td>
              </tr>
            </table>
          </td>

          <td
            style="
              padding:18px 8px;
              border-bottom:1px solid #ececec;
              text-align:center;
              color:#444444;
              font-size:14px;
              vertical-align:middle;
            "
          >
            ${quantity}
          </td>

          <td
            style="
              padding:18px 8px;
              border-bottom:1px solid #ececec;
              text-align:right;
              color:#111111;
              font-size:14px;
              font-weight:700;
              vertical-align:middle;
              white-space:nowrap;
            "
          >
            ${formatMoney(lineTotal)}
          </td>
        </tr>
      `;
    })
    .join("");

  const textItems = items
    .map((item) => {
      const quantity = Number(item.quantity || 1);
      const price = Number(item.price || 0);
      const size = item.selectedSize || item.size;

      return `${quantity} × ${item.name || "Product"}${
        size ? ` — Size ${size}` : ""
      } — ${formatMoney(quantity * price)}`;
    })
    .join("\n");

  const subject = `Your STRIDELUX order #${shortId} is confirmed`;

  const text = `
Hello ${customerName},

Thank you for shopping with STRIDELUX.

Your payment was successful and your order is now being processed.

Order ID: #${shortId}
Order date: ${formatOrderDate(order.createdAt)}

${textItems}

Subtotal: ${formatMoney(subtotal)}
Shipping: ${formatMoney(shipping)}
Tax: ${formatMoney(tax)}
Discount: -${formatMoney(discount)}
Total: ${formatMoney(total)}

You can review your order here:
${orderUrl}

We will email you again when your order ships.

Thank you,
STRIDELUX Customer Care
${SITE_URL}
  `.trim();

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        />

        <title>${escapeHtml(subject)}</title>
      </head>

      <body
        style="
          margin:0;
          padding:0;
          background:#f2f2f2;
          font-family:Arial,Helvetica,sans-serif;
          color:#111111;
        "
      >
        <div
          style="
            display:none;
            max-height:0;
            overflow:hidden;
            opacity:0;
          "
        >
          Your STRIDELUX order has been confirmed and is being processed.
        </div>

        <table
          role="presentation"
          width="100%"
          cellspacing="0"
          cellpadding="0"
          style="width:100%;background:#f2f2f2;"
        >
          <tr>
            <td align="center" style="padding:35px 15px;">
              <table
                role="presentation"
                width="100%"
                cellspacing="0"
                cellpadding="0"
                style="
                  width:100%;
                  max-width:680px;
                  background:#ffffff;
                  border-radius:18px;
                  overflow:hidden;
                  box-shadow:0 16px 45px rgba(0,0,0,0.08);
                "
              >
                <!-- Header -->
                <tr>
                  <td
                    style="
                      background:#050505;
                      padding:28px 34px;
                    "
                  >
                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                    >
                      <tr>
                        <td
                          style="
                            color:#ffffff;
                            font-size:27px;
                            font-weight:900;
                            letter-spacing:3px;
                          "
                        >
                          STRIDELUX
                        </td>

                        <td
                          align="right"
                          style="
                            color:#c9a227;
                            font-size:13px;
                            font-weight:700;
                          "
                        >
                          ORDER CONFIRMATION
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Confirmation -->
                <tr>
                  <td style="padding:42px 34px 25px;">
                    <div
                      style="
                        width:58px;
                        height:58px;
                        line-height:58px;
                        text-align:center;
                        background:#c9a227;
                        color:#111111;
                        border-radius:50%;
                        font-size:29px;
                        font-weight:700;
                        margin-bottom:24px;
                      "
                    >
                      ✓
                    </div>

                    <h1
                      style="
                        margin:0 0 13px;
                        color:#111111;
                        font-size:30px;
                        line-height:1.25;
                      "
                    >
                      Thank you for your order,
                      <span style="color:#c9a227;">
                        ${escapeHtml(customerName)}
                      </span>
                    </h1>

                    <p
                      style="
                        margin:0;
                        color:#5e5e5e;
                        font-size:16px;
                        line-height:1.7;
                      "
                    >
                      Your payment was successful. We have received your
                      order and it is now being processed.
                    </p>
                  </td>
                </tr>

                <!-- Order information -->
                <tr>
                  <td style="padding:0 34px 25px;">
                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                      style="
                        background:#f7f7f7;
                        border-radius:12px;
                      "
                    >
                      <tr>
                        <td
                          style="
                            width:50%;
                            padding:19px;
                            border-right:1px solid #e5e5e5;
                          "
                        >
                          <div
                            style="
                              color:#888888;
                              font-size:12px;
                              font-weight:700;
                              text-transform:uppercase;
                              letter-spacing:1px;
                            "
                          >
                            Order number
                          </div>

                          <div
                            style="
                              margin-top:7px;
                              color:#111111;
                              font-size:16px;
                              font-weight:700;
                            "
                          >
                            #${escapeHtml(shortId)}
                          </div>
                        </td>

                        <td style="width:50%;padding:19px;">
                          <div
                            style="
                              color:#888888;
                              font-size:12px;
                              font-weight:700;
                              text-transform:uppercase;
                              letter-spacing:1px;
                            "
                          >
                            Order date
                          </div>

                          <div
                            style="
                              margin-top:7px;
                              color:#111111;
                              font-size:15px;
                              font-weight:700;
                            "
                          >
                            ${escapeHtml(formatOrderDate(order.createdAt))}
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Order summary -->
                <tr>
                  <td style="padding:0 34px 30px;">
                    <h2
                      style="
                        margin:0 0 18px;
                        color:#111111;
                        font-size:19px;
                      "
                    >
                      Order summary
                    </h2>

                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                      style="
                        width:100%;
                        border-collapse:collapse;
                      "
                    >
                      <thead>
                        <tr>
                          <th
                            align="left"
                            style="
                              padding:12px 8px;
                              border-bottom:2px solid #c9a227;
                              color:#555555;
                              font-size:12px;
                              text-transform:uppercase;
                              letter-spacing:0.8px;
                            "
                          >
                            Item
                          </th>

                          <th
                            align="center"
                            style="
                              padding:12px 8px;
                              border-bottom:2px solid #c9a227;
                              color:#555555;
                              font-size:12px;
                              text-transform:uppercase;
                              letter-spacing:0.8px;
                            "
                          >
                            Qty
                          </th>

                          <th
                            align="right"
                            style="
                              padding:12px 8px;
                              border-bottom:2px solid #c9a227;
                              color:#555555;
                              font-size:12px;
                              text-transform:uppercase;
                              letter-spacing:0.8px;
                            "
                          >
                            Price
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        ${
                          itemRows ||
                          `
                            <tr>
                              <td
                                colspan="3"
                                style="
                                  padding:22px 8px;
                                  color:#777777;
                                  text-align:center;
                                "
                              >
                                Order items unavailable
                              </td>
                            </tr>
                          `
                        }
                      </tbody>
                    </table>

                    <!-- Totals -->
                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                      style="margin-top:18px;"
                    >
                      <tr>
                        <td
                          align="right"
                          style="
                            padding:6px 8px;
                            color:#666666;
                            font-size:14px;
                          "
                        >
                          Subtotal
                        </td>

                        <td
                          align="right"
                          width="130"
                          style="
                            padding:6px 8px;
                            color:#111111;
                            font-size:14px;
                          "
                        >
                          ${formatMoney(subtotal)}
                        </td>
                      </tr>

                      <tr>
                        <td
                          align="right"
                          style="
                            padding:6px 8px;
                            color:#666666;
                            font-size:14px;
                          "
                        >
                          Shipping
                        </td>

                        <td
                          align="right"
                          style="
                            padding:6px 8px;
                            color:#111111;
                            font-size:14px;
                          "
                        >
                          ${formatMoney(shipping)}
                        </td>
                      </tr>

                      <tr>
                        <td
                          align="right"
                          style="
                            padding:6px 8px;
                            color:#666666;
                            font-size:14px;
                          "
                        >
                          Tax
                        </td>

                        <td
                          align="right"
                          style="
                            padding:6px 8px;
                            color:#111111;
                            font-size:14px;
                          "
                        >
                          ${formatMoney(tax)}
                        </td>
                      </tr>

                      ${
                        discount > 0
                          ? `
                            <tr>
                              <td
                                align="right"
                                style="
                                  padding:6px 8px;
                                  color:#16823a;
                                  font-size:14px;
                                "
                              >
                                Discount
                              </td>

                              <td
                                align="right"
                                style="
                                  padding:6px 8px;
                                  color:#16823a;
                                  font-size:14px;
                                "
                              >
                                −${formatMoney(discount)}
                              </td>
                            </tr>
                          `
                          : ""
                      }

                      <tr>
                        <td
                          align="right"
                          style="
                            padding:16px 8px 8px;
                            border-top:1px solid #dddddd;
                            color:#111111;
                            font-size:17px;
                            font-weight:900;
                          "
                        >
                          Total
                        </td>

                        <td
                          align="right"
                          style="
                            padding:16px 8px 8px;
                            border-top:1px solid #dddddd;
                            color:#c9a227;
                            font-size:20px;
                            font-weight:900;
                          "
                        >
                          ${formatMoney(total)}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA -->
                <tr>
                  <td style="padding:0 34px 35px;">
                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                    >
                      <tr>
                        <td
                          align="center"
                          style="
                            background:#c9a227;
                            border-radius:8px;
                          "
                        >
                          <a
                            href="${escapeHtml(orderUrl)}"
                            style="
                              display:block;
                              padding:16px 24px;
                              color:#111111;
                              text-decoration:none;
                              font-size:14px;
                              font-weight:800;
                              text-transform:uppercase;
                              letter-spacing:0.7px;
                            "
                          >
                            View your order
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Benefits -->
                <tr>
                  <td
                    style="
                      padding:25px 34px;
                      background:#fdf9ed;
                      border-top:1px solid #e8d48a;
                    "
                  >
                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                    >
                      <tr>
                        <td width="33.33%" style="padding:8px;">
                          <div
                            style="
                              color:#111111;
                              font-size:13px;
                              font-weight:800;
                            "
                          >
                            Fast shipping
                          </div>

                          <div
                            style="
                              margin-top:5px;
                              color:#777777;
                              font-size:12px;
                              line-height:1.5;
                            "
                          >
                            Reliable delivery and tracking.
                          </div>
                        </td>

                        <td width="33.33%" style="padding:8px;">
                          <div
                            style="
                              color:#111111;
                              font-size:13px;
                              font-weight:800;
                            "
                          >
                            Secure payment
                          </div>

                          <div
                            style="
                              margin-top:5px;
                              color:#777777;
                              font-size:12px;
                              line-height:1.5;
                            "
                          >
                            Your payment information is protected.
                          </div>
                        </td>

                        <td width="33.33%" style="padding:8px;">
                          <div
                            style="
                              color:#111111;
                              font-size:13px;
                              font-weight:800;
                            "
                          >
                            Customer care
                          </div>

                          <div
                            style="
                              margin-top:5px;
                              color:#777777;
                              font-size:12px;
                              line-height:1.5;
                            "
                          >
                            We are here when you need assistance.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td
                    align="center"
                    style="
                      background:#050505;
                      padding:27px 25px;
                    "
                  >
                    <div
                      style="
                        color:#ffffff;
                        font-size:19px;
                        font-weight:900;
                        letter-spacing:2px;
                      "
                    >
                      STRIDELUX
                    </div>

                    <p
                      style="
                        margin:12px 0 0;
                        color:#a7a7a7;
                        font-size:12px;
                        line-height:1.6;
                      "
                    >
                      © ${new Date().getFullYear()} STRIDELUX.
                      All rights reserved.
                    </p>

                    <p
                      style="
                        margin:8px 0 0;
                        color:#8e8e8e;
                        font-size:11px;
                        line-height:1.6;
                      "
                    >
                      This email was sent because an order was placed using
                      this email address.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  return { subject, text, html };
}

async function sendOrderConfirmationEmail(order) {
  const recipientEmail =
    order.customerEmail ||
    order.guestEmail ||
    order.shippingInfo?.email;

  if (!recipientEmail) {
    console.warn(
      `Order ${order.orderId} has no customer email. Confirmation skipped.`
    );
    return;
  }

  if (!SES_FROM) {
    throw new Error("SES_FROM_ADDRESS environment variable is missing");
  }

  if (!SITE_URL) {
    throw new Error("FRONTEND_URL environment variable is missing");
  }

  const { subject, text, html } = buildConfirmationEmail(order);

  const result = await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: SES_FROM,

      Destination: {
        ToAddresses: [recipientEmail]
      },

      ReplyToAddresses: [
        process.env.SES_REPLY_TO || SES_FROM
      ],

      Content: {
        Simple: {
          Subject: {
            Data: subject,
            Charset: "UTF-8"
          },

          Body: {
            Html: {
              Data: html,
              Charset: "UTF-8"
            },

            Text: {
              Data: text,
              Charset: "UTF-8"
            }
          }
        }
      }
    })
  );

  console.log("Confirmation email sent", {
    orderId: order.orderId,
    recipientEmail,
    messageId: result.MessageId
  });
}

// ── JWT decode ────────────────────────────────────────────────────────────────

// Decode JWT payload without verifying signature
// Used when no Cognito authorizer is attached to the route
// (checkout-session is public for guest support)
function decodeJwtClaims(authHeader) {
  try {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return {};
    const token   = authHeader.split(" ")[1];
    const payload = token.split(".")[1];
    const decoded = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path   = event.rawPath || event.path || "";
  const body   = event.body ? JSON.parse(event.body) : {};

  // Resolve claims — authorizer claims if present, otherwise decode manually
  const authorizerClaims = event.requestContext?.authorizer?.jwt?.claims || {};
  const authHeader       = event.headers?.authorization ||
                           event.headers?.Authorization || "";
  const claims           = Object.keys(authorizerClaims).length > 0
    ? authorizerClaims
    : decodeJwtClaims(authHeader);

  const userId        = claims.sub   || null;
  const customerEmail = claims.email || null;

  console.log("userId resolved:", userId);
  console.log("customerEmail resolved:", customerEmail);

  try {

    // ── POST /payments/checkout-session ──────────────────────────────────
    if (method === "POST" && path.includes("checkout-session")) {
      const {
        items, shippingInfo, shippingMethod,
        shippingCost, subtotal, tax,
        discountAmount, couponCode, total, guestEmail
      } = body;

      const amountInCents = Math.round(parseFloat(total) * 100);
      if (!amountInCents || amountInCents < 50) {
        return response(400, { message: "Invalid order total" });
      }

      const guestEmailResolved =
        guestEmail ||
        (!userId ? shippingInfo?.email : null) ||
        null;

      // Logged-in users get their Cognito sub as userId
      // Guests get GUEST#email
      const orderUserId = userId
        ? userId
        : `GUEST#${guestEmailResolved || "unknown"}`;

      const orderId = randomUUID();

      const order = {
        userId:         orderUserId,
        orderId,
        customerEmail:  customerEmail || guestEmailResolved || "",
        guestEmail:     guestEmailResolved || null,
        status:         "pending_payment",
        paymentStatus:  "unpaid",
        items:          items                       || [],
        total:          parseFloat(total)           || 0,
        subtotal:       parseFloat(subtotal)        || 0,
        tax:            parseFloat(tax)             || 0,
        shippingCost:   parseFloat(shippingCost)    || 0,
        shippingMethod: shippingMethod              || "standard",
        discountAmount: parseFloat(discountAmount)  || 0,
        couponCode:     couponCode                  || null,
        shippingInfo:   shippingInfo                || {},
        createdAt:      new Date().toISOString(),
        updatedAt:      new Date().toISOString()
      };

      await client.send(new PutCommand({ TableName: ORDERS, Item: order }));

      console.log("Order created:", { orderId, orderUserId, customerEmail });

      // Single line item using pre-computed total
      // Never rebuild breakdown or pass coupon to Stripe
      const itemCount   = (items || []).length;
      const couponLabel = couponCode ? ` (${couponCode} applied)` : "";
      const lineItems   = [{
        price_data: {
          currency:     "cad",
          unit_amount:  amountInCents,
          product_data: {
            name: `STRIDELUX Order — ${itemCount} item${itemCount !== 1 ? "s" : ""}${couponLabel}`
          }
        },
        quantity: 1
      }];

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode:                 "payment",
        line_items:           lineItems,
        success_url: `${FRONTEND}/order-confirmation/${orderId}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${FRONTEND}/checkout`,
        metadata: {
          orderId,
          userId:        orderUserId,
          customerEmail: customerEmail || guestEmailResolved || ""
        },
        customer_email: customerEmail || guestEmailResolved || undefined
      });

      return ok({ orderId, url: session.url });
    }

    // ── POST /payments/webhook ────────────────────────────────────────────
    if (method === "POST" && path.includes("webhook")) {
      const sig           = event.headers?.["stripe-signature"];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      let stripeEvent;
      if (webhookSecret && sig) {
        try {
          stripeEvent = stripe.webhooks.constructEvent(
            event.body, sig, webhookSecret
          );
        } catch (err) {
          console.error("Webhook signature failed:", err.message);
          return response(400, { message: "Invalid signature" });
        }
      } else {
        stripeEvent = JSON.parse(event.body);
      }

      if (stripeEvent.type === "checkout.session.completed") {
        const session       = stripeEvent.data.object;
        const orderId       = session.metadata?.orderId;
        const orderUserId   = session.metadata?.userId;
        const customerEmail = session.metadata?.customerEmail;

        console.log("Webhook:", { orderId, orderUserId, customerEmail });

        if (orderId && orderUserId) {
          // Step 1 — update order status
          await client.send(new UpdateCommand({
            TableName: ORDERS,
            Key: { userId: orderUserId, orderId },
            UpdateExpression:
              "SET #s = :status, paymentStatus = :ps, " +
              "stripeSessionId = :sid, customerEmail = :email, " +
              "updatedAt = :ts",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":status": "processing",
              ":ps":     "paid",
              ":sid":    session.id,
              ":email":  customerEmail || "",
              ":ts":     new Date().toISOString()
            }
          }));

          // Step 2 — fetch order (needed for stock decrement AND confirmation email)
          const orderResult = await client.send(new QueryCommand({
            TableName: ORDERS,
            IndexName: "orderId-index",
            KeyConditionExpression: "orderId = :oid",
            ExpressionAttributeValues: { ":oid": orderId }
          }));

          const order = orderResult.Items?.[0];

          // Step 3 — decrement stockCount for each purchased item
          if (order?.items?.length) {
            await Promise.all(
              order.items.map(item =>
                client.send(new UpdateCommand({
                  TableName: PRODUCTS,
                  Key: { productId: item.productId },
                  // Use ADD for atomic decrement — cleaner than SET with arithmetic
                  // ADD with a negative number is the correct DynamoDB pattern
                  UpdateExpression:
                    "ADD stockCount :delta " +
                    "SET updatedAt = :ts",
                  ConditionExpression: "stockCount >= :qty",
                  ExpressionAttributeValues: {
                    ":delta": -item.quantity,
                    ":qty":   item.quantity,
                    ":ts":    new Date().toISOString()
                  }
                })).catch(err => {
                  if (err.name !== "ConditionalCheckFailedException") throw err;
                  console.warn(`Stock depleted for product ${item.productId}`);
                })
              )
            );
            console.log(`Stock decremented for ${order.items.length} item(s)`);
          }

          // Step 4 — send order confirmation email
          // Wrapped in try/catch so an SES failure never breaks the webhook response
          // back to Stripe. Order is confirmed in DynamoDB regardless.
          if (order) {
            try {
              await sendOrderConfirmationEmail(order);
            } catch (emailErr) {
              console.error("SES confirmation email failed:", emailErr);
            }
          }

          console.log(`Order ${orderId} → processing/paid`);
        }
      }

      return ok({ received: true });
    }

    // ── POST /coupons/validate ────────────────────────────────────────────
    if (method === "POST" && path.includes("coupons/validate")) {
      const { code } = body;
      if (!code) return badRequest("Coupon code is required");

      const result = await client.send(new ScanCommand({
        TableName: COUPONS,
        FilterExpression: "#c = :code",
        ExpressionAttributeNames: { "#c": "code" },
        ExpressionAttributeValues: {
          ":code": code.toUpperCase().trim()
        }
      }));

      const coupon = result.Items?.[0];
      if (!coupon) return notFound("Invalid or expired coupon code");

      const isActive =
        coupon.active === true   ||
        coupon.active === "true" ||
        coupon.active === 1;

      if (!isActive) return notFound("This coupon has been deactivated");

      return ok({
        code:     coupon.code,
        discount: coupon.discount,
        type:     coupon.type
      });
    }

    return notFound("Route not found");

  } catch (err) {
    console.error("Payments Lambda error:", err);
    return error(err.message);
  }
};

const ok         = b => response(200, b);
const notFound   = m => response(404, { message: m });
const badRequest = m => response(400, { message: m });
const error      = m => response(500, { message: m });

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
    },
    body: JSON.stringify(body)
  };
}