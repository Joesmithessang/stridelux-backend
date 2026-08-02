const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE  = "stridelux-users";

exports.handler = async (event) => {
  const method     = event.requestContext?.http?.method || event.httpMethod;
  const claims     = event.requestContext?.authorizer?.jwt?.claims || {};
  const userId     = claims.sub;
  const body       = event.body ? JSON.parse(event.body) : {};
  const path       = event.rawPath || "";
  const pathParams = event.pathParameters || {};

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
  const isAdmin = groups.includes("Admins");

  console.log("userId:", userId, "isAdmin:", isAdmin, "path:", path, "method:", method);

  if (!userId) return forbidden();

  try {

    // GET /users/me
    if (method === "GET" && !path.includes("addresses")) {
      const result = await client.send(new GetCommand({
        TableName: TABLE,
        Key: { userId }
      }));
      if (!result.Item) return notFound("User not found");
      return ok(result.Item);
    }

    // PUT /users/me
    if (method === "PUT" && !path.includes("addresses")) {
      const allowed = ["name", "phone"];
      const updates = Object.fromEntries(
        Object.entries(body).filter(([k]) => allowed.includes(k))
      );
      updates.updatedAt = new Date().toISOString();

      const setExprs  = Object.keys(updates).map(k => `#${k} = :${k}`);
      const exprNames = Object.fromEntries(
        Object.keys(updates).map(k => [`#${k}`, k])
      );
      const exprVals = Object.fromEntries(
        Object.keys(updates).map(k => [`:${k}`, updates[k]])
      );

      const result = await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression: `SET ${setExprs.join(", ")}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprVals,
        ReturnValues: "ALL_NEW"
      }));
      return ok(result.Attributes);
    }

    // GET /users/me/addresses
    if (method === "GET" && path.includes("addresses")) {
      const result = await client.send(new GetCommand({
        TableName: TABLE,
        Key: { userId }
      }));
      if (!result.Item) return ok([]);
      const addresses = Array.isArray(result.Item.addresses)
        ? result.Item.addresses.reverse()
        : [];
      return ok(addresses);
    }

    // POST /users/me/addresses
    if (method === "POST" && path.includes("addresses") && !pathParams.addressId) {
      const existing = await client.send(new GetCommand({
        TableName: TABLE,
        Key: { userId }
      }));
    
      if (!existing.Item) return notFound("User profile not found");
    
      const addresses = Array.isArray(existing.Item.addresses)
        ? existing.Item.addresses
        : [];
    
      const street     = body.street     || body.address  || "";
      const postalCode = body.postalCode                  || "";
      const city       = body.city                        || "";
      const state      = body.state      || body.province || "";
      const country    = body.country                     || "Canada";
      const fullName   = body.fullName                    || "";
      const phone      = body.phone                       || "";
    
      // Deduplicate by street + postalCode
      const isDuplicate = addresses.some(a =>
        a.street?.toLowerCase()     === street.toLowerCase() &&
        a.postalCode?.toLowerCase() === postalCode.toLowerCase()
      );
    
      if (isDuplicate) return ok([...addresses].reverse());
    
      // Cap at 5 addresses
      if (addresses.length >= 5) return ok([...addresses].reverse());
    
      const isDefault = body.isDefault || addresses.length === 0;
      if (isDefault) {
        addresses.forEach(a => { a.isDefault = false; });
      }
    
      addresses.push({
        addressId:  randomUUID(),
        fullName,
        address:    street,    // ← what frontend expects to read back
        street,                // ← keep for internal Lambda normalisation,
        city,
        state,
        postalCode,
        country,
        phone,
        isDefault,
        createdAt: new Date().toISOString()
      });
    
      await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression: "SET addresses = :addrs, updatedAt = :ts",
        ExpressionAttributeValues: {
          ":addrs": addresses,
          ":ts":    new Date().toISOString()
        }
      }));
    
      // Return reversed (newest first) to match GET behavior
      return ok([...addresses].reverse());
    }

    // PUT /users/me/addresses/:addressId
    if (method === "PUT" && path.includes("addresses") && pathParams.addressId) {
      const existing = await client.send(new GetCommand({
        TableName: TABLE,
        Key: { userId }
      }));

      if (!existing.Item) return notFound("User not found");

      const addresses = Array.isArray(existing.Item.addresses)
        ? existing.Item.addresses
        : [];

      const index = addresses.findIndex(
        a => a.addressId === pathParams.addressId
      );

      if (index === -1) return notFound("Address not found");

      // Update the matching address object in the list
      addresses[index] = {
        ...addresses[index],
        fullName:   body.fullName   || addresses[index].fullName,
        // Use 'street' as the field name internally — avoids 'address' reserved word
        // Frontend sends either 'address' or 'street' — normalise to 'street' here
        address:    body.address    || body.street || addresses[index].address || addresses[index].street,
        street:     body.street     || body.address || addresses[index].street,
        city:       body.city       || addresses[index].city,
        state:      body.state      || body.province || addresses[index].state,
        postalCode: body.postalCode || addresses[index].postalCode,
        country:    body.country    || addresses[index].country,
        phone:      body.phone      || addresses[index].phone,
        updatedAt:  new Date().toISOString()
      };

      // Write the whole list back — no UpdateExpression field name issues
      // because we're writing to the 'addresses' attribute (not reserved)
      // and the address objects inside are stored as a Map, not bare attributes
      await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression: "SET addresses = :addrs, updatedAt = :ts",
        ExpressionAttributeValues: {
          ":addrs": addresses,
          ":ts":    new Date().toISOString()
        }
      }));

      return ok([...addresses].reverse());
    }

    // DELETE /users/me/addresses/:addressId
    if (method === "DELETE" && path.includes("addresses") && pathParams.addressId) {
      const existing = await client.send(new GetCommand({
        TableName: TABLE,
        Key: { userId }
      }));

      const addresses = Array.isArray(existing.Item?.addresses)
        ? existing.Item.addresses.filter(a => a.addressId !== pathParams.addressId)
        : [];

      const hasDefault = addresses.some(a => a.isDefault);
      if (!hasDefault && addresses.length > 0) {
        addresses[0].isDefault = true;
      }

      await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression: "SET addresses = :addrs, updatedAt = :ts",
        ExpressionAttributeValues: {
          ":addrs": addresses,
          ":ts":    new Date().toISOString()
        }
      }));

      return ok(addresses);
    }

    return notFound("Route not found");

  } catch (err) {
    console.error("Users Lambda error:", err);
    return error(err.message);
  }
};

const ok        = b => response(200, b);
const notFound  = m => response(404, { message: m });
const forbidden = () => response(403, { message: "Forbidden" });
const error     = m => response(500, { message: m });

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