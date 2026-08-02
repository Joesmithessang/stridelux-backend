// stridelux-admin-fn
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const sesClient = new SESv2Client({});
const SES_FROM = process.env.SES_FROM_ADDRESS;
const SITE_URL = process.env.FRONTEND_URL;

const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const cognitoClient = new CognitoIdentityProviderClient({ region: "us-east-1" });
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const client         = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ORDERS_TABLE   = "stridelux-orders";
const PRODUCTS_TABLE = "stridelux-products";
const USERS_TABLE    = "stridelux-users";
const VALID_USER_STATUSES = ["active", "inactive"];

// ── Professional status emails ────────────────────────────────────────────────
const STATUS_EMAIL_COPY = {
  pending: {
    label: "ORDER PENDING",
    icon: "!",
    subject: "is pending",
    heading: "We received your order",
    body: "Your order is pending and will be processed shortly."
  },
  processing: {
    label: "ORDER PROCESSING",
    icon: "✓",
    subject: "is being processed",
    heading: "We are preparing your order",
    body: "Your payment was successful and your order is now being prepared."
  },
  shipped: {
    label: "ORDER SHIPPED",
    icon: "✓",
    subject: "has shipped",
    heading: "Your order is on its way",
    body: "Your package has shipped and is heading to you."
  },
  out_for_delivery: {
    label: "OUT FOR DELIVERY",
    icon: "→",
    subject: "is out for delivery",
    heading: "Your order is arriving soon",
    body: "Your package is with the delivery driver and should arrive soon."
  },
  delivered: {
    label: "ORDER DELIVERED",
    icon: "✓",
    subject: "has been delivered",
    heading: "Your order has been delivered",
    body: "Your package has arrived. We hope you enjoy your purchase."
  },
  cancelled: {
    label: "ORDER CANCELLED",
    icon: "×",
    subject: "has been cancelled",
    heading: "Your order was cancelled",
    body: "Your order has been cancelled. Contact us if you need assistance."
  }
};

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const formatMoney = value =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD"
  }).format(Number(value || 0));

const formatOrderDate = value =>
  new Intl.DateTimeFormat("en-CA", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Toronto"
  }).format(value ? new Date(value) : new Date());

function buildStatusEmail(order, status) {
  const copy = STATUS_EMAIL_COPY[status];
  if (!copy) return null;

  const shortId = String(order.orderId || "").slice(0, 8);
  const customerName =
    order.shippingInfo?.fullName ||
    order.customerName ||
    "Customer";

  const orderUrl =
    `${SITE_URL}/account/orders/${encodeURIComponent(order.orderId)}`;

  const items = Array.isArray(order.items) ? order.items : [];
  const subtotal = Number(order.subtotal || 0);
  const shipping = Number(order.shippingCost || 0);
  const tax = Number(order.tax || 0);
  const discount = Number(order.discountAmount || 0);
  const total = Number(order.total || 0);

  const itemRows = items.map(item => {
    const quantity = Number(item.quantity || 1);
    const price = Number(item.price || 0);
    const size = item.selectedSize || item.size;
    const image = item.image || item.thumbnail || item.imageKey || "";
    const imageUrl = image
      ? escapeHtml(image.startsWith("http") ? image : `${SITE_URL}${image}`)
      : "";

    return `
      <tr>
        <td style="padding:18px 8px;border-bottom:1px solid #ececec">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              ${imageUrl ? `
                <td width="82" style="width:82px;padding-right:14px">
                  <img
                    src="${imageUrl}"
                    alt="${escapeHtml(item.name || "Product")}"
                    width="72"
                    height="72"
                    style="display:block;width:72px;height:72px;object-fit:contain;background:#f5f5f5;border-radius:10px"
                  />
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
          ${formatMoney(quantity * price)}
        </td>
      </tr>`;
  }).join("");

  const subject = `Your STRIDELUX order #${shortId} ${copy.subject}`;

  const text = `
Hello ${customerName},

${copy.heading}

${copy.body}

Order number: #${shortId}
Order date: ${formatOrderDate(order.createdAt)}
Total: ${formatMoney(total)}

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
          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            style="max-width:680px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 16px 45px rgba(0,0,0,.08)"
          >
            <tr>
              <td style="background:#050505;padding:28px 34px">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="color:#fff;font-size:27px;font-weight:900;letter-spacing:3px">
                      STRIDELUX
                    </td>
                    <td align="right" style="color:#c9a227;font-size:13px;font-weight:800">
                      ${copy.label}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:42px 34px 25px">
                <div style="width:58px;height:58px;line-height:58px;text-align:center;background:#c9a227;border-radius:50%;font-size:29px;font-weight:800">
                  ${copy.icon}
                </div>

                <h1 style="margin:24px 0 13px;font-size:30px;line-height:1.25">
                  ${copy.heading},
                  <span style="color:#c9a227">${escapeHtml(customerName)}</span>
                </h1>

                <p style="margin:0;color:#5e5e5e;font-size:16px;line-height:1.7">
                  ${copy.body}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 34px 25px">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f7;border-radius:12px">
                  <tr>
                    <td width="50%" style="padding:19px;border-right:1px solid #e5e5e5">
                      <div style="color:#888;font-size:12px;font-weight:700;letter-spacing:1px">
                        ORDER NUMBER
                      </div>
                      <div style="margin-top:7px;font-size:16px;font-weight:700">
                        #${escapeHtml(shortId)}
                      </div>
                    </td>
                    <td width="50%" style="padding:19px">
                      <div style="color:#888;font-size:12px;font-weight:700;letter-spacing:1px">
                        ORDER DATE
                      </div>
                      <div style="margin-top:7px;font-size:15px;font-weight:700">
                        ${escapeHtml(formatOrderDate(order.createdAt))}
                      </div>
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
                        <th align="left" style="padding:12px 8px;border-bottom:2px solid #c9a227;color:#555;font-size:12px;letter-spacing:.8px">
                          ITEM
                        </th>
                        <th align="center" style="padding:12px 8px;border-bottom:2px solid #c9a227;color:#555;font-size:12px;letter-spacing:.8px">
                          QTY
                        </th>
                        <th align="right" style="padding:12px 8px;border-bottom:2px solid #c9a227;color:#555;font-size:12px;letter-spacing:.8px">
                          PRICE
                        </th>
                      </tr>
                    </thead>
                    <tbody>${itemRows}</tbody>
                  </table>

                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px">
                    ${subtotal ? `
                      <tr>
                        <td align="right" style="padding:6px 8px;color:#666">Subtotal</td>
                        <td align="right" width="130" style="padding:6px 8px">${formatMoney(subtotal)}</td>
                      </tr>` : ""}
                    ${shipping ? `
                      <tr>
                        <td align="right" style="padding:6px 8px;color:#666">Shipping</td>
                        <td align="right" style="padding:6px 8px">${formatMoney(shipping)}</td>
                      </tr>` : ""}
                    ${tax ? `
                      <tr>
                        <td align="right" style="padding:6px 8px;color:#666">Tax</td>
                        <td align="right" style="padding:6px 8px">${formatMoney(tax)}</td>
                      </tr>` : ""}
                    ${discount ? `
                      <tr>
                        <td align="right" style="padding:6px 8px;color:#16823a">Discount</td>
                        <td align="right" style="padding:6px 8px;color:#16823a">
                          −${formatMoney(discount)}
                        </td>
                      </tr>` : ""}
                    <tr>
                      <td align="right" style="padding:16px 8px 8px;border-top:1px solid #ddd;font-size:17px;font-weight:900">
                        Total
                      </td>
                      <td align="right" style="padding:16px 8px 8px;border-top:1px solid #ddd;color:#c9a227;font-size:20px;font-weight:900">
                        ${formatMoney(total)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>` : ""}

            <tr>
              <td style="padding:0 34px 35px">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td align="center" style="background:#c9a227;border-radius:8px">
                      <a
                        href="${escapeHtml(orderUrl)}"
                        style="display:block;padding:16px 24px;color:#111;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:.7px"
                      >
                        VIEW YOUR ORDER
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="background:#050505;padding:27px 25px">
                <div style="color:#fff;font-size:19px;font-weight:900;letter-spacing:2px">
                  STRIDELUX
                </div>
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
  const email = buildStatusEmail(order, status);
  if (!email) return;

  const recipientEmail =
    order.customerEmail ||
    order.guestEmail ||
    order.shippingInfo?.email;

  if (!recipientEmail) {
    console.warn(`No recipient email on order ${order.orderId}`);
    return;
  }

  if (!SES_FROM || !SITE_URL) {
    throw new Error("SES_FROM_ADDRESS or FRONTEND_URL is missing");
  }

  await sesClient.send(new SendEmailCommand({
    FromEmailAddress: SES_FROM,
    Destination: { ToAddresses: [recipientEmail] },
    ReplyToAddresses: [process.env.SES_REPLY_TO || SES_FROM],
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: email.html, Charset: "UTF-8" },
          Text: { Data: email.text, Charset: "UTF-8" }
        }
      }
    }
  }));

  console.log(`Professional ${status} email sent → ${recipientEmail}`);
}


// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log("FULL EVENT:", JSON.stringify(event, null, 2));
  const method     = event.requestContext?.http?.method || event.httpMethod;
  const path       = event.rawPath || event.path || "";
  const qs         = event.queryStringParameters || {};
  const body       = event.body ? JSON.parse(event.body) : {};
  const claims     = event.requestContext?.authorizer?.jwt?.claims || {};
  const pathParams = event.pathParameters || {};

  // Fix: handle groups as array or string
  const rawGroups = claims["cognito:groups"];
  const groups = Array.isArray(rawGroups)
    ? rawGroups
    : typeof rawGroups === "string"
      ? rawGroups
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(g => g.trim())
          .filter(Boolean)
      : [];

  if (!groups.includes("Admins")) return forbidden();

  try {

    // ── GET /admin/dashboard ───────────────────────────────────────────────
    if (method === "GET" && path.includes("dashboard")) {
      const [ordersResult, productsResult, usersResult] = await Promise.all([
        client.send(new ScanCommand({ TableName: ORDERS_TABLE })),
        client.send(new ScanCommand({ TableName: PRODUCTS_TABLE })),
        client.send(new ScanCommand({ TableName: USERS_TABLE }))
      ]);

      const allOrders   = ordersResult.Items   || [];
      const allProducts = productsResult.Items || [];
      const allUsers    = usersResult.Items    || [];

      const paidOrders = allOrders.filter(
        o => o.paymentStatus === "paid" || o.paymentStatus === "succeeded"
      );

      const totalRevenue = paidOrders.reduce(
        (sum, o) => sum + (o.total || 0), 0
      );

      const visibleOrders = allOrders.filter(o => o.status !== "pending_payment");
      const recentOrders  = [...visibleOrders]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 5);

      const monthlySales = buildMonthlySales(paidOrders);

      const productSales = {};
      paidOrders.forEach(order => {
        (order.items || []).forEach(item => {
          if (!productSales[item.productId]) {
            productSales[item.productId] = {
              id:        item.productId,
              name:      item.name      || "",
              brand:     item.brand     || "",
              thumbnail: item.thumbnail || item.imageKey || "",
              price:     item.price     || 0,
              sold:      0
            };
          }
          productSales[item.productId].sold += item.quantity || 1;
        });
      });

      const topProducts = Object.values(productSales)
        .sort((a, b) => b.sold - a.sold)
        .slice(0, 5);

      return ok({
        totalRevenue,
        totalOrders:   visibleOrders.length,
        totalProducts: allProducts.length,
        totalUsers:    allUsers.filter(u => u.role === "customer").length,
        pendingOrders: allOrders.filter(o => o.status === "pending").length,
        recentOrders,
        monthlySales,
        topProducts
      });
    }

    // ── GET /admin/reports?range=30d ───────────────────────────────────────
    if (method === "GET" && path.includes("reports")) {
      const rangeStr = qs.range || "30d";
      const days     = parseInt(rangeStr) || 30;
      const since    = new Date(Date.now() - days * 86400000).toISOString();

      const result = await client.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: "createdAt >= :since",
        ExpressionAttributeValues: { ":since": since }
      }));

      const allOrders = result.Items || [];
      const paid      = allOrders.filter(
        o => o.paymentStatus === "paid" || o.paymentStatus === "succeeded"
      );

      const revenue           = paid.reduce((sum, o) => sum + (o.total || 0), 0);
      const averageOrderValue = paid.length > 0
        ? Math.round((revenue / paid.length) * 100) / 100
        : 0;

      const revenueByDay = {};
      paid.forEach(o => {
        const day = o.createdAt?.substring(0, 10);
        if (day) revenueByDay[day] = (revenueByDay[day] || 0) + (o.total || 0);
      });

      return ok({
        range:             rangeStr,
        revenue,
        orders:            paid.length,
        averageOrderValue,
        transactions:      allOrders,
        revenueByDay
      });
    }

    // ── GET /admin/users ───────────────────────────────────────────────────
    if (method === "GET" && path.includes("users") && !path.includes("employees")) {
      const [usersResult, ordersResult] = await Promise.all([
        client.send(new ScanCommand({ TableName: USERS_TABLE })),
        client.send(new ScanCommand({
          TableName: ORDERS_TABLE,
          FilterExpression: "paymentStatus = :ps",
          ExpressionAttributeValues: { ":ps": "paid" }
        }))
      ]);

      const allOrders = ordersResult.Items || [];

      const statsMap = {};
      allOrders.forEach(o => {
        const email = o.customerEmail || o.guestEmail || o.shippingInfo?.email;
        if (!email) return;
        if (!statsMap[email]) statsMap[email] = { totalOrders: 0, totalSpent: 0 };
        statsMap[email].totalOrders += 1;
        statsMap[email].totalSpent  += o.total || 0;
      });

      const users = usersResult.Items || [];

      // Fix: don't hardcode status — read what's actually stored,
      // fall back to null (not "active") so the frontend can show "Unknown"
      const customers = users
        .filter(u => (u.role || "customer") === "customer")
        .map(u => ({
          id:          u.userId,
          name:        u.name,
          email:       u.email,
          phone:       u.phone || u.phoneNumber || "",
          joinedAt:    u.createdAt,
          totalOrders: statsMap[u.email]?.totalOrders || 0,
          totalSpent:  statsMap[u.email]?.totalSpent  || 0,
          status:      u.status ?? null
        }));

      const employees = users
        .filter(u => u.role === "admin" || u.role === "Administrator")
        .map(u => ({
          id:         u.userId,
          name:       u.name,
          email:      u.email,
          phone:      u.phone || u.phoneNumber || "",
          role:       u.role,
          department: u.department || "Administration",
          joinedAt:   u.createdAt,
          status:     u.status ?? null
        }));

      return ok({ customers, employees });
    }

    // ── GET /admin/orders ──────────────────────────────────────────────────
    if (method === "GET" && path.includes("orders") && !path.includes("status")) {
      const statusFilter = qs.status;
      let scanParams = { TableName: ORDERS_TABLE };

      // Only filter by status when explicitly requested — never filter by default
      // or pending_payment orders will disappear from the admin view
      if (statusFilter && statusFilter !== "all") {
        scanParams.FilterExpression    = "#s = :status";
        scanParams.ExpressionAttributeNames  = { "#s": "status" };
        scanParams.ExpressionAttributeValues = { ":status": statusFilter };
      }

      const result = await client.send(new ScanCommand(scanParams));
      const orders = (result.Items || []).sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt)
      );
      return ok(orders);
    }

    // ── PUT /admin/orders/{orderId}/status ─────────────────────────────────
    if (method === "PUT" && path.includes("orders") && path.includes("status")) {
      const { orderId } = pathParams;
      if (!orderId) return badRequest("orderId is required");

      // Normalise to lowercase_underscore so the STATUS_EMAIL_COPY lookup
      // works regardless of what casing the admin frontend sends
      // e.g. "Out for Delivery" → "out_for_delivery"
      const normalizedStatus = (body.status || "")
        .toLowerCase()
        .trim()
        .replace(/[\s-]+/g, "_");

      const newStatus = normalizedStatus === "canceled"
        ? "cancelled"
        : normalizedStatus;

      if (!newStatus) return badRequest("status is required");

      const validStatuses = Object.keys(STATUS_EMAIL_COPY);
      if (!validStatuses.includes(newStatus)) {
        return badRequest(
          `Invalid status. Must be one of: ${validStatuses.join(", ")}`
        );
      }

      // Step 1 — look up existing order via orderId-index GSI to get composite key
      const lookup = await client.send(new QueryCommand({
        TableName:              ORDERS_TABLE,
        IndexName:              "orderId-index",
        KeyConditionExpression: "orderId = :oid",
        ExpressionAttributeValues: { ":oid": orderId }
      }));

      const existingOrder = lookup.Items?.[0];
      if (!existingOrder) return notFound("Order not found");

      // Step 2 — update the order status
      const updateResult = await client.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { userId: existingOrder.userId, orderId: existingOrder.orderId },
        UpdateExpression: "SET #s = :status, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": newStatus,
          ":now": new Date().toISOString()
        },
        ReturnValues: "ALL_NEW"
      }));

      // Step 3 — send status notification email if this status warrants one.
      // Wrapped in try/catch so an SES failure never blocks the status update
      // response back to the admin dashboard.
      try {
        await sendStatusEmail(updateResult.Attributes, newStatus);
      } catch (emailErr) {
        console.error(`SES status email failed (${newStatus}):`, emailErr);
      }

      console.log(`Order ${orderId} status → ${newStatus}`);
      return ok(updateResult.Attributes);
    }

    // ── POST /admin/employees ──────────────────────────────────────────────
    if (method === "POST" && path.includes("employees")) {
      const { name, email, phone, department, joinedAt } = body;

      if (!name || !email) return badRequest("name and email are required");

      const username = name.toLowerCase().replace(/\s+/g, ".") + "." + Date.now();

      await cognitoClient.send(new AdminCreateUserCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        Username:   username,
        TemporaryPassword: "Temp1234!",
        UserAttributes: [
          { Name: "email",          Value: email },
          { Name: "name",           Value: name },
          { Name: "phone_number",   Value: phone || "" },
          { Name: "custom:role",    Value: "admin" },
          { Name: "email_verified", Value: "true" }
        ],
        MessageAction: "SUPPRESS"
      }));

      await cognitoClient.send(new AdminAddUserToGroupCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        Username:   username,
        GroupName:  "Admins"
      }));

      const employee = {
        userId:     randomUUID(),
        username,
        name:       name       || "",
        email:      email      || "",
        phone:      phone      || "",
        role:       "admin",
        department: department || "Administration",
        joinedAt:   joinedAt   || new Date().toISOString(),
        createdAt:  new Date().toISOString(),
        updatedAt:  new Date().toISOString()
      };

      await client.send(new PutCommand({ TableName: USERS_TABLE, Item: employee }));

      return created({
        ...employee,
        message: "Team member created. They can sign in with their email and temporary password Temp1234!"
      });
    }

    // ── PUT /admin/employees/:id ────────────────────────────────────────────
    if (method === "PUT" && path.includes("employees") && pathParams.id) {
      const { status, ...rest } = body;

      if (status && !VALID_USER_STATUSES.includes(status)) {
        return badRequest(`Invalid status. Must be one of: ${VALID_USER_STATUSES.join(", ")}`);
      }

      const updates = { ...rest, updatedAt: new Date().toISOString() };
      delete updates.userId;

      const setExprs  = Object.keys(updates).map(k => `#${k} = :${k}`);
      const exprNames = Object.fromEntries(Object.keys(updates).map(k => [`#${k}`, k]));
      const exprVals  = Object.fromEntries(Object.keys(updates).map(k => [`:${k}`, updates[k]]));

      let updateExpr = `SET ${setExprs.join(", ")}`;

      if (status) {
        setExprs.push("#status = :status");
        exprNames["#status"] = "status";
        exprVals[":status"] = status;
        updateExpr = `SET ${setExprs.join(", ")}`;
      } else if (status === "" || status === null) {
        updateExpr += " REMOVE #status";
        exprNames["#status"] = "status";
      }

      const result = await client.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId: pathParams.id },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprVals,
        ReturnValues: "ALL_NEW"
      }));
      return ok(result.Attributes);
    }

    // ── PUT /admin/customer/:id ─────────────────────────────────────────────
    if (method === "PUT" && path.includes("customer") && pathParams.id) {
      const { status, ...rest } = body;

      if (status && !VALID_USER_STATUSES.includes(status)) {
        return badRequest(`Invalid status. Must be one of: ${VALID_USER_STATUSES.join(", ")}`);
      }

      const updates = { ...rest, updatedAt: new Date().toISOString() };
      delete updates.userId;

      const setExprs  = Object.keys(updates).map(k => `#${k} = :${k}`);
      const exprNames = Object.fromEntries(Object.keys(updates).map(k => [`#${k}`, k]));
      const exprVals  = Object.fromEntries(Object.keys(updates).map(k => [`:${k}`, updates[k]]));

      let updateExpr = `SET ${setExprs.join(", ")}`;

      if (status) {
        setExprs.push("#status = :status");
        exprNames["#status"] = "status";
        exprVals[":status"] = status;
        updateExpr = `SET ${setExprs.join(", ")}`;
      } else if (status === "" || status === null) {
        updateExpr += " REMOVE #status";
        exprNames["#status"] = "status";
      }

      const result = await client.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId: pathParams.id },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprVals,
        ReturnValues: "ALL_NEW"
      }));
      return ok(result.Attributes);
    }

    // ── DELETE /admin/employees/:id ────────────────────────────────────────
    if (method === "DELETE" && path.includes("employees") && pathParams.id) {
      await client.send(new DeleteCommand({
        TableName: USERS_TABLE,
        Key: { userId: pathParams.id }
      }));
      return ok({ message: "Employee removed" });
    }

    // ── GET /admin/coupons ─────────────────────────────────────────────────
    if (method === "GET" && path.includes("coupons")) {
      const result = await client.send(new ScanCommand({ TableName: "stridelux-coupons" }));
      return ok(result.Items || []);
    }

    // ── POST /admin/coupons ────────────────────────────────────────────────
    if (method === "POST" && path.includes("coupons") && !pathParams.couponId) {
      const coupon = {
        couponId:  randomUUID(),
        code:      (body.code || "").toUpperCase(),
        discount:  body.discount,
        type:      body.type || "percentage",
        active:    true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await client.send(new PutCommand({ TableName: "stridelux-coupons", Item: coupon }));
      return created(coupon);
    }

    // ── PUT /admin/coupons/:couponId ───────────────────────────────────────
    if (method === "PUT" && path.includes("coupons") && pathParams.couponId) {
      if (!pathParams.couponId || pathParams.couponId === "undefined" || pathParams.couponId === "null") {
        return badRequest("Invalid coupon ID");
      }

      const existing = await client.send(new GetCommand({
        TableName: "stridelux-coupons",
        Key: { couponId: pathParams.couponId }
      }));

      if (!existing.Item) return notFound("Coupon not found");

      const updates = { ...body, updatedAt: new Date().toISOString() };
      if (updates.code) updates.code = updates.code.toUpperCase();
      delete updates.couponId;
      delete updates.createdAt;

      const setExprs  = Object.keys(updates).map(k => `#${k} = :${k}`);
      const exprNames = Object.fromEntries(Object.keys(updates).map(k => [`#${k}`, k]));
      const exprVals  = Object.fromEntries(Object.keys(updates).map(k => [`:${k}`, updates[k]]));

      const result = await client.send(new UpdateCommand({
        TableName: "stridelux-coupons",
        Key: { couponId: pathParams.couponId },
        UpdateExpression: `SET ${setExprs.join(", ")}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprVals,
        ReturnValues: "ALL_NEW"
      }));
      return ok(result.Attributes);
    }

    // ── DELETE /admin/coupons/:couponId ────────────────────────────────────
    if (method === "DELETE" && path.includes("coupons") && pathParams.couponId) {
      await client.send(new DeleteCommand({
        TableName: "stridelux-coupons",
        Key: { couponId: pathParams.couponId }
      }));
      return ok({ message: "Coupon deleted" });
    }

    return notFound("Route not found");

  } catch (err) {
    console.error("Admin Lambda error:", err);
    return error(err.message);
  }
};

// ── Build last 6 months revenue breakdown ─────────────────────────────────────
function buildMonthlySales(orders) {
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    months.push({
      month:   d.toLocaleString("default", { month: "short" }),
      year:    d.getFullYear(),
      key:     `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      revenue: 0
    });
  }
  orders.forEach(o => {
    if (o.paymentStatus !== "succeeded" && o.paymentStatus !== "paid") return;
    const key = o.createdAt?.substring(0, 7);
    const m   = months.find(m => m.key === key);
    if (m) m.revenue += o.total || 0;
  });
  return months.map(({ month, revenue }) => ({ month, revenue }));
}

const ok         = b => response(200, b);
const created    = b => response(201, b);
const notFound   = m => response(404, { message: m });
const forbidden  = () => response(403, { message: "Forbidden" });
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