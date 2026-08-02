const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE  = "stridelux-products";

exports.handler = async (event) => {
  const method     = event.requestContext?.http?.method || event.httpMethod;
  const pathParams = event.pathParameters || {};
  const qs         = event.queryStringParameters || {};
  const body       = event.body ? JSON.parse(event.body) : {};
  const claims     = event.requestContext?.authorizer?.jwt?.claims || {};

  // Fix 2: handle groups as array or string
  const rawGroups = claims["cognito:groups"];
  const groups = Array.isArray(rawGroups)
    ? rawGroups
    : typeof rawGroups === "string"
      ? rawGroups
          .replace(/^\[|\]$/g, "")  // strip leading [ and trailing ]
          .split(",")
          .map(g => g.trim())
          .filter(Boolean)
      : [];
  const isAdmin = groups.includes("Admins");

  // Fix 1: treat "All" as no filter
  const effectiveCategory = qs.category && qs.category !== 'All' ? qs.category : null;
  const effectiveBrand    = qs.brand && qs.brand !== 'All' ? qs.brand : null;
  const search            = qs.search || null;

  try {
    // GET /products — public list with optional filters
    if (method === "GET" && !pathParams.id) {

      // Only filter inStock when explicitly requested
      // Shop passes inStock=true, Admin passes nothing
      const filterInStock = qs.inStock === 'true';

      const effectiveCategory = qs.category && qs.category !== 'All' 
        ? qs.category : null;
      const effectiveBrand = qs.brand && qs.brand !== 'All' 
        ? qs.brand : null;
      const search = qs.search || null;

      if (effectiveCategory) {
        const params = {
          TableName: TABLE,
          IndexName: "category-index",
          KeyConditionExpression: "category = :cat",
          ExpressionAttributeValues: { ":cat": effectiveCategory }
        };
        if (filterInStock) {
          params.FilterExpression = "inStock = :true";
          params.ExpressionAttributeValues[":true"] = true;
        }
        const result = await client.send(new QueryCommand(params));
        return ok(normalizeItems(result.Items));
      }

      if (effectiveBrand) {
        const params = {
          TableName: TABLE,
          IndexName: "brand-index",
          KeyConditionExpression: "brand = :brand",
          ExpressionAttributeValues: { ":brand": effectiveBrand }
        };
        if (filterInStock) {
          params.FilterExpression = "inStock = :true";
          params.ExpressionAttributeValues[":true"] = true;
        }
        const result = await client.send(new QueryCommand(params));
        return ok(normalizeItems(result.Items));
      }

      // Full scan
      const params = { TableName: TABLE };
      if (filterInStock) {
        params.FilterExpression = "inStock = :true";
        params.ExpressionAttributeValues = { ":true": true };
      }
      const result = await client.send(new ScanCommand(params));
      let items = result.Items || [];

      if (search) {
        const q = search.toLowerCase();
        items = items.filter(p =>
          p.name?.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          (Array.isArray(p.tags) && p.tags.some(t => t.toLowerCase().includes(q)))
        );
      }

      return ok(normalizeItems(items));
    }

    // GET /products/:id — public single product
    if (method === "GET" && pathParams.id) {
      const result = await client.send(new GetCommand({
        TableName: TABLE,
        Key: { productId: pathParams.id }
      }));
      if (!result.Item) return notFound("Product not found");
      return ok(normalizeItem(result.Item));
    }

    // POST /products — admin only
    if (method === "POST") {
      if (!isAdmin) return forbidden();
      const item = {
        ...body,
        productId: randomUUID(),
        inStock: body.stockCount > 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await client.send(new PutCommand({ TableName: TABLE, Item: item }));
      return created(normalizeItem(item));
    }

    // PUT /products/:id — admin only
    if (method === "PUT" && pathParams.id) {
      if (!isAdmin) return forbidden();
      const updates   = { ...body, updatedAt: new Date().toISOString() };
      delete updates.productId; // never overwrite the key
      const setExprs  = Object.keys(updates).map(k => `#${k} = :${k}`);
      const exprNames = Object.fromEntries(Object.keys(updates).map(k => [`#${k}`, k]));
      const exprVals  = Object.fromEntries(Object.keys(updates).map(k => [`:${k}`, updates[k]]));

      const result = await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { productId: pathParams.id },
        UpdateExpression: `SET ${setExprs.join(", ")}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprVals,
        ReturnValues: "ALL_NEW"
      }));
      return ok(normalizeItem(result.Attributes));
    }

    // DELETE /products/:id — admin only
    if (method === "DELETE" && pathParams.id) {
      if (!isAdmin) return forbidden();
      await client.send(new DeleteCommand({
        TableName: TABLE,
        Key: { productId: pathParams.id }
      }));
      return ok({ message: "Product deleted" });
    }

    return notFound("Route not found");

  } catch (err) {
    console.error(err);
    return error(err.message);
  }
};

// Fix 4: add id alias so frontend p.id works alongside p.productId
function normalizeItem(item) {
  if (!item) return item;
  return { ...item, id: item.productId };
}

function normalizeItems(items) {
  return (items || []).map(normalizeItem);
}

const ok       = b => response(200, b);
const created  = b => response(201, b);
const notFound = m => response(404, { message: m });
const forbidden = () => response(403, { message: "Forbidden" });
const error    = m => response(500, { message: m });

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