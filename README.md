# StrideLux Backend

Serverless backend for the [StrideLux](https://strideluxstore.com) e-commerce platform. Built with AWS Lambda (Node.js 22.x) and exposed via API Gateway. Each function is independently deployable and scoped to a single domain.

---

## Architecture

```
API Gateway (HTTP API)
├── /products          → stridelux-products-fn
├── /orders            → stridelux-orders-fn
├── /payments          → stridelux-payments-fn
├── /admin             → stridelux-admin-fn
├── /users             → stridelux-users-fn
├── /cart              → stridelux-cart-fn
└── /wishlist          → stridelux-cart-fn
```

Cognito JWT authorizer protects all authenticated routes. The payments function is public (guest checkout support) and decodes the JWT manually when present.

---

## Lambda Functions

| Function | Description |
|---|---|
| `stridelux-products-fn` | Product catalog CRUD. Public GET, admin-only write. |
| `stridelux-orders-fn` | Order lifecycle for customers and admins. Sends status emails via SES. |
| `stridelux-payments-fn` | Stripe checkout session creation, webhook handler, coupon validation. |
| `stridelux-admin-fn` | Dashboard stats, reports, user management, employee management, coupon CRUD. |
| `stridelux-users-fn` | Customer profile and address self-service. |
| `stridelux-cart-fn` | Cart and wishlist persistence. |
| `stridelux-post-confirmation-fn` | Cognito Post Confirmation and Post Authentication trigger. |

---

## Bundled Dependencies

The nodejs22.x runtime provides `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-cognito-identity-provider`, and `crypto` out of the box.

Only the following are bundled per function:

| Function | Bundled |
|---|---|
| `stridelux-payments-fn` | `stripe`, `@aws-sdk/client-sesv2` |
| `stridelux-orders-fn` | `@aws-sdk/client-sesv2` |
| `stridelux-admin-fn` | `@aws-sdk/client-sesv2` |
| All others | None |

---

## CI/CD Pipeline

Defined in [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml).

| Job | Trigger | Description |
|---|---|---|
| `security-scan` | Every push and PR | Trivy scans for CVEs, secrets, and misconfigs. CRITICAL findings block deployment. |
| `code-quality` | Every push and PR | SonarCloud static analysis. SonarQube Community Edition block is included and ready to activate. |
| `deploy-lambdas` | Push to `main` only | Detects which functions changed, runs `npm ci --production`, zips, and deploys via AWS CLI. |

### Switching from SonarCloud to SonarQube Community Edition

When your self-hosted SonarQube server is ready:
1. Add `SONAR_HOST_URL` to repo secrets (e.g. `http://your-ec2-ip:9000`)
2. Generate a `SONAR_TOKEN` from the SonarQube server
3. In `.github/workflows/ci-cd.yml`, comment out the SonarCloud step and uncomment the SonarQube step

---

## Required GitHub Secrets

| Secret | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM user with Lambda update permissions |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret key |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |
| `SONAR_TOKEN` | From sonarcloud.io (or SonarQube server when self-hosted) |

---

## Related Repositories

| Repo | Description |
|---|---|
| [stridelux-frontend](https://github.com/Joesmithessang/stridelux-frontend) | React storefront — S3 + CloudFront |
| [stridelux-infra](https://github.com/Joesmithessang/stridelux-infra) | Terraform IaC for all AWS resources |
