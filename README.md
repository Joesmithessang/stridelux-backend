# StrideLux — Backend

Serverless backend for the [StrideLux](https://strideluxstore.com) e-commerce platform. Seven AWS Lambda functions (Node.js 22.x) exposed through Amazon API Gateway. Each function owns a single domain — no shared handlers, no monolithic function.

---

## Architecture

```
API Gateway (HTTP API)
├── /products    → stridelux-products-fn
├── /orders      → stridelux-orders-fn
├── /payments    → stridelux-payments-fn
├── /admin       → stridelux-admin-fn
├── /users       → stridelux-users-fn
├── /cart        → stridelux-cart-fn
└── /wishlist    → stridelux-cart-fn

Cognito JWT Authorizer — all routes except /payments
/payments — public endpoint with optional JWT decoding (guest checkout)

Cognito Post Confirmation trigger → stridelux-post-confirmation-fn
```

All authenticated routes require a valid Cognito JWT in `Authorization: Bearer <token>`. The API Gateway authorizer validates the token before the Lambda function is invoked — no auth logic in function code.

---

## Lambda Functions

| Function | Routes | Description |
|---|---|---|
| `stridelux-products-fn` | `GET /products`, `GET /products/{id}` (public); write operations (Admin) | Product catalogue CRUD |
| `stridelux-orders-fn` | `/orders` | Order lifecycle — creation, status updates, history. Sends SES emails on status change. |
| `stridelux-payments-fn` | `/payments/checkout-session`, `/payments/webhook`, `/payments/coupons/validate` | Stripe checkout session creation, webhook handling, coupon validation |
| `stridelux-admin-fn` | `/admin/**` | Dashboard stats, sales reports, employee management, coupon CRUD. Admins group only. |
| `stridelux-users-fn` | `/users/**` | Customer profile and address self-service |
| `stridelux-cart-fn` | `/cart`, `/wishlist` | Server-side cart and wishlist persistence |
| `stridelux-post-confirmation-fn` | Cognito trigger | Adds confirmed users to the Customers group; seeds DynamoDB profile record |

---

## Runtime Dependencies

The `nodejs22.x` runtime provides `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-cognito-identity-provider`, and `crypto` without bundling.

Only the following are bundled per function:

| Function | Bundled |
|---|---|
| `stridelux-payments-fn` | `stripe`, `@aws-sdk/client-sesv2` |
| `stridelux-orders-fn` | `@aws-sdk/client-sesv2` |
| `stridelux-admin-fn` | `@aws-sdk/client-sesv2` |
| All others | None |

**Zip structure:** `index.js` and `node_modules/` at archive root — not nested under a subdirectory. The deploy script enforces this.

---

## Lambda Environment Variables

Set directly on each function in AWS — not in source.

| Function | Variable | Description |
|---|---|---|
| `stridelux-admin-fn` | `COGNITO_USER_POOL_ID` | Cognito user pool ID |
| `stridelux-admin-fn` | `COGNITO_TEMP_PASSWORD` | Temporary password for admin-created users |
| `stridelux-admin-fn` | `FRONTEND_URL` | Application base URL |
| `stridelux-admin-fn` | `SES_FROM_ADDRESS` | Verified SES sender address |
| `stridelux-orders-fn` | `SES_FROM_ADDRESS` | Verified SES sender address |
| `stridelux-payments-fn` | `STRIPE_SECRET_KEY` | Stripe secret key (`sk_...`) |
| `stridelux-payments-fn` | `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `stridelux-payments-fn` | `FRONTEND_URL` | Stripe redirect URLs |
| `stridelux-payments-fn` | `SES_FROM_ADDRESS` | Verified SES sender address |

---

## Repository Structure

```
stridelux-backend/
├── lambdas/
│   ├── config.json                      # Function names and deploy targets
│   ├── stridelux-products-fn/
│   ├── stridelux-orders-fn/
│   ├── stridelux-payments-fn/           # Bundles stripe + @aws-sdk/client-sesv2
│   ├── stridelux-admin-fn/              # Bundles @aws-sdk/client-sesv2
│   ├── stridelux-users-fn/
│   ├── stridelux-cart-fn/
│   └── stridelux-post-confirmation-fn/
├── scripts/
│   ├── check-lambda-changes.js          # git diff change detection → GITHUB_OUTPUT
│   └── deploy-lambdas.js               # zip + aws lambda update-function-code
├── .github/workflows/ci-cd.yml
└── sonar-project.properties
```

---

## CI/CD Pipeline

```
Pull Request → main
  ├── Trivy — CVE, secret, misconfiguration scan (CRITICAL blocks pipeline)
  └── SonarCloud — static analysis, quality gate

Push → main
  ├── Trivy + SonarCloud
  └── Deploy Lambda Functions
        ├── Detect changed functions via git diff HEAD~1 (GITHUB_OUTPUT: lambda_changes)
        ├── npm ci --production per changed function
        ├── Zip at archive root
        └── aws lambda update-function-code
```

Change detection writes a `lambda_changes=true|false` step output. Unchanged functions are never redeployed.

### Required Secrets

| Secret | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM user with `lambda:UpdateFunctionCode` |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret key |
| `AWS_REGION` | Deployment region |
| `SONAR_TOKEN` | SonarCloud analysis token |

### SonarQube Community Edition

The workflow includes a dormant SonarQube block. To activate: add `SONAR_HOST_URL` to repo secrets, comment out the SonarCloud step, uncomment the SonarQube step.

---

## Security Controls

| Control | Implementation |
|---|---|
| CVE scanning | Trivy — blocks on CRITICAL unfixed findings |
| Secret scanning | Trivy secret scanner on every push |
| Static analysis | SonarCloud — OWASP Top 10 and javascript:S2068 rules |
| Authentication | Cognito JWT validated by API Gateway before Lambda invocation |
| Authorisation | Cognito group membership (`Admins`, `Customers`) checked in handler |
| Credential storage | All secrets in Lambda environment variables in AWS — never in source |
| SES permissions | `ses:SendEmail` scoped to domain identity and from-address ARNs |
| IAM least privilege | Dedicated execution role per function, scoped to specific DynamoDB tables |

---

## Related Repositories

| Repository | Description |
|---|---|
| [stridelux-frontend](https://github.com/Joesmithessang/stridelux-frontend) | React SPA — S3 + CloudFront |
| [stridelux-infra](https://github.com/Joesmithessang/stridelux-infra) | Terraform IaC — all AWS resource definitions |
