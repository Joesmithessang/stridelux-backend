// stridelux-orders-fn
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand
} = require("@aws-sdk/lib-dynamodb");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const { randomUUID } = require("crypto");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESv2Client({});
const TABLE = "stridelux-orders";
const SITE_URL = process.env.FRONTEND_URL;
const SES_FROM = process.env.SES_FROM_ADDRESS;

const STATUS_EMAILS = {
  pending: {
    label: "ORDER PENDING",
    icon: "!",
    subject: "is pending",
    title: "We received your order",
    message: "Your order is pending and will be processed shortly."
  },
  processing: {
    label: "ORDER PROCESSING",
    icon: "✓",
    subject: "is being processed",
    title: "We are preparing your order",
    message: "Your payment was successful and your order is now being prepared."
  },
  shipped: {
    label: "ORDER SHIPPED",
    icon: "✓",
    subject: "has shipped",
    title: "Your order is on its way",
    message: "Your package has shipped and is heading to you."
  },
  "out-for-delivery": {
    label: "OUT FOR DELIVERY",
    icon: "→",
    subject: "is out for delivery",
    title: "Your order is arriving soon",
    message: "Your package is with the delivery driver and should arrive soon."
  },
  delivered: {
    label: "ORDER DELIVERED",
    icon: "✓",
    subject: "has been delivered",
    title: "Your order has been delivered",
    message: "Your package has arrived. We hope you enjoy your purchase."
  },
  cancelled: {
    label: "ORDER CANCELLED",
    icon: "×",
    subject: "has been cancelled",
    title: "Your order was cancelled",
    message: "Your order has been cancelled. Contact us if you need assistance."
  }
};

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const money = value =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD"
  }).format(Number(value || 0));

const orderDate = value =>
  new Intl.DateTimeFormat("en-CA", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Toronto"
  }).format(value ? new Date(value) : new Date());

function normalizeStatus(status = "") {
  const value = String(status).toLowerCase().trim().replace(/_/g, "-");
  return ({ deliver: "delivered", canceled: "cancelled" })[value] || value;
}

function buildStatusEmail(order, status) {
  const info = STATUS_EMAILS[status];
  if (!info) throw new Error(`Unsupported email status: ${status}`);

  const shortId = String(order.orderId || "").slice(0, 8);
  const name =
    order.shippingInfo?.fullName ||
    order.customerName ||
    "Customer";
  const orderUrl =
    `${SITE_URL}/account/orders/${encodeURIComponent(order.orderId)}`;

  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items.map(item => {
    const quantity = Number(item.quantity || 1);
    const price = Number(item.price || 0);
    const size = item.selectedSize || item.size;
    const image = item.image
      ? escapeHtml(item.image.startsWith("http") ? item.image : `${SITE_URL}${item.image}`)
      : "";

    return `
      <tr>
        <td style="padding:18px 8px;border-bottom:1px solid #ececec">
          <table role="presentation" width="100%">
            <tr>
              ${image ? `
                <td width="82" style="padding-right:14px">
                  <img src="${image}" alt="${escapeHtml(item.name || "Product")}"
                    width="72" height="72"
                    style="display:block;width:72px;height:72px;object-fit:contain;background:#f5f5f5;border-radius:10px">
                </td>` : ""}
              <td>
                <div style="font-size:15px;font-weight:700;color:#111">
                  ${escapeHtml(item.name || "Product")}
                </div>
                ${size ? `
                  <div style="margin-top:5px;font-size:13px;color:#777">
                    Size: ${escapeHtml(size)}
                  </div>` : ""}
              </td>
            </tr>
          </table>
        </td>
        <td align="center" style="padding:18px 8px;border-bottom:1px solid #ececec;color:#444">
          ${quantity}
        </td>
        <td align="right" style="padding:18px 8px;border-bottom:1px solid #ececec;font-weight:700;white-space:nowrap">
          ${money(quantity * price)}
        </td>
      </tr>`;
  }).join("");

  const subtotal = Number(order.subtotal || 0);
  const shipping = Number(order.shippingCost || 0);
  const tax = Number(order.tax || 0);
  const discount = Number(order.discountAmount || 0);
  const total = Number(order.total || 0);
  const subject = `Your STRIDELUX order #${shortId} ${info.subject}`;

  const text = `
Hello ${name},

${info.title}

${info.message}

Order number: #${shortId}
Order date: ${orderDate(order.createdAt)}
Total: ${money(total)}

View your order:
${orderUrl}

STRIDELUX Customer Care
${SITE_URL}
  `.trim();

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f2f2f2;font-family:Arial,Helvetica,sans-serif;color:#111">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f2f2">
    <tr>
      <td align="center" style="padding:35px 15px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
          style="max-width:680px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 16px 45px rgba(0,0,0,.08)">

          <tr>
            <td style="background:#050505;padding:28px 34px">
              <table role="presentation" width="100%">
                <tr>
                  <td style="color:#fff;font-size:27px;font-weight:900;letter-spacing:3px">STRIDELUX</td>
                  <td align="right" style="color:#c9a227;font-size:13px;font-weight:800">${info.label}</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:42px 34px 25px">
              <div style="width:58px;height:58px;line-height:58px;text-align:center;background:#c9a227;border-radius:50%;font-size:29px;font-weight:800">
                ${info.icon}
              </div>
              <h1 style="margin:24px 0 13px;font-size:30px;line-height:1.25">
                ${info.title},
                <span style="color:#c9a227">${escapeHtml(name)}</span>
              </h1>
              <p style="margin:0;color:#5e5e5e;font-size:16px;line-height:1.7">
                ${info.message}
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:0 34px 25px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                style="background:#f7f7f7;border-radius:12px">
                <tr>
                  <td width="50%" style="padding:19px;border-right:1px solid #e5e5e5">
                    <div style="color:#888;font-size:12px;font-weight:700;letter-spacing:1px">ORDER NUMBER</div>
                    <div style="margin-top:7px;font-size:16px;font-weight:700">#${escapeHtml(shortId)}</div>
                  </td>
                  <td width="50%" style="padding:19px">
                    <div style="color:#888;font-size:12px;font-weight:700;letter-spacing:1px">ORDER DATE</div>
                    <div style="margin-top:7px;font-size:15px;font-weight:700">${escapeHtml(orderDate(order.createdAt))}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${items.length ? `
          <tr>
            <td style="padding:0 34px 30px">
              <h2 style="margin:0 0 18px;font-size:19px">Order summary</h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
                <thead>
                  <tr>
                    <th align="left" style="padding:12px 8px;border-bottom:2px solid #c9a227;color:#555;font-size:12px;letter-spacing:.8px">ITEM</th>
                    <th align="center" style="padding:12px 8px;border-bottom:2px solid #c9a227;color:#555;font-size:12px;letter-spacing:.8px">QTY</th>
                    <th align="right" style="padding:12px 8px;border-bottom:2px solid #c9a227;color:#555;font-size:12px;letter-spacing:.8px">PRICE</th>
                  </tr>
                </thead>
                <tbody>${itemRows}</tbody>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px">
                ${subtotal ? `<tr><td align="right" style="padding:6px 8px;color:#666">Subtotal</td><td align="right" width="130" style="padding:6px 8px">${money(subtotal)}</td></tr>` : ""}
                ${shipping ? `<tr><td align="right" style="padding:6px 8px;color:#666">Shipping</td><td align="right" style="padding:6px 8px">${money(shipping)}</td></tr>` : ""}
                ${tax ? `<tr><td align="right" style="padding:6px 8px;color:#666">Tax</td><td align="right" style="padding:6px 8px">${money(tax)}</td></tr>` : ""}
                ${discount ? `<tr><td align="right" style="padding:6px 8px;color:#16823a">Discount</td><td align="right" style="padding:6px 8px;color:#16823a">−${money(discount)}</td></tr>` : ""}
                <tr>
                  <td align="right" style="padding:16px 8px 8px;border-top:1px solid #ddd;font-size:17px;font-weight:900">Total</td>
                  <td align="right" style="padding:16px 8px 8px;border-top:1px solid #ddd;color:#c9a227;font-size:20px;font-weight:900">${money(total)}</td>
                </tr>
              </table>
            </td>
          </tr>` : ""}

          <tr>
            <td style="padding:0 34px 35px">
              <table role="presentation" width="100%">
                <tr>
                  <td align="center" style="background:#c9a227;border-radius:8px">
                    <a href="${escapeHtml(orderUrl)}"
                      style="display:block;padding:16px 24px;color:#111;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:.7px">
                      VIEW YOUR ORDER
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="center" style="background:#050505;padding:27px 25px">
              <div style="color:#fff;font-size:19px;font-weight:900;letter-spacing:2px">STRIDELUX</div>
              <p style="margin:12px 0 0;color:#a7a7a7;font-size:12px">
                © ${new Date().getFullYear()} STRIDELUX. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

async function sendStatusEmail(order, status) {
  const recipient =
    order.customerEmail ||
    order.guestEmail ||
    order.shippingInfo?.email;

  if (!recipient) {
    console.warn(`Order ${order.orderId} has no email address`);
    return;
  }

  if (!SES_FROM || !SITE_URL) {
    throw new Error("SES_FROM_ADDRESS or FRONTEND_URL is missing");
  }

  const { subject, text, html } = buildStatusEmail(order, status);

  await ses.send(new SendEmailCommand({
    FromEmailAddress: SES_FROM,
    Destination: { ToAddresses: [recipient] },
    ReplyToAddresses: [process.env.SES_REPLY_TO || SES_FROM],
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: html, Charset: "UTF-8" },
          Text: { Data: text, Charset: "UTF-8" }
        }
      }
    }
  }));
}

exports.handler = async event => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const pathParams = event.pathParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};
  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const rawPath = event.rawPath || event.path || "";

  const rawGroups = claims["cognito:groups"];
  const groups = Array.isArray(rawGroups)
    ? rawGroups
    : typeof rawGroups === "string"
      ? rawGroups.replace(/^\[|\]$/g, "").split(",").map(g => g.trim()).filter(Boolean)
      : [];
  const isAdmin = groups.includes("Admins");

  try {
    // POST /orders
    if (method === "POST" && !pathParams.orderId && !rawPath.includes("status")) {
      const order = {
        userId: userId || `GUEST#${body.guestEmail}`,
        orderId: randomUUID(),
        status: "pending",
        paymentStatus: "pending",
        items: body.items || [],
        total: body.total || 0,
        shippingInfo: body.shippingInfo || {},
        customerEmail: claims.email || body.guestEmail || body.shippingInfo?.email || "",
        guestEmail: body.guestEmail || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await client.send(new PutCommand({ TableName: TABLE, Item: order }));
      return created(order);
    }

    // GET /orders
    if (method === "GET" && !pathParams.orderId && !rawPath.includes("admin")) {
      if (!userId) return forbidden();

      const byUserId = await client.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        ScanIndexForward: false
      }));

      let orders = byUserId.Items || [];

      if (!orders.length && claims.email) {
        const byEmail = await client.send(new ScanCommand({
          TableName: TABLE,
          FilterExpression: "customerEmail = :email OR guestEmail = :email",
          ExpressionAttributeValues: { ":email": claims.email }
        }));
        orders = byEmail.Items || [];
      }

      return ok(
        orders
          .filter(order => order.status !== "pending_payment")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      );
    }

    // GET /orders/:orderId
    if (method === "GET" && pathParams.orderId && !rawPath.includes("admin")) {
      const result = await client.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "orderId-index",
        KeyConditionExpression: "orderId = :oid",
        ExpressionAttributeValues: { ":oid": pathParams.orderId }
      }));

      const order = result.Items?.[0];
      if (!order) return notFound("Order not found");

      const isOwner =
        order.userId === userId ||
        order.customerEmail === claims.email ||
        order.guestEmail === claims.email;

      if (!isAdmin && !isOwner) return forbidden();
      return ok(order);
    }

    // GET /admin/orders
    if (method === "GET" && rawPath.includes("admin/orders")) {
      if (!isAdmin) return forbidden();

      const status = event.queryStringParameters?.status;

      if (status && status !== "All") {
        const result = await client.send(new QueryCommand({
          TableName: TABLE,
          IndexName: "status-index",
          KeyConditionExpression: "#s = :status",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":status": status },
          ScanIndexForward: false
        }));
        return ok(result.Items || []);
      }

      const result = await client.send(new ScanCommand({ TableName: TABLE }));
      return ok((result.Items || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }

    // PUT /admin/orders/:orderId/status
    if (method === "PUT" && pathParams.orderId && rawPath.includes("status")) {
      if (!isAdmin) return forbidden();
      if (!body.status) return badRequest("status field is required");

      const status = normalizeStatus(body.status);
      const valid = Object.keys(STATUS_EMAILS);

      if (!valid.includes(status)) {
        return badRequest(`Invalid status. Must be one of: ${valid.join(", ")}`);
      }

      const found = await client.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "orderId-index",
        KeyConditionExpression: "orderId = :oid",
        ExpressionAttributeValues: { ":oid": pathParams.orderId }
      }));

      const order = found.Items?.[0];
      if (!order) return notFound("Order not found");

      const result = await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId: order.userId, orderId: pathParams.orderId },
        UpdateExpression: "SET #s = :status, updatedAt = :ts",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":ts": new Date().toISOString()
        },
        ReturnValues: "ALL_NEW"
      }));

      try {
        await sendStatusEmail(result.Attributes, status);
        console.log(`Professional ${status} email sent for ${pathParams.orderId}`);
      } catch (emailError) {
        console.error("Status email failed:", emailError);
      }

      return ok(result.Attributes);
    }

    return notFound("Route not found");
  } catch (err) {
    console.error("Orders Lambda error:", err);
    return error(err.message);
  }
};

const ok = body => response(200, body);
const created = body => response(201, body);
const notFound = message => response(404, { message });
const forbidden = () => response(403, { message: "Forbidden" });
const badRequest = message => response(400, { message });
const error = message => response(500, { message });

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
