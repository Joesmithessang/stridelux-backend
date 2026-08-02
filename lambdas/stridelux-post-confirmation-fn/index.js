const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const cognito = new CognitoIdentityProviderClient({});

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE  = "stridelux-users";

exports.handler = async (event) => {
  const attrs   = event.request.userAttributes;
  const userId  = attrs.sub;
  const trigger = event.triggerSource;

  try {
    if (trigger === "PostConfirmation_ConfirmSignUp") {
      await client.send(new PutCommand({
        TableName: TABLE,
        Item: {
          userId,
          email:     attrs.email          || "",
          name:      attrs.name           || "",
          phone:     attrs.phone_number   || "",
          role:      attrs["custom:role"] || "customer",
          addresses: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status:    "active"
        },
        ConditionExpression: "attribute_not_exists(userId)"
      }));

      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        GroupName: "Customers"
      }));

    } else if (trigger === "PostAuthentication_Authentication") {
      // Fix: check if record exists first. If not, create a COMPLETE
      // record (with role) instead of letting UpdateCommand upsert
      // an incomplete one.
      const existing = await client.send(new GetCommand({
        TableName: TABLE,
        Key: { userId }
      }));

      if (!existing.Item) {
        // Record doesn't exist yet — create it fully
        await client.send(new PutCommand({
          TableName: TABLE,
          Item: {
            userId,
            email:     attrs.email          || "",
            name:      attrs.name           || "",
            phone:     attrs.phone_number   || "",
            role:      attrs["custom:role"] || "customer",
            addresses: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status:    "active"
          }
        }));
      } else {
        // Record exists — safe to just sync the changeable fields
        await client.send(new UpdateCommand({
          TableName: TABLE,
          Key: { userId },
          UpdateExpression:
            "SET #n = :name, phone = :phone, email = :email, updatedAt = :ts",
          ExpressionAttributeNames: { "#n": "name" },
          ExpressionAttributeValues: {
            ":name":  attrs.name         || "",
            ":phone": attrs.phone_number || "",
            ":email": attrs.email        || "",
            ":ts":    new Date().toISOString(),
          }
        }));
      }
    }
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`User ${userId} already exists — skipping creation`);
    } else {
      console.error(`Trigger error (${trigger}):`, err);
    }
  }

  return event;
};