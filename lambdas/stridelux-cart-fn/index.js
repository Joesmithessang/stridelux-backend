/**
 * stridelux-cart-fn
 *
 * Routes (all behind cognito-authorizer):
 *   GET    /cart
 *   POST   /cart
 *   PUT    /cart/{productId}
 *   DELETE /cart/{productId}
 *   DELETE /cart
 *   GET    /wishlist
 *   POST   /wishlist
 *   DELETE /wishlist/{productId}
 *
 * Required IAM (stridelux-cart-fn-role):
 *   - GetItem, PutItem, UpdateItem, DeleteItem, Query, BatchWriteItem on stridelux-cart-wishlist
 *   - BatchGetItem (read-only) on stridelux-products
 *
 * Node 22.x runtime. Save as index.js, NOT index.mjs (uses require, not import).
 * AWS SDK v3 is bundled in the Node 22.x Lambda runtime — no node_modules needed.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchGetCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = "stridelux-cart-wishlist";
const PRODUCTS_TABLE = "stridelux-products";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body ?? {}),
  };
}

function getUserId(event) {
  return event.requestContext?.authorizer?.jwt?.claims?.sub;
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return null; // signals invalid JSON to the caller
  }
}

/**
 * Merges live product data into cart/wishlist items so the frontend
 * gets everything it needs in one response (no N+1 product fetches).
 * BatchGetItem caps at 100 keys per call — fine for any realistic
 * cart/wishlist size, but chunk it if that ever changes.
 */
async function enrichWithProducts(items) {
  if (items.length === 0) return [];

  const productIds = [...new Set(items.map((i) => i.productId))];
  const { Responses } = await ddb.send(
    new BatchGetCommand({
      RequestItems: {
        [PRODUCTS_TABLE]: { Keys: productIds.map((productId) => ({ productId })) },
      },
    })
  );

  const productMap = Object.fromEntries(
    (Responses?.[PRODUCTS_TABLE] || []).map((p) => [p.productId, p])
  );

  return items.map((item) => ({
    productId: item.productId,
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
    addedAt: item.addedAt,
    product: productMap[item.productId] || null, // null = product deleted/discontinued
  }));
}

// ---------- CART ----------

async function getCart(userId) {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :u AND begins_with(itemId, :prefix)",
      ExpressionAttributeValues: { ":u": userId, ":prefix": "CART#" },
    })
  );
  return respond(200, await enrichWithProducts(Items));
}

// POST /cart — upsert. Frontend sends the new TOTAL quantity, not a delta.
async function addOrUpdateCartItem(userId, event) {
  const body = parseBody(event);
  if (body === null) return respond(400, { error: "Invalid JSON body" });

  const { productId, quantity } = body;
  const size = body.size || "NA";

  if (!productId || !Number.isInteger(quantity) || quantity < 1) {
    return respond(400, { error: "productId and a positive integer quantity are required" });
  }

  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId, itemId: `CART#${productId}#${size}` },
      UpdateExpression:
        "SET #type = :type, productId = :productId, size = :size, quantity = :quantity, updatedAt = :now, addedAt = if_not_exists(addedAt, :now)",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: {
        ":type": "CART",
        ":productId": productId,
        ":size": size,
        ":quantity": quantity,
        ":now": now,
      },
    })
  );

  return respond(200, { productId, size, quantity });
}

// PUT /cart/{productId} — quantity update on an existing line.
// size comes in the body since it's part of the sort key, not the URL.
async function updateCartItem(userId, productId, event) {
  const body = parseBody(event);
  if (body === null) return respond(400, { error: "Invalid JSON body" });

  const size = body.size || "NA";
  const { quantity } = body;

  if (!Number.isInteger(quantity) || quantity < 1) {
    return respond(400, { error: "A positive integer quantity is required" });
  }

  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId, itemId: `CART#${productId}#${size}` },
        ConditionExpression: "attribute_exists(itemId)",
        UpdateExpression: "SET quantity = :quantity, updatedAt = :now",
        ExpressionAttributeValues: { ":quantity": quantity, ":now": now },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return respond(404, { error: "Cart item not found" });
    }
    throw err;
  }

  return respond(200, { productId, size, quantity });
}

// DELETE /cart/{productId}?size=10
async function removeCartItem(userId, productId, event) {
  const size = event.queryStringParameters?.size || "NA";
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { userId, itemId: `CART#${productId}#${size}` },
    })
  );
  return respond(200, { removed: productId, size });
}

// DELETE /cart — wipe the whole cart, used right after a successful order.
async function clearCart(userId) {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :u AND begins_with(itemId, :prefix)",
      ExpressionAttributeValues: { ":u": userId, ":prefix": "CART#" },
      ProjectionExpression: "itemId",
    })
  );

  if (Items.length === 0) return respond(200, { deleted: 0 });

  // BatchWriteItem caps at 25 requests per call
  const chunks = [];
  for (let i = 0; i < Items.length; i += 25) chunks.push(Items.slice(i, i + 25));

  for (const chunk of chunks) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: chunk.map((item) => ({
            DeleteRequest: { Key: { userId, itemId: item.itemId } },
          })),
        },
      })
    );
  }

  return respond(200, { deleted: Items.length });
}

// ---------- WISHLIST ----------

async function getWishlist(userId) {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :u AND begins_with(itemId, :prefix)",
      ExpressionAttributeValues: { ":u": userId, ":prefix": "WISHLIST#" },
    })
  );
  return respond(200, await enrichWithProducts(Items));
}

async function addWishlistItem(userId, event) {
  const body = parseBody(event);
  if (body === null) return respond(400, { error: "Invalid JSON body" });

  const { productId } = body;
  if (!productId) return respond(400, { error: "productId is required" });

  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId, itemId: `WISHLIST#${productId}` },
      UpdateExpression: "SET #type = :type, productId = :productId, addedAt = if_not_exists(addedAt, :now)",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: { ":type": "WISHLIST", ":productId": productId, ":now": now },
    })
  );

  return respond(200, { productId });
}

async function removeWishlistItem(userId, productId) {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { userId, itemId: `WISHLIST#${productId}` },
    })
  );
  return respond(200, { removed: productId });
}

// ---------- ROUTER ----------

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return respond(401, { error: "Unauthorized" });

    const routeKey = event.requestContext?.routeKey;
    const productId = event.pathParameters?.productId;

    switch (routeKey) {
      case "GET /cart":
        return await getCart(userId);
      case "POST /cart":
        return await addOrUpdateCartItem(userId, event);
      case "PUT /cart/{productId}":
        return await updateCartItem(userId, productId, event);
      case "DELETE /cart/{productId}":
        return await removeCartItem(userId, productId, event);
      case "DELETE /cart":
        return await clearCart(userId);
      case "GET /wishlist":
        return await getWishlist(userId);
      case "POST /wishlist":
        return await addWishlistItem(userId, event);
      case "DELETE /wishlist/{productId}":
        return await removeWishlistItem(userId, productId);
      default:
        return respond(404, { error: `No handler for route: ${routeKey}` });
    }
  } catch (err) {
    console.error("stridelux-cart-fn error:", err);
    return respond(500, { error: "Internal server error" });
  }
};